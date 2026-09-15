import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const queuedDirectories = new Set();
export const requestCleanupSweep = (directory) => queuedDirectories.add(path.resolve(directory));
export function cleanupPath(directory, id) {
  if (!UUID.test(id)) throw new Error('Invalid temporary fork ID');
  return path.join(path.resolve(directory), '_fork_cleanup', `${id}.json`);
}

export async function sourceSettings(client, session) {
  const { thread } = await client.request('thread/read', { threadId: session, includeTurns: false });
  if (!thread || thread.id !== session) throw new Error('Codex returned metadata for a different source task');
  if (thread.ephemeral || typeof thread.path !== 'string' || !path.isAbsolute(thread.path)) throw new Error('Source task has no persisted Codex history to fork');
  const nonempty = (value) => typeof value === 'string' && Boolean(value.trim());
  // thread/read exposes current/persisted task settings without returning turns.
  // Never open the rollout or substitute config/read's global/project defaults.
  if (!nonempty(thread.model) || !nonempty(thread.modelProvider)
    || !Object.hasOwn(thread, 'reasoningEffort') || (thread.reasoningEffort !== null && !nonempty(thread.reasoningEffort))
    || typeof thread.cwd !== 'string' || !path.isAbsolute(thread.cwd)) {
    throw new Error('Codex source task metadata lacks model/provider/reasoning/workspace settings; no history scan or default-model fallback');
  }
  // Reuse this summary read for the real task title; do not read a transcript
  // or infer the title from the shared workspace name.
  const sourceTaskName = typeof thread.name === 'string' && thread.name.trim().length <= 120 && !/[\x00-\x1f\x7f]/.test(thread.name) ? thread.name.trim() : null;
  return { model: thread.model, provider: thread.modelProvider, effort: thread.reasoningEffort, cwd: thread.cwd,
    ...(UUID.test(thread.sessionId || '') ? { cacheSessionId: thread.sessionId } : {}),
    ...(sourceTaskName ? { sourceTaskName } : {}) };
}

export async function lastTurn(client, id) {
  const response = await client.request('thread/turns/list', { threadId: id, limit: 1, itemsView: 'notLoaded', sortDirection: 'desc' });
  return response.data[0] || null;
}

// The native fork preserves the effective context, including compaction.
// This digest identifies its ordered turn boundaries, not its message bodies:
// even one full turn can exceed V8's string limit, so smaller full pages do not suffice.
export async function snapshotBoundaries(client, id, sourceTurn) {
  const hash = createHash('sha256').update('modeltrace-turn-boundaries-v1\n');
  const cursors = new Set(); let cursor, lastId, count = 0;
  do {
    const page = await client.request('thread/turns/list', { threadId: id, limit: 50, itemsView: 'notLoaded', sortDirection: 'asc', ...(cursor ? { cursor } : {}) }, 30000);
    if (!Array.isArray(page.data)) throw new Error('Codex snapshot turn metadata is unavailable');
    for (const turn of page.data) {
      if (typeof turn.id !== 'string' || !turn.id || !['completed', 'interrupted', 'failed'].includes(turn.status)) throw new Error('Codex snapshot has an invalid or unfinished turn boundary');
      hash.update(JSON.stringify([turn.id, turn.status]) + '\n');
      lastId = turn.id; count++;
    }
    cursor = page.nextCursor;
    if (cursor) {
      if (typeof cursor !== 'string' || !page.data.length || cursors.has(cursor)) throw new Error('Codex snapshot turn pagination did not advance');
      cursors.add(cursor);
    }
  } while (cursor);
  if (!count || lastId !== sourceTurn) throw new Error('Codex snapshot boundary changed while reading turn metadata');
  return { sha256: hash.digest('hex'), sha256Scope: 'turn_boundaries_v1', turnCount: count };
}

// Paginated histories reject copied rollout paths. Freeze using a native,
// persisted fork which is NEVER given a model turn; all probes fork from it.
export async function freezeSnapshot(client, session, directory) {
  const settings = await sourceSettings(client, session);
  const response = await client.request('thread/fork', {
    threadId: session, excludeTurns: true, deferGoalContinuation: true,
    model: settings.model, modelProvider: settings.provider, cwd: settings.cwd,
    ...(settings.effort ? { config: { model_reasoning_effort: settings.effort } } : {}),
  }, 30000);
  const base = response.thread;
  if (!base?.id || base.id === session || base.forkedFromId !== session || base.ephemeral) throw new Error('Codex did not create an owned persistent snapshot fork');
  const snapshot = { id: base.id, sourceSession: session, path: base.path, capturedAt: Date.now(), boundary: 'codex_persisted_fork', ...settings };
  await saveOwnership(directory, snapshot, 'active');
  try {
    const turn = await lastTurn(client, base.id);
    if (!turn || typeof turn.id !== 'string' || !turn.id || !['completed', 'interrupted', 'failed'].includes(turn.status)) throw new Error('Codex snapshot has no fixed completed/interrupted turn boundary');
    snapshot.sourceTurn = turn.id;
    // Persist deletion evidence before any further request. A terminated
    // worker must not leave a safely owned base with an unknown boundary.
    await saveOwnership(directory, snapshot, 'active');
    Object.assign(snapshot, await snapshotBoundaries(client, base.id, snapshot.sourceTurn));
    await saveOwnership(directory, snapshot, 'active');
    return snapshot;
  } catch (error) { await removeSnapshot(directory, snapshot); throw error; }
}

export async function verifySnapshot(client, snapshot) {
  const { thread } = await client.request('thread/read', { threadId: snapshot.id, includeTurns: false });
  const turn = await lastTurn(client, snapshot.id);
  if (thread.forkedFromId !== snapshot.sourceSession || thread.id === snapshot.sourceSession || thread.ephemeral || thread.path !== snapshot.path
    || turn?.id !== snapshot.sourceTurn || turn.status === 'inProgress') throw new Error('Frozen Codex snapshot changed or is unavailable; refusing to fork a different context');
}

async function saveOwnership(directory, snapshot, status) {
  const filename = cleanupPath(directory, snapshot.id);
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify({ purpose: 'modeltrace-temporary-base', status, ownerPid: process.pid, snapshot })); await file.sync(); }
  finally { await file.close(); }
  try { await rename(temporary, filename); } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function removeSnapshot(directory, snapshot) {
  if (!snapshot) return;
  if (!snapshot.sourceSession || snapshot.id === snapshot.sourceSession) throw new Error('Refusing cleanup of a source task');
  await saveOwnership(directory, snapshot, 'pending');
  requestCleanupSweep(directory);
}

// Only the CLI entry point dispatches helpers. Library calls and unit fixtures
// can queue and inspect cleanup without ever connecting to a real Codex account.
export function dispatchQueuedCleanups() {
  const worker = fileURLToPath(new URL('./fork-cleanup.mjs', import.meta.url));
  for (const directory of queuedDirectories) {
    const child = spawn(process.execPath, [worker, directory], { detached: true, windowsHide: true, stdio: 'ignore' });
    child.on('error', () => {}); child.unref();
  }
  queuedDirectories.clear();
}

export function publicSnapshot(snapshot) {
  if (!snapshot) return null;
  const { id, sha256, sha256Scope, turnCount, capturedAt, boundary, sourceTurn } = snapshot;
  return { id, sha256, sha256Scope, turnCount, capturedAt, boundary, sourceTurn };
}
