import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { queueAlert, acknowledgeAlerts, pendingAlerts, userNotice } from '../scripts/alerts.mjs';
import { newState, readState, schedule, withState } from '../scripts/state.mjs';
import { handleHook, loadArtifacts } from '../scripts/guard.mjs';
import { run } from './fixture-runner.mjs';

const session = 'notification-synthetic-fixture';
const event = (hook, extra = {}) => ({ session_id: session, model: 'gpt-5.4', turn_id: 'turn-1', hook_event_name: hook, ...extra });
const sample = (extra = {}) => ({ challenge: 'synthetic-alert-1', at: 1000, epoch: 1, expected: 'gpt-5.4', prediction: 'o3', reportedModel: 'gpt-5.4', language: 'en', outcome: 'difference_signal', closedSetWeight: .91, expectedWeight: .04, ...extra });
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'modeltrace-alert-test-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(tmpdir())); assert.ok(path.basename(dir).startsWith('modeltrace-alert-test-')); await rm(dir, { recursive: true, force: true }); });
  await withState(dir, session, (s) => { s.enabled = true; s.model = s.expected = 'gpt-5.4'; s.startedAt = 1000; s.turn = 'turn-1'; schedule(s, 1000, (lo) => lo); queueAlert(s, sample()); });
  return dir;
}

test('known-label mismatches alert at weak and strong levels; unknown labels never imply substitution', () => {
  const s = newState(session);
  assert.equal(queueAlert(s, sample()).level, 'difference_signal');
  assert.equal(queueAlert(s, sample()).id, 'synthetic-alert-1'); assert.equal(s.alerts.length, 1);
  const weak = queueAlert(s, sample({ challenge: 'weak', outcome: 'inconclusive', closedSetWeight: .4, expectedWeight: .3 }));
  assert.equal(weak.level, 'candidate_mismatch'); assert.ok(userNotice(weak).includes('证据不足'));
  assert.equal(queueAlert(s, sample({ expectedWeight: null, outcome: 'unknown_expected_model' })), null);
  assert.equal(queueAlert(s, sample({ prediction: 'gpt-5.4', outcome: 'compatible' })), null);
  assert.equal(s.alerts.length, 2);
});

test('own submit hook injects an immediate agent notification without counting a work tool', async (t) => {
  const dir = await fixture(t);
  const output = await handleHook(event('PostToolUse', { tool_name: 'exec_command', tool_input: { cmd: 'node guard.mjs submit --numbers ...' } }), dir, 1001);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(output.hookSpecificOutput.additionalContext.includes('NOTIFY THE USER NOW'));
  assert.ok(output.hookSpecificOutput.additionalContext.includes('acknowledge --session'));
  assert.ok(output.systemMessage.includes('gpt-5.4') && output.systemMessage.includes('o3'));
  const s = await readState(dir, session); assert.equal(s.workTools, 0); assert.equal(s.alerts[0].deliveryCount, 1); assert.equal(s.alerts[0].acknowledgedAt, null);
  assert.deepEqual(await handleHook(event('PostToolUse', { tool_name: 'exec_command', tool_input: { cmd: 'node guard.mjs status' } }), dir, 1002), {});
});

test('acknowledgement is explicit, task scoped, idempotent and preserves the anomaly', async (t) => {
  const dir = await fixture(t), flags = ['--session', session, '--data-dir', dir];
  await assert.rejects(run(['acknowledge', ...flags, '--alert', 'missing'], {}), /Unknown alert/);
  const result = await run(['acknowledge', ...flags, '--alert', 'synthetic-alert-1'], {});
  assert.equal(result.remaining, 0);
  const s = await readState(dir, session); assert.equal(s.alerts.length, 1); assert.ok(s.alerts[0].acknowledgedAt);
  acknowledgeAlerts(s, ['synthetic-alert-1'], 99999999); assert.equal(s.events.filter((e) => e.type === 'agent_reported_user_notified').length, 1);
  await assert.rejects(run(['acknowledge', ...flags, '--alert', 'synthetic-alert-1'], { CODEX_THREAD_ID: 'different-task' }), /current Codex task/);
});

test('unacknowledged alerts retry next turn and survive compaction and disabled monitoring', async (t) => {
  const dir = await fixture(t);
  await handleHook(event('PostToolUse'), dir, 1001);
  const next = await handleHook(event('UserPromptSubmit', { turn_id: 'turn-2' }), dir, 1002);
  assert.ok(next.hookSpecificOutput.additionalContext.includes('NOTIFY THE USER NOW'));
  await handleHook(event('PreCompact', { turn_id: 'turn-2' }), dir, 1003);
  const compact = await handleHook(event('SessionStart', { turn_id: 'turn-2', source: 'compact' }), dir, 1004, (lo) => lo);
  assert.ok(compact.hookSpecificOutput.additionalContext.includes('NOTIFY THE USER NOW'));
  await withState(dir, session, (s) => { s.enabled = false; s.pending = null; });
  const disabled = await handleHook(event('UserPromptSubmit', { turn_id: 'turn-3' }), dir, 1005);
  assert.ok(disabled.hookSpecificOutput.additionalContext.includes('NOTIFY THE USER NOW'));
  assert.equal(pendingAlerts(await readState(dir, session)).length, 1);
});

test('Stop gives at most one notification continuation, with a visible fallback if ignored', async (t) => {
  const dir = await fixture(t);
  await withState(dir, session, (s) => { s.enabled = false; });
  const first = await handleHook(event('Stop'), dir, 1001);
  assert.equal(first.decision, 'block'); assert.ok(first.reason.includes('NOTIFY THE USER NOW'));
  const second = await handleHook(event('Stop', { stop_hook_active: true }), dir, 1002);
  assert.equal(second.decision, undefined); assert.ok(second.systemMessage.includes('ModelTrace Guard 提醒'));
  const third = await handleHook(event('Stop'), dir, 1003); assert.equal(third.decision, undefined);
  assert.equal(pendingAlerts(await readState(dir, session)).length, 1);
});

test('real submit transport returns notify action and durable alert for a synthetic known-model mismatch', async (t) => {
  const dir = await fixture(t), flags = ['--session', session, '--data-dir', dir];
  const { bank, analyzeGlobalOutputs } = await loadArtifacts();
  // Synthetic values ONLY validate plumbing; no monitoring accuracy claim.
  const numbers = JSON.stringify(Array.from({ length: 300 }, (_, i) => (i * 37 + 11) % 355 + 1));
  const predicted = analyzeGlobalOutputs([{ text: numbers, expected_count: 300 }], bank).results[0].model;
  const expected = bank.models.find((m) => m.id !== predicted).id;
  await withState(dir, session, (s) => { s.expected = expected; s.pending = { id: 'transport-test', count: 300, epoch: s.epoch, language: 'en', expiresAt: Date.now() + 30000 }; });
  const result = await run(['submit', ...flags, '--challenge', 'transport-test', '--numbers', numbers], {});
  assert.equal(result.agentAction, 'notify_user_now'); assert.ok(result.notificationContext.includes('transport-test')); assert.equal(result.notification.prediction, predicted);
  assert.equal((await readState(dir, session)).alerts.length, 2);
});
