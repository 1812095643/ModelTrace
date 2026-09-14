import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';

const LIMITS = { samples: 128, events: 256, alerts: 128 };
const sha = (text) => createHash('sha256').update(text).digest('hex');
export function historyCount(state, kind) {
  return (state.history?.[kind]?.count || 0) + (state[kind]?.length || 0);
}

// Immutable, content-addressed chunks are written and fsynced BEFORE the small
// state pointer commits. A crash can leave an unreferenced chunk, never erase or
// double-count committed evidence. State readers only follow committed pointers.
export async function compactHistory(state, directory) {
  for (const [kind, limit] of Object.entries(LIMITS)) {
    const rows = state[kind] || [];
    if (rows.length <= limit * 2) continue;
    let eligible = rows.length - limit;
    if (kind === 'alerts') {
      const pendingIndex = rows.findIndex((row) => !row.acknowledgedAt);
      if (pendingIndex >= 0) eligible = Math.min(eligible, pendingIndex);
    }
    if (eligible < limit) continue;
    state.history ||= {};
    const index = state.history[kind] ||= { count: 0, chunks: [] };
    const folder = path.join(directory, '_history', sha(state.session));
    await mkdir(folder, { recursive: true, mode: 0o700 });
    let consumed = 0;
    while (eligible - consumed >= limit) {
      const chunk = rows.slice(consumed, consumed + limit), bytes = JSON.stringify(chunk) + '\n';
      const hash = sha(bytes), file = path.join(folder, `${kind}-${hash}.json`);
      let handle;
      try { handle = await open(file, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (sha(await readFile(file)) !== hash) throw new Error('History chunk checksum mismatch; evidence was not reset');
      } finally { await handle?.close(); }
      index.chunks.push({ hash, count: chunk.length }); index.count += chunk.length;
      if (kind === 'samples') index.differenceSignals = (index.differenceSignals || 0) + chunk.filter((r) => ['difference_signal', 'repeated_difference'].includes(r.outcome)).length;
      consumed += chunk.length;
    }
    state[kind] = rows.slice(consumed);
  }
  state.schema = 2;
}

// before is an exclusive absolute row index. Appending new rows never shifts an
// older page's cursor. Read just the overlapping immutable chunks, newest first.
export async function historyPage(directory, state, kind, { before, limit = 100 } = {}) {
  if (!Object.hasOwn(LIMITS, kind) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid history page');
  const total = historyCount(state, kind), end = before === undefined ? total : Number(before);
  if (!Number.isSafeInteger(end) || end < 0 || end > total) throw new Error('Invalid history cursor');
  const start = Math.max(0, end - limit), index = state.history?.[kind], segments = [];
  let offset = 0;
  for (const chunk of index?.chunks || []) {
    if (!/^[a-f0-9]{64}$/.test(chunk.hash) || !Number.isSafeInteger(chunk.count) || chunk.count < 1) throw new Error('Invalid history index');
    if (offset < end && offset + chunk.count > start) segments.push({ ...chunk, offset });
    offset += chunk.count;
  }
  if (offset !== (index?.count || 0)) throw new Error('Invalid history count');
  const result = [];
  for (const chunk of segments) {
    const bytes = await readFile(path.join(directory, '_history', sha(state.session), `${kind}-${chunk.hash}.json`));
    if (sha(bytes) !== chunk.hash) throw new Error('History checksum mismatch');
    const rows = JSON.parse(bytes);
    if (rows.length !== chunk.count) throw new Error('History count mismatch');
    result.push(...rows.slice(Math.max(0, start - chunk.offset), end - chunk.offset));
  }
  if (offset < end) result.push(...(state[kind] || []).slice(Math.max(0, start - offset), end - offset));
  return { rows: result.reverse(), nextBefore: start || null, total };
}
