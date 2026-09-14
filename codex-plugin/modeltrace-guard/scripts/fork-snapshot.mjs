import { createReadStream } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
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

async function sourceSettings(client, session) {
  const { thread } = await client.request('thread/read', { threadId: session });
  if (!thread.path || !path.isAbsolute(thread.path)) throw new Error('Source task has no persisted Codex history to fork');
  let metadata, context;
  for await (const line of createInterface({ input: createReadStream(thread.path), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; } // concurrent final JSONL write may be incomplete
    if (event.type === 'session_meta') metadata ||= event.payload;
    if (event.type === 'turn_context') context = event.payload;
  }
  if (!metadata || (metadata.id !== session && metadata.session_id !== session) || !context?.model || !metadata.model_provider) throw new Error('Source history lacks matching model/provider metadata; refusing default-model fallback');
  return { model: context.model, provider: metadata.model_provider, effort: context.effort ?? context.reasoning_effort ?? null, cwd: context.cwd || metadata.cwd };
}

export async function lastTurn(client, id) {
  const response = await client.request('thread/turns/list', { threadId: id, limit: 1, itemsView: 'notLoaded', sortDirection: 'desc' });
  return response.data[0] || null;
}

// Paginated histories reject copied rollout paths. Freeze using a native,
// persisted fork which is NEVER given a model turn; all probes fork from it.
export async function freezeSnapshot(client, session, directory) {
  const settings = await sourceSettings(client, session);
  const response = await client.request('thread/fork', {
    threadId: session, excludeTurns: true, deferGoalContinuation: true,
    model: settings.model, modelProvider: settings.provider,
    ...(settings.effort ? { config: { model_reasoning_effort: settings.effort } } : {}),
  }, 30000);
  const base = response.thread;
  if (!base?.id || base.id === session || base.forkedFromId !== session || base.ephemeral) throw new Error('Codex did not create an owned persistent snapshot fork');
  const snapshot = { id: base.id, sourceSession: session, path: base.path, capturedAt: Date.now(), boundary: 'codex_persisted_fork', ...settings };
  await saveOwnership(directory, snapshot, 'active');
  try {
    const turn = await lastTurn(client, base.id);
    if (!turn || turn.status === 'inProgress') throw new Error('Codex snapshot has no fixed completed/interrupted turn boundary');
    snapshot.sourceTurn = turn.id;
    const hash = createHash('sha256'); let cursor;
    do {
      const page = await client.request('thread/turns/list', { threadId: base.id, limit: 50, itemsView: 'full', sortDirection: 'asc', ...(cursor ? { cursor } : {}) }, 30000);
      for (const item of page.data) hash.update(JSON.stringify(item) + '\n');
      cursor = page.nextCursor;
    } while (cursor);
    snapshot.sha256 = hash.digest('hex');
    await saveOwnership(directory, snapshot, 'active');
    return snapshot;
  } catch (error) { await removeSnapshot(directory, snapshot); throw error; }
}

export async function verifySnapshot(client, snapshot) {
  const { thread } = await client.request('thread/read', { threadId: snapshot.id });
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
  const { id, sha256, capturedAt, boundary, sourceTurn } = snapshot;
  return { id, sha256, capturedAt, boundary, sourceTurn };
}
