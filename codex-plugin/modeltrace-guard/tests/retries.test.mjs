import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isMismatch, issue, newState, readState, sessionPath, updateConfirmation, validateConfig, withState,
} from '../scripts/state.mjs';
import { handleHook, loadArtifacts } from '../scripts/guard.mjs';
import { run } from './fixture-runner.mjs';

// Isolated synthetic fixtures test the control protocol, NOT model identity or
// fingerprint accuracy. Never call a model or write real monitoring evidence.
const session = 'retry-protocol-synthetic-fixture';
const minimum = (lo) => lo;
const numbers = JSON.stringify(Array.from({ length: 300 }, (_, i) => (i * 37 + 11) % 355 + 1));
const event = (hook_event_name, extra = {}) => ({ session_id: session, hook_event_name, turn_id: 'turn-1', ...extra });
const flags = (dir) => ['--session', session, '--data-dir', dir];
const command = (dir, name, ...args) => run([name, ...flags(dir), ...args], {});
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'modeltrace-retry-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('modeltrace-retry-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
async function startMismatch(t, args = []) {
  const dir = await fixture(t), { bank, analyzeGlobalOutputs } = await loadArtifacts();
  const prediction = analyzeGlobalOutputs([{ text: numbers, expected_count: 300 }], bank).results[0].model;
  const expected = bank.models.find((model) => model.id !== prediction).id;
  await handleHook(event('SessionStart', { model: expected }), dir);
  const started = await command(dir, 'start', '--languages', 'en', ...args);
  const initial = await command(dir, 'submit', '--challenge', started.pending.id, '--numbers', numbers);
  assert.equal(initial.agentAction, 'notify_user_now');
  assert.equal(initial.sample.prediction, prediction);
  assert.equal(initial.confirmation.results.length, 0);
  assert.equal(initial.challengeContext, null, 'initial alert must be acknowledged before retry issuance');
  return { dir, initial, expected, prediction };
}
async function acknowledge(dir) {
  const s = await readState(dir, session);
  const ids = s.alerts.filter((alert) => !alert.acknowledgedAt).map((alert) => alert.id);
  assert.ok(ids.length);
  return command(dir, 'acknowledge', '--alert', ids.join(','));
}
async function submitPending(dir) {
  const s = await readState(dir, session);
  assert.ok(s.pending);
  return command(dir, 'submit', '--challenge', s.pending.id, '--numbers', numbers);
}

test('default three extra retries follow immediate notification and end in a persistent halt', async (t) => {
  const { dir, initial } = await startMismatch(t);
  assert.equal(initial.confirmation.target, 3);
  assert.match(initial.notificationContext, /NOTIFY THE USER NOW/);
  assert.match(initial.controlContext, /3 background follow-up probes/);
  const afterSubmitHook = await handleHook(event('PostToolUse', { tool_name: 'exec_command', tool_input: { cmd: 'node guard.mjs submit' } }), dir);
  assert.match(afterSubmitHook.hookSpecificOutput.additionalContext, /NOTIFY THE USER NOW/);
  assert.equal((await readState(dir, session)).pending, null);
  const challenges = new Set([initial.sample.challenge]);
  for (let retry = 1; retry <= 3; retry++) {
    const ack = await acknowledge(dir);
    assert.equal(ack.pending.retryIndex, retry); assert.equal(ack.pending.retryTarget, 3);
    assert.equal(ack.pending.confirmationId, initial.sample.challenge);
    assert.match(ack.challengeContext, new RegExp(`retry ${retry}/3`));
    assert.match(ack.challengeContext, /background hook/);
    assert.match(ack.controlContext, /wait --session/);
    assert.equal(ack.pending.language, initial.sample.language);
    assert.equal(ack.pending.count, initial.sample.requestedCount);
    challenges.add(ack.pending.id);
    const replay = await command(dir, 'acknowledge', '--alert', ack.acknowledged.join(','));
    assert.equal(replay.pending.id, ack.pending.id, 'acknowledgement is idempotent');
    assert.equal(replay.probesIssued, ack.probesIssued);
    const result = await submitPending(dir);
    assert.equal(result.confirmation.results.length, retry);
    assert.equal(result.challengeContext, null);
    assert.equal(result.taskHalt !== null, retry === 3);
    if (retry === 3) {
      assert.equal(result.agentAction, 'stop_and_notify_user');
      assert.equal(result.notification.level, 'confirmed_mismatch');
      assert.match(result.userNotice, /3 次复测全部/);
      assert.match(result.controlContext, /STOP THE ORIGINAL TASK NOW AND NOTIFY THE USER/);
    } else assert.equal(result.agentAction, 'notify_user_now');
  }
  const state = await readState(dir, session);
  assert.equal(state.issued, 4); assert.equal(state.samples.length, 4); assert.equal(challenges.size, 4);
  assert.equal(state.workTools, 0, 'monitor work is not normal frequency work');
  assert.equal(state.events.filter((e) => e.type === 'confirmation_started').length, 1, 'no recursive retry batches');
  assert.equal(state.events.filter((e) => e.type === 'task_halt_requested').length, 1);
  assert.equal(state.confirmation.allMismatch, true); assert.equal(state.pending, null);
});

for (const retryCount of [1, 5]) test(`user-configured ${retryCount} additional retries do not include the initial sample`, async (t) => {
  const { dir, initial } = await startMismatch(t, ['--retry-count', String(retryCount)]);
  assert.equal(initial.confirmation.target, retryCount);
  for (let i = 0; i < retryCount; i++) { await acknowledge(dir); await submitPending(dir); }
  const state = await readState(dir, session);
  assert.equal(state.taskHalt.retryCount, retryCount);
  assert.equal(state.issued, retryCount + 1); assert.equal(state.samples.length, retryCount + 1);
});

test('retry-count and language changes apply to the next batch; current comparisons stay fixed', async (t) => {
  const { dir, initial } = await startMismatch(t);
  const updated = await command(dir, 'configure', '--retry-count', '7', '--languages', 'ja');
  assert.equal(updated.frequency.retryCount, 7);
  assert.equal(updated.confirmation.target, 3); assert.equal(updated.confirmation.language, 'en');
  assert.equal(updated.probesIssued, 1); assert.equal(updated.epoch, initial.sample.epoch);
  for (let i = 0; i < 3; i++) {
    const ack = await acknowledge(dir); assert.equal(ack.pending.language, 'en');
    await submitPending(dir);
  }
  const halted = await command(dir, 'status');
  assert.equal(halted.taskHalt.retryCount, 3); assert.equal(halted.frequency.retryCount, 7);
  await acknowledge(dir);
  await command(dir, 'resume', '--halt', halted.taskHalt.id);
  await withState(dir, session, (state) => { state.forceProbe = true; });
  await handleHook(event('UserPromptSubmit', { turn_id: 'turn-2' }), dir);
  const next = await submitPending(dir);
  assert.equal(next.confirmation.target, 7); assert.equal(next.confirmation.language, 'ja');
});

function comparisonFixture(target = 3) {
  const state = newState(session, 1000);
  state.enabled = true; state.model = state.expected = 'expected'; state.epoch = 1;
  state.config = validateConfig({ retryCount: target });
  const initial = { at: 1000, challenge: 'initial', epoch: 1, expected: 'expected', reportedModel: 'expected', prediction: 'other', expectedWeight: .2, outcome: 'inconclusive', language: 'en', bankSha256: 'bank' };
  updateConfirmation(state, initial, { count: 300 }, 1000);
  return { state, initial };
}
test('weak ranking mismatches count, different alternatives count, but any matching retry prevents halt', () => {
  for (const predictions of [['alt-a', 'expected', 'alt-b'], ['alt-a', 'alt-b', 'alt-c']]) {
    const { state, initial } = comparisonFixture();
    predictions.forEach((prediction, i) => {
      const sample = { ...initial, prediction, challenge: `retry-${i}`, at: 1001 + i };
      updateConfirmation(state, sample, { confirmationId: 'initial' }, sample.at);
      assert.equal(state.confirmation.results.length, i + 1);
      if (i < 2) assert.equal(state.confirmation.status, 'active');
    });
    assert.equal(state.confirmation.status, 'completed');
    assert.equal(Boolean(state.taskHalt), !predictions.includes('expected'));
    assert.equal(state.events.filter((e) => e.type === 'confirmation_started').length, 1);
  }
});

test('matching retry automatically returns the next retry without requiring a nonexistent alert acknowledgement', async (t) => {
  const dir = await fixture(t), { bank, metadata, analyzeGlobalOutputs } = await loadArtifacts();
  const expected = analyzeGlobalOutputs([{ text: numbers, expected_count: 300 }], bank).results[0].model;
  await handleHook(event('SessionStart', { model: expected }), dir);
  await withState(dir, session, (state) => {
    state.enabled = true; state.startedAt = Date.now(); state.epoch = 1;
    const sample = { at: Date.now(), challenge: 'synthetic-initial', epoch: 1, expected, reportedModel: expected, prediction: 'different', expectedWeight: .2, outcome: 'inconclusive', language: 'en', bankSha256: metadata.bankSha256 };
    state.samples.push(sample); state.issued = state.turnIssued = 1;
    updateConfirmation(state, sample, { count: 300 }, sample.at);
    issue(state, Date.now(), minimum);
  });
  const result = await submitPending(dir);
  assert.equal(result.sample.prediction, expected); assert.equal(result.notification, null);
  assert.equal(result.confirmation.results.length, 1); assert.equal(result.confirmation.results[0].mismatch, false);
  assert.equal(result.agentAction, 'complete_retries'); assert.match(result.challengeContext, /retry 2\/3/);
  assert.equal((await readState(dir, session)).pending.retryIndex, 2);
});

test('missing or unlisted expected models never start mismatch retries', async (t) => {
  for (const expected of [undefined, 'not-in-the-bank']) {
    const dir = await fixture(t);
    const started = await command(dir, 'start', ...(expected ? ['--expected', expected] : []));
    const result = await command(dir, 'submit', '--challenge', started.pending.id, '--numbers', numbers);
    assert.equal(result.confirmation, null); assert.equal(result.taskHalt, null); assert.equal(result.notification, null);
    assert.equal(isMismatch(result.sample), false);
  }
});

test('invalid and expired retries never count as completed mismatches', async (t) => {
  const { dir } = await startMismatch(t);
  const ack = await acknowledge(dir);
  await assert.rejects(() => command(dir, 'submit', '--challenge', ack.pending.id, '--numbers', '[0,1]'));
  let state = await readState(dir, session);
  assert.equal(state.confirmation.results.length, 0); assert.equal(state.pending.id, ack.pending.id);
  await withState(dir, session, (s) => { s.pending.expiresAt = 1; });
  const late = await submitPending(dir);
  assert.equal(late.accepted, false);
  state = await readState(dir, session);
  assert.equal(state.confirmation.status, 'interrupted'); assert.equal(state.confirmation.reason, 'late_submission');
  assert.equal(state.confirmation.results.length, 0); assert.equal(state.taskHalt, null);
  assert.equal(state.samples.length, 1); assert.equal(state.missed, 1);
});

for (const hook of ['Interrupt', 'SessionEnd', 'PreCompact']) test(`${hook} interrupts retries even while awaiting initial notification`, async (t) => {
  const { dir } = await startMismatch(t);
  await handleHook(event(hook), dir);
  const state = await readState(dir, session);
  assert.equal(state.confirmation.status, 'interrupted'); assert.equal(state.confirmation.results.length, 0);
  assert.equal(state.taskHalt, null); assert.equal(state.samples.length, 1); assert.equal(state.alerts.length, 1);
});

test('expected model, declared model and reference-bank changes interrupt a batch without erasing results', async (t) => {
  for (const change of ['expected', 'model', 'bank']) {
    const { dir, expected } = await startMismatch(t);
    await acknowledge(dir); await submitPending(dir); await acknowledge(dir);
    if (change === 'expected') await command(dir, 'configure', '--expected', 'changed-label');
    else if (change === 'model') await handleHook(event('PostToolUse', { model: `${expected}-changed` }), dir);
    else { await withState(dir, session, (state) => { state.bankSha256 = 'changed-bank'; }); assert.equal((await submitPending(dir)).accepted, false); }
    const state = await readState(dir, session);
    assert.equal(state.confirmation.status, 'interrupted'); assert.equal(state.confirmation.results.length, 1);
    assert.equal(state.taskHalt, null); assert.equal(state.samples.length, 2);
  }
});

test('comparison guard rejects an out-of-segment or unavailable retry', () => {
  for (const change of [{ epoch: 9 }, { language: 'ja' }, { bankSha256: 'new' }, { reportedModel: 'new' }, { expectedWeight: null }, { prediction: null }, { outcome: 'unknown_expected_model' }]) {
    const { state, initial } = comparisonFixture();
    updateConfirmation(state, { ...initial, challenge: 'retry', ...change }, { confirmationId: initial.challenge }, 1001);
    assert.equal(state.confirmation.status, 'interrupted'); assert.equal(state.confirmation.results.length, 0);
    assert.equal(state.taskHalt, null);
  }
});

test('a legacy budget-paused retry batch resumes without limits and still stops at its configured target', async (t) => {
  const { dir } = await startMismatch(t, ['--retry-count', '10']);
  await withState(dir, session, (state) => {
    state.config.maxPerTurn = 1; state.config.maxPerSession = 2;
    state.issued = state.turnIssued = 1000; state.lastOutcome = 'budget_paused';
  });
  for (let i = 0; i < 10; i++) {
    const ack = await acknowledge(dir);
    assert.equal(ack.pending.retryIndex, i + 1); assert.equal(ack.frequency.maxPerTurn, undefined);
    const submitted = await submitPending(dir);
    assert.equal(submitted.confirmation.results.length, i + 1);
    assert.equal(Boolean(submitted.taskHalt), i === 9);
  }
  const completed = await readState(dir, session);
  assert.equal(completed.issued, 1010); assert.equal(completed.turnIssued, 1010);
  assert.equal(completed.taskHalt.retryCount, 10); assert.equal(completed.pending, null);
  assert.equal(completed.events.filter((e) => e.type === 'confirmation_started').length, 1);
  assert.equal(completed.events.filter((e) => e.type === 'budget_paused').length, 0);
});

test('halt survives acknowledgement, hooks, stop/start and configure until explicit current-ID resume', async (t) => {
  const { dir } = await startMismatch(t, ['--retry-count', '1']);
  await acknowledge(dir); const result = await submitPending(dir);
  const halt = result.taskHalt;
  const firstStop = await handleHook(event('Stop'), dir);
  assert.equal(firstStop.decision, 'block'); assert.match(firstStop.reason, /STOP THE ORIGINAL TASK NOW/);
  const secondStop = await handleHook(event('Stop', { stop_hook_active: true }), dir);
  assert.equal(secondStop.decision, undefined);
  await acknowledge(dir);
  for (const name of ['PostToolUse', 'SessionStart', 'UserPromptSubmit', 'Stop']) {
    const output = await handleHook(event(name, { turn_id: `halt-${name}`, model: 'new-declared-model' }), dir);
    assert.match(output.systemMessage, /STOP THE ORIGINAL TASK NOW/);
  }
  for (const [name, args] of [['configure', ['--retry-count', '8']], ['stop', []], ['start', []]]) {
    const changed = await command(dir, name, ...args);
    assert.equal(changed.status, 'task_halted'); assert.equal(changed.taskHalt.id, halt.id); assert.equal(changed.pending, null);
  }
  await command(dir, 'stop');
  assert.match((await handleHook(event('Stop'), dir)).systemMessage, /STOP THE ORIGINAL TASK NOW/);
  await assert.rejects(() => command(dir, 'resume'), /current halt ID/);
  await assert.rejects(() => command(dir, 'resume', '--halt', 'wrong'), /current halt ID/);
  const before = await readState(dir, session);
  const resumed = await command(dir, 'resume', '--halt', halt.id);
  assert.equal(resumed.taskHalt, null); assert.equal(resumed.enabled, false); assert.equal(resumed.probesIssued, 2);
  const after = await readState(dir, session);
  assert.deepEqual(after.samples, before.samples); assert.deepEqual(after.alerts, before.alerts);
  assert.equal(after.events.at(-1).type, 'task_resumed'); assert.equal(after.events.at(-1).halt, halt.id);
});

test('retired time/cap migration preserves history and counters and only runs once on the next write', async (t) => {
  const dir = await fixture(t), state = newState(session, 1000);
  delete state.config.retryCount;
  state.config.mode = 'time'; state.config.secondsMin = 99; state.config.secondsMax = 999;
  state.config.maxPerTurn = 1; state.config.maxPerSession = 2; state.lastOutcome = 'budget_paused';
  state.events.push({ type: 'budget_paused', at: 1001, epoch: 0 });
  state.nextAt = 99000; state.issued = 2; state.samples.push({ outcome: 'unknown_expected_model', expected: null, numbers: [1, 2, 3] });
  await writeFile(sessionPath(dir, session), JSON.stringify(state));
  const before = await readFile(sessionPath(dir, session), 'utf8');
  const status = await command(dir, 'status');
  assert.equal(status.frequency.retryCount, 3); assert.equal(status.frequency.mode, 'tools');
  assert.equal(status.frequency.maxPerTurn, undefined); assert.equal(status.frequency.maxPerSession, undefined);
  assert.equal(status.fingerprintDisplayStatus, 'missing_expected_model');
  assert.equal(await readFile(sessionPath(dir, session), 'utf8'), before);
  await withState(dir, session, () => {}); await withState(dir, session, () => {});
  const migrated = await readState(dir, session);
  assert.equal(migrated.config.secondsMin, undefined); assert.equal(migrated.nextAt, null);
  assert.equal(migrated.config.maxPerTurn, undefined); assert.equal(migrated.config.maxPerSession, undefined);
  assert.equal(migrated.lastOutcome, 'unknown_expected_model');
  assert.deepEqual(migrated.events[0], state.events[0]);
  assert.equal(migrated.issued, 2); assert.deepEqual(migrated.samples, state.samples);
  assert.equal(migrated.events.filter((e) => e.type === 'configuration_migrated').length, 1);
});
