import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT, handleHook, isControlCommand, run } from '../scripts/guard.mjs';
import { newState, readState, sessionPath, withState } from '../scripts/state.mjs';
import { historyCount, historyPage } from '../scripts/history.mjs';
import { summarize } from '../scripts/status.mjs';
import { evaluateCalibration } from '../scripts/evaluate-calibration.mjs';
import { createDashboard } from '../scripts/dashboard-server.mjs';
import { digest } from '../scripts/state.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'modeltrace-hardening-test-'));
  t.after(async () => { assert.equal(path.dirname(dir), path.resolve(tmpdir())); assert.ok(path.basename(dir).startsWith('modeltrace-hardening-test-')); await rm(dir, { recursive: true, force: true }); });
  return dir;
}

test('halt blocks work tools including misleading command substrings, preserving direct control access', async (t) => {
  const dir = await fixture(t), session = 'halt-fixture';
  await withState(dir, session, (s) => { s.taskHalt = { id: 'halt', expected: 'x', retryCount: 3 }; });
  const cmd = `node '${path.join(ROOT, 'scripts', 'guard.mjs')}' status`;
  for (const event of [
    { tool_name: 'apply_patch', tool_input: { command: 'patch' } },
    { tool_name: 'mcp__write', tool_input: {} },
    { tool_name: 'Bash', tool_input: { command: 'echo "guard.mjs status"; execute-work' } },
    { tool_name: 'Bash', tool_input: { command: cmd + '; execute-work' } },
    { tool_name: 'Bash', tool_input: { command: `node 'different/guard.mjs' status` } },
  ]) {
    const result = await handleHook({ session_id: session, hook_event_name: 'PreToolUse', ...event }, dir);
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  }
  assert.equal(isControlCommand({ tool_name: 'Bash', tool_input: { command: cmd } }), true);
  assert.deepEqual(await handleHook({ session_id: session, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd } }, dir), {});
});

test('runtime health requires fresh work and background hooks, not an older installation heartbeat', async (t) => {
  const dir = await fixture(t), session = 'resume-fixture';
  await withState(dir, session, (s) => { s.enabled = true; s.startedAt = 1000; s.lastHookAt = s.lastWorkHookAt = s.lastBackgroundHookAt = 1500; });
  await handleHook({ session_id: session, hook_event_name: 'SessionStart', source: 'resume' }, dir, 2000);
  let state = await readState(dir, session);
  assert.equal(summarize(state, dir, 2001).hookObserved, false); assert.ok(state.pending);
  await handleHook({ session_id: session, hook_event_name: 'PostToolUse', tool_use_id: 'real-tool' }, dir, 2100);
  state = await readState(dir, session);
  assert.equal(summarize(state, dir, 2200).hookObserved, false);
  assert.equal(summarize(state, dir, 2200).hookState, 'awaiting_background_hook');
  await withState(dir, session, (s) => { s.lastBackgroundHookAt = 2100; });
  state = await readState(dir, session);
  assert.equal(summarize(state, dir, 2200).hookObserved, true);
  assert.equal(summarize(state, dir, 999999).hookState, 'idle');
});

test('known-dead PID locks recover, living PID locks are never stolen', async (t) => {
  const dir = await fixture(t), session = 'lock-fixture', file = sessionPath(dir, session) + '.lock';
  await writeFile(file, JSON.stringify({ pid: 1073741823, nonce: randomUUID(), at: 1 }));
  await withState(dir, session, (s) => { s.issued = 7; });
  assert.equal((await readState(dir, session)).issued, 7);
  await writeFile(file, JSON.stringify({ pid: process.pid, nonce: randomUUID(), at: 1 }));
  await assert.rejects(() => withState(dir, session, () => {}), /State busy/);
});

test('large histories become bounded tails and immutable pages without loss, duplicates or count changes', async (t) => {
  const dir = await fixture(t), session = 'history-fixture';
  const samples = Array.from({ length: 4000 }, (_, i) => ({ at: i + 1, epoch: 1, challenge: `p-${i}`, outcome: i % 2 ? 'compatible' : 'difference_signal', numbers: [i % 355 + 1] }));
  await withState(dir, session, (s) => { s.samples = structuredClone(samples); s.events = samples.map((r) => ({ at: r.at, type: 'probe_scored' })); s.issued = samples.length; });
  const state = await readState(dir, session);
  assert.ok(state.samples.length <= 256); assert.ok(state.events.length <= 512);
  assert.equal(historyCount(state, 'samples'), samples.length); assert.equal(summarize(state, dir).differenceSignals, 2000);
  assert.ok((await stat(sessionPath(dir, session))).size < 250000);
  const restored = []; let before;
  do { const page = await historyPage(dir, state, 'samples', { before }); restored.push(...page.rows); before = page.nextBefore; } while (before);
  assert.deepEqual(restored.reverse(), samples);
  const first = await historyPage(dir, state, 'samples', { limit: 200 });
  await withState(dir, session, (s) => { s.samples.push({ at: 5000, challenge: 'new' }); });
  const second = await historyPage(dir, await readState(dir, session), 'samples', { before: first.nextBefore, limit: 200 });
  assert.ok(!first.rows.some((a) => second.rows.some((b) => a.challenge === b.challenge)));
});

test('authenticated full-history pages redact arrays and reject invalid cursors', async (t) => {
  const dir = await fixture(t), session = 'api-history';
  await withState(dir, session, (s) => { s.samples = Array.from({ length: 600 }, (_, i) => ({ at: i, challenge: String(i), numbers: [1, 2, 3] })); });
  const server = await createDashboard({ directory: dir }); t.after(() => server.close());
  const route = `${server.origin}/api/sessions/${digest(session)}/history?kind=samples`;
  assert.equal((await fetch(route)).status, 401);
  const headers = { Authorization: `Bearer ${server.token}` };
  const first = await (await fetch(route, { headers })).json();
  assert.equal(first.total, 600); assert.equal(first.rows.length, 100); assert.equal(first.rows[0].challenge, '599');
  assert.ok(first.rows.every((r) => r.numbers === undefined));
  const older = await (await fetch(route + '&before=' + first.nextBefore, { headers })).json();
  assert.equal(older.rows[0].challenge, '499');
  assert.equal((await fetch(route + '&before=99999', { headers })).status, 400);
});

test('live alert stream requires capability and sends existing pending alerts without agent acknowledgement', async (t) => {
  const dir = await fixture(t), session = 'stream-fixture';
  await withState(dir, session, (s) => { s.enabled = true; s.alerts.push({ id: 'a', at: 1, expected: 'x', prediction: 'y', level: 'candidate_mismatch', acknowledgedAt: null }); });
  const server = await createDashboard({ directory: dir }); t.after(() => server.close());
  assert.equal((await fetch(`${server.origin}/api/alerts`)).status, 401);
  const controller = new AbortController();
  const response = await fetch(`${server.origin}/api/alerts`, { headers: { Authorization: `Bearer ${server.token}` }, signal: controller.signal });
  const reader = response.body.getReader(); let text = '';
  try { while (!text.includes('"prediction":"y"')) { const { value, done } = await reader.read(); if (done) break; text += Buffer.from(value).toString(); } }
  finally { controller.abort(); await reader.cancel().catch(() => {}); }
  assert.match(text, /"expected":"x"/);
  assert.equal((await readState(dir, session)).alerts[0].acknowledgedAt, null);
});

test('calibration reports empirical grouped rates, never manufactures independence or calibration', () => {
  assert.equal(evaluateCalibration([]).calibrated, false);
  const rows = Array.from({ length: 4 }, (_, i) => ({ split: 'holdout', mode: 'ephemeral_fork', groundTruthSource: 'controlled_endpoint', groundTruthModel: 'expected', expectedModel: 'expected', prediction: i === 2 ? 'expected' : 'other', language: 'zh', snapshotId: 'base', sampleId: String(i), bankSha256: 'bank', retryIndex: i, retryTarget: 3 }));
  const report = evaluateCalibration(rows);
  assert.equal(report.calibrated, false); assert.equal(report.groups[0].mismatchRate, .75); assert.equal(report.groups[0].allRetriesMismatchRate, 0);
  assert.equal(evaluateCalibration(rows.slice(0, 3)).groups[0].allRetriesMismatchRate, null);
  assert.throws(() => evaluateCalibration([...rows, rows[0]]), /Duplicate/);
  assert.throws(() => evaluateCalibration([{ ...rows[0], split: 'training' }]));
});
