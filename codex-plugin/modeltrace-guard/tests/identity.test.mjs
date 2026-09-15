import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { classifySample, digest, displayOutcome, newState, publicSample, readState, schedule, sessionPath, setCodexTaskName, setTaskName, withState, workspaceName } from '../scripts/state.mjs';
import { handleHook, run } from '../scripts/guard.mjs';
import { handleBackgroundHook } from '../scripts/background.mjs';
import { summarize } from '../scripts/status.mjs';
import { createDashboard } from '../scripts/dashboard-server.mjs';

const session = 'identity-synthetic-test';
const legacySample = () => ({ at: 1000, epoch: 1, expected: null, reportedModel: null, prediction: 'gpt-6-astra', outcome: 'unknown_expected_model', expectedWeight: null, numbers: [1, 2, 3], sampleSha256: 'preserve-this' });
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'modeltrace-identity-test-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(tmpdir())); assert.ok(path.basename(dir).startsWith('modeltrace-identity-test-')); await rm(dir, { recursive: true, force: true }); });
  return dir;
}

test('missing comparison label is distinct from a nonempty label absent from the bank', () => {
  const result = { results: [{ model: 'gpt-6-astra', probability: .9 }] };
  assert.equal(classifySample(result, null).outcome, 'missing_expected_model');
  assert.equal(classifySample(result, '').outcome, 'missing_expected_model');
  assert.equal(classifySample(result, 'unlisted').outcome, 'unknown_expected_model');
  assert.equal(classifySample(result, 'gpt-6-astra').outcome, 'compatible');
});

test('legacy null-label presentation never rewrites the recorded outcome or expected identity', () => {
  const old = legacySample(), copy = JSON.stringify(old);
  assert.equal(displayOutcome(old), 'missing_expected_model');
  const exposed = publicSample(old);
  assert.equal(exposed.displayOutcome, 'missing_expected_model'); assert.equal(exposed.outcome, 'unknown_expected_model');
  assert.equal(exposed.expected, null); assert.equal(exposed.numbers, undefined); assert.equal(JSON.stringify(old), copy);
  const s = newState(session); s.enabled = true; s.startedAt = s.createdAt; s.lastHookAt = s.createdAt + 1;
  s.model = s.expected = 'gpt-6-astra'; s.samples.push(old); s.lastOutcome = old.outcome;
  const status = summarize(s, '/test');
  assert.equal(status.status, 'hooks_unverified'); assert.equal(status.fingerprintDisplayStatus, 'missing_expected_model'); assert.equal(status.fingerprintStatus, 'unknown_expected_model'); assert.equal(status.expectedModel, 'gpt-6-astra');
  assert.equal(status.latest[0].expected, null);
  assert.equal(displayOutcome({ ...old, expected: 'actually-unlisted' }), 'unknown_expected_model');
});

test('late arrival of model metadata updates future expectations, not old samples', async (t) => {
  const dir = await fixture(t);
  await withState(dir, session, (s) => { s.enabled = true; s.startedAt = 1000; s.samples.push(legacySample()); s.lastOutcome = 'unknown_expected_model'; schedule(s, 1000, (lo) => lo); });
  const before = JSON.stringify((await readState(dir, session)).samples);
  await handleHook({ session_id: session, hook_event_name: 'PostToolUse', model: 'gpt-6-astra', cwd: 'C:\\work\\readable-project', tool_name: 'exec_command', tool_input: { cmd: 'node guard.mjs status' } }, dir, 1001);
  const after = await readState(dir, session);
  assert.equal(after.expected, 'gpt-6-astra'); assert.equal(JSON.stringify(after.samples), before);
  assert.equal(after.workspaceName, 'readable-project'); assert.equal(after.events.at(-1).type, 'model_label_observed');
  assert.ok(!JSON.stringify(after).includes('C:\\\\work'));
});

test('unnamed tasks explicitly distinguish workspace fallback from a real task title', () => {
  const s = newState(session, 1000); s.workspaceName = 'ModelTrace';
  assert.ok(summarize(s, '/test').displayName.startsWith('未命名任务（ModelTrace） · '));
  assert.ok(!summarize(s, '/test').displayName.includes(session));
  setTaskName(s, '  重构登录流程  ', 1001); assert.equal(summarize(s, '/test').displayName, '重构登录流程');
  setTaskName(s, '重构登录流程', 1002); assert.equal(s.events.length, 1);
  for (const bad of ['', ' ', 'x'.repeat(121), 'a\nb', 3, null]) assert.throws(() => setTaskName(s, bad));
  assert.equal(workspaceName('C:\\work\\project\\'), 'project'); assert.equal(workspaceName('/work/project'), 'project'); assert.equal(workspaceName('bad\npath'), null);
});

test('native task titles are metadata only and never override a custom name', () => {
  const s = newState(session, 1000); s.workspaceName = 'traitnew';
  setCodexTaskName(s, '  开启 ModelTrace Guard  ', 1001);
  assert.equal(summarize(s, '/test').displayName, '开启 ModelTrace Guard');
  assert.equal(s.taskName, null); assert.equal(s.enabled, false); assert.equal(s.issued, 0);
  setTaskName(s, '我的自定义名称', 1002);
  setCodexTaskName(s, 'Codex 中的新标题', 1003);
  assert.equal(summarize(s, '/test').displayName, '我的自定义名称');
  assert.equal(summarize(s, '/test').codexTaskName, 'Codex 中的新标题');
  const before = JSON.stringify(s);
  for (const name of ['', ' ', null, 42, 'x'.repeat(121), 'bad\nname']) setCodexTaskName(s, name);
  assert.equal(JSON.stringify(s), before);
});

test('same-workspace tasks do not inherit opt-in and dashboard selection cannot start them', async (t) => {
  const dir = await fixture(t);
  await run(['start', '--session', session, '--data-dir', dir], {});
  const parent = await readState(dir, session), other = 'different-task-in-same-workspace';
  let connects = 0;
  const dependencies = { connect: async () => { connects++; throw new Error('Unenabled task must never connect'); } };
  for (const hook_event_name of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUse']) {
    assert.deepEqual(await handleBackgroundHook({ session_id: other, hook_event_name, cwd: process.cwd(), model: 'gpt-6-astra', source: 'resume', tool_name: 'exec_command', tool_use_id: hook_event_name }, dir, {}, dependencies), {});
  }
  const inactive = await readState(dir, other);
  assert.equal(inactive.enabled, false); assert.equal(inactive.issued, 0); assert.equal(inactive.samples.length, 0);
  assert.equal(inactive.pending, null); assert.equal(connects, 0);
  assert.deepEqual(await readState(dir, session), parent);
  const service = await createDashboard({ directory: dir }); t.after(() => service.close());
  const headers = { Authorization: `Bearer ${service.token}` };
  const listing = await (await fetch(service.origin + '/api/sessions', { headers })).json();
  assert.deepEqual(listing.sessions.map((s) => s.session), [session]);
  const viewed = await (await fetch(service.origin + '/api/sessions/' + digest(other), { headers })).json();
  assert.equal(viewed.enabled, false); assert.equal(viewed.probesIssued, 0);
  assert.deepEqual(await readState(dir, other), inactive);
});

test('label CLI can name an inactive task without starting probes or changing counters', async (t) => {
  const dir = await fixture(t), flags = ['--session', session, '--data-dir', dir];
  const result = await run(['label', ...flags, '--name', '启用 ModelTrace Guard 采样'], {});
  assert.equal(result.enabled, false); assert.equal(result.probesIssued, 0); assert.equal(result.taskName, '启用 ModelTrace Guard 采样');
  const before = await readFile(sessionPath(dir, session), 'utf8');
  await assert.rejects(run(['label', ...flags, '--name', 'wrong'], { CODEX_THREAD_ID: 'other-task' }), /current Codex task/);
  await assert.rejects(run(['label', ...flags, '--name', ''], {}));
  assert.equal(await readFile(sessionPath(dir, session), 'utf8'), before);
});

test('dashboard name updates are authenticated, metadata-only, and preserve legacy evidence byte-for-byte', async (t) => {
  const dir = await fixture(t);
  await withState(dir, session, (s) => { s.samples.push(legacySample()); s.issued = 1; s.expected = s.model = 'gpt-6-astra'; });
  const before = await readState(dir, session), service = await createDashboard({ directory: dir }); t.after(() => service.close());
  const route = `${service.origin}/api/sessions/${digest(session)}`;
  const headers = { Authorization: `Bearer ${service.token}`, Origin: service.origin, 'Content-Type': 'application/json' };
  const post = (body, override = {}) => fetch(route + '/name', { method: 'POST', headers: { ...headers, ...override }, body: JSON.stringify(body) });
  assert.equal((await post({ name: '测试名称' }, { Authorization: '' })).status, 401);
  assert.equal((await post({ name: '测试名称' }, { Origin: 'https://hostile.invalid' })).status, 403);
  for (const bad of [{}, { name: '' }, { name: 42 }, { name: 'valid', expected: 'other' }, { name: 'valid', enabled: true }]) assert.equal((await post(bad)).status, 400);
  const res = await post({ name: '启用 ModelTrace Guard 采样' }); assert.equal(res.status, 200);
  const view = await res.json(); assert.equal(view.displayName, '启用 ModelTrace Guard 采样'); assert.equal(view.samples[0].displayOutcome, 'missing_expected_model');
  const after = await readState(dir, session);
  for (const key of ['samples', 'issued', 'pending', 'expected', 'model', 'config', 'enabled', 'alerts']) assert.deepEqual(after[key], before[key], key);
  assert.equal(after.samples[0].outcome, 'unknown_expected_model'); assert.equal(after.samples[0].sampleSha256, 'preserve-this');
  const listing = await (await fetch(service.origin + '/api/sessions', { headers })).json(); assert.equal(listing.sessions[0].displayName, '启用 ModelTrace Guard 采样');
});
