import { open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openAppServer } from './app-server-client.mjs';
import { cleanupPath, lastTurn } from './fork-snapshot.mjs';
import { processAlive, readState, reapDeadLock, record, withState } from './state.mjs';

// An omitted source filter only lists interactive tasks. Deletion cascades to
// spawned descendants of every source, including those already archived.
export const CLEANUP_SOURCE_KINDS = Object.freeze([
  'cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
  'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown',
]);

export async function cleanSnapshot(client, job) {
  const snapshot = job.snapshot;
  if (job.purpose !== 'modeltrace-temporary-base' || !snapshot?.sourceSession || snapshot.id === snapshot.sourceSession) throw new Error('Invalid temporary fork ownership');
  let thread;
  try { ({ thread } = await client.request('thread/read', { threadId: snapshot.id, includeTurns: false })); }
  catch (error) { if (/no rollout found|thread not found|not found for thread/i.test(error.message)) return { status: 'deleted', alreadyAbsent: true }; throw error; }
  if (thread.id !== snapshot.id || thread.forkedFromId !== snapshot.sourceSession || thread.ephemeral || thread.path !== snapshot.path) throw new Error('Temporary fork ownership changed; nothing deleted');
  const turn = await lastTurn(client, snapshot.id);
  if (!snapshot.sourceTurn || turn?.id !== snapshot.sourceTurn || turn.status === 'inProgress') throw new Error('Temporary base was used or its boundary is unknown; preserving it for user review');
  for (const archived of [false, true]) {
    const descendants = await client.request('thread/list', {
      ancestorThreadId: snapshot.id, limit: 1, archived,
      sourceKinds: [...CLEANUP_SOURCE_KINDS], modelProviders: [], useStateDbOnly: true,
    });
    if (!Array.isArray(descendants?.data)) throw new Error('Cannot verify temporary base descendants; nothing deleted');
    if (descendants.data.length || descendants.nextCursor) throw new Error('Temporary base has persisted descendants; preserving them for user review');
  }
  const latest = await lastTurn(client, snapshot.id);
  if (latest?.id !== snapshot.sourceTurn || latest.status === 'inProgress') throw new Error('Temporary base changed during cleanup checks; nothing deleted');
  await client.request('thread/delete', { threadId: snapshot.id }, 45000);
  return { status: 'deleted', deletedAt: Date.now() };
}

export async function cleanupPending(directory, env = process.env, { retryBlocked = false } = {}) {
  const folder = path.join(path.resolve(directory), '_fork_cleanup');
  const entries = await readdir(folder).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
  let client; const results = [];
  try {
    for (const name of entries) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const filename = cleanupPath(directory, name.slice(0, -5));
      let job;
      try { job = JSON.parse(await readFile(filename, 'utf8')); } catch { continue; }
      if (job.snapshot?.id !== name.slice(0, -5)) continue;
      if (job.status === 'deleted' || (job.status === 'blocked' && !retryBlocked)) continue;
      if (job.status === 'active' && processAlive(job.ownerPid)) continue;
      if (job.status === 'active') {
        const state = await readState(directory, job.snapshot.sourceSession);
        if (state?.forkSnapshot?.id === job.snapshot.id && state.probeRun && processAlive(state.probeRun.pid)) continue;
        if (state?.forkSnapshot?.id === job.snapshot.id && state.enabled && state.confirmation?.status === 'active'
          && Date.now() < (state.confirmation.startedAt + Math.max(600000, (state.confirmation.target + 1) * state.config.pendingSeconds * 1000))) continue;
      }
      const lease = `${filename}.lock`; let lock;
      for (let attempt = 0; attempt < 2 && !lock; attempt++) {
        try { lock = await open(lease, 'wx', 0o600); }
        catch (error) { if (error.code !== 'EEXIST' || !await reapDeadLock(lease)) break; }
      }
      if (!lock) continue;
      try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, nonce: randomUUID(), at: Date.now() })); await lock.sync();
        client ||= await openAppServer(env);
        let result;
        try { result = await cleanSnapshot(client, job); }
        catch (error) { result = { status: 'blocked', error: error.message, checkedAt: Date.now() }; }
        const next = { ...job, ...result }, temporary = `${filename}.${process.pid}.tmp`;
        const file = await open(temporary, 'w', 0o600);
        try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
        await rename(temporary, filename); results.push({ id: job.snapshot.id, ...result });
        if (await readState(directory, job.snapshot.sourceSession)) {
          await withState(directory, job.snapshot.sourceSession, (state) => {
            state.forkCleanup = { id: job.snapshot.id, ...result };
            record(state, `fork_cleanup_${result.status}`, Date.now(), { snapshot: job.snapshot.id, ...result });
          });
          if (result.status === 'deleted') await unlink(filename);
        }
      } finally { await lock.close(); await unlink(lease); }
    }
  } finally { await client?.close(); }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await cleanupPending(process.argv[2], process.env, { retryBlocked: process.argv[3] === '--retry-blocked' }).catch(() => { process.exitCode = 1; });
}
