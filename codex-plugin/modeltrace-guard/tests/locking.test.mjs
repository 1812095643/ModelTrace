import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT, handleHook } from '../scripts/guard.mjs';
import { attemptStateLock, readState, replaceStateFile, sessionPath, withState } from '../scripts/state.mjs';
import { queueAlert } from '../scripts/alerts.mjs';

const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
const backgroundLock = { lockTimeoutMs: 10000 };

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'modeltrace-lock-test-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('modeltrace-lock-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, session: randomUUID() };
}

test('background writers outwait foreground contention without stealing a live lock or losing updates', { timeout: 20000 }, async (t) => {
  const { directory, session } = await fixture(t), entered = deferred(), release = deferred();
  const owner = withState(directory, session, async (state) => { entered.resolve(); await release.promise; state.workTools += 1; });
  await entered.promise;
  const lease = await readFile(sessionPath(directory, session) + '.lock', 'utf8');
  const waiting = withState(directory, session, (state) => { state.workTools += 1; }, backgroundLock)
    .then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  try {
    await assert.rejects(() => withState(directory, session, () => { assert.fail('foreground must not enter the live writer'); }), /State busy/);
    await delay(100);
    assert.equal(await readFile(sessionPath(directory, session) + '.lock', 'utf8'), lease);
  } finally { release.resolve(); await owner; }
  const result = await waiting;
  assert.equal(result.ok, true, result.error?.message);
  assert.equal((await readState(directory, session)).workTools, 2);
});

test('lock deadlines are bounded and a timed-out writer never calls its callback', async (t) => {
  const { directory, session } = await fixture(t);
  const file = sessionPath(directory, session) + '.lock';
  const lease = JSON.stringify({ pid: process.pid, nonce: randomUUID(), at: 1 });
  await writeFile(file, lease);
  await assert.rejects(() => withState(directory, session, () => { assert.fail('live lease was stolen'); }, { lockTimeoutMs: 60 }),
    (error) => error.code === 'MODELTRACE_STATE_BUSY' && error.lockTimeoutMs === 60);
  assert.equal(await readFile(file, 'utf8'), lease);
  for (const lockTimeoutMs of [-1, Infinity, NaN, '1000', 1.5, 60001]) {
    await assert.rejects(() => withState(directory, session, () => {}, { lockTimeoutMs }), /lockTimeoutMs/);
  }
});

test('eight independent processes serialize slow state writes without losing tool counts', { timeout: 40000 }, async (t) => {
  const { directory, session } = await fixture(t);
  await withState(directory, session, () => {});
  const code = `
    import { withState } from ${JSON.stringify(new URL('../scripts/state.mjs', import.meta.url).href)};
    import { setTimeout as delay } from 'node:timers/promises';
    process.send('ready');
    await new Promise((resolve) => process.once('message', resolve));
    for (let i = 0; i < 4; i++) {
      await withState(process.argv[1], process.argv[2], async (state) => {
        const before = state.workTools;
        await delay(40);
        state.workTools = before + 1;
      }, { lockTimeoutMs: 10000 });
    }
    process.disconnect();
  `;
  const workers = Array.from({ length: 8 }, () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, directory, session], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr.on('data', (bytes) => { stderr += bytes; });
    const ready = new Promise((resolve, reject) => {
      child.once('message', resolve); child.once('error', reject);
      child.once('exit', () => reject(new Error('lock worker exited before ready: ' + stderr)));
    });
    const done = new Promise((resolve) => {
      child.once('error', (error) => resolve({ code: null, stderr: error.message }));
      child.once('close', (code) => resolve({ code, stderr }));
    });
    return { child, ready, done };
  });
  try {
    await Promise.all(workers.map((worker) => worker.ready));
    for (const worker of workers) worker.child.send('go');
    for (const result of await Promise.all(workers.map((worker) => worker.done))) assert.equal(result.code, 0, result.stderr);
    assert.equal((await readState(directory, session)).workTools, 32);
  } finally {
    for (const { child } of workers) if (child.exitCode === null) child.kill();
    await Promise.all(workers.map((worker) => worker.done));
  }
});

test('Windows atomic replacement retries transient busy errors without deleting committed state', async (t) => {
  const { directory } = await fixture(t), temporary = path.join(directory, 'next.tmp'), filename = path.join(directory, 'state.json');
  await writeFile(filename, 'old committed state'); await writeFile(temporary, 'new committed state');
  const codes = ['EPERM', 'EACCES', 'EBUSY']; let attempts = 0;
  await replaceStateFile(temporary, filename, {
    platform: 'win32', timeoutMs: 1000,
    replace: async (from, to) => {
      assert.equal(await readFile(to, 'utf8'), 'old committed state');
      if (attempts < codes.length) throw Object.assign(new Error('temporarily busy'), { code: codes[attempts++] });
      attempts++; await rename(from, to);
    },
  });
  assert.ok(attempts >= 4); assert.equal(await readFile(filename, 'utf8'), 'new committed state');
});

test('Windows delete-pending leases remain exclusive contenders, not fatal open errors', async () => {
  for (const [platform, code] of [['win32', 'EPERM'], ['win32', 'EACCES'], ['win32', 'EBUSY'], ['linux', 'EEXIST']]) {
    const error = Object.assign(new Error('busy'), { code });
    const attempt = await attemptStateLock('lease', { platform, openFile: async (...args) => {
      assert.deepEqual(args, ['lease', 'wx', 0o600]); throw error;
    } });
    assert.equal(attempt.error, error); assert.equal(attempt.lock, undefined);
  }
  for (const [platform, code] of [['linux', 'EPERM'], ['win32', 'ENOSPC']]) {
    const error = Object.assign(new Error('permanent'), { code });
    await assert.rejects(() => attemptStateLock('lease', { platform, openFile: async () => { throw error; } }), (caught) => caught === error);
  }
});

test('exhausted Windows replacement retries preserve both files and report a busy commit', async (t) => {
  const { directory } = await fixture(t), temporary = path.join(directory, 'next.tmp'), filename = path.join(directory, 'state.json');
  await writeFile(filename, 'old'); await writeFile(temporary, 'new');
  await assert.rejects(() => replaceStateFile(temporary, filename, {
    platform: 'win32', timeoutMs: 60,
    replace: async () => { throw Object.assign(new Error('busy'), { code: 'EPERM' }); },
  }), (error) => error.code === 'MODELTRACE_STATE_BUSY' && error.operation === 'commit' && error.cause.code === 'EPERM');
  assert.equal(await readFile(filename, 'utf8'), 'old'); assert.equal(await readFile(temporary, 'utf8'), 'new');
});

test('replacement never retries unrelated I/O failures or Unix permission errors', async () => {
  for (const [platform, code] of [['win32', 'ENOSPC'], ['linux', 'EPERM']]) {
    const failure = Object.assign(new Error('permanent failure'), { code }); let attempts = 0;
    await assert.rejects(() => replaceStateFile('unused', 'unused', {
      platform, replace: async () => { attempts++; throw failure; },
    }), (error) => error === failure);
    assert.equal(attempts, 1);
  }
  for (const timeoutMs of [-1, Infinity, NaN, '1000', 1001]) {
    await assert.rejects(() => replaceStateFile('unused', 'unused', { timeoutMs }), /timeoutMs/);
  }
});

for (const condition of ['halt', 'confirmation', 'alert', 'normal']) {
  test(`a busy lock preserves the committed ${condition} decision at PreToolUse`, { timeout: 10000 }, async (t) => {
    const { directory, session } = await fixture(t);
    await withState(directory, session, (state) => {
      state.enabled = true;
      if (condition === 'halt') state.taskHalt = { id: 'halt', expected: 'gpt-5.4', retryCount: 3 };
      if (condition === 'confirmation') state.confirmation = { id: 'batch', status: 'active', target: 3, results: [] };
      if (condition === 'alert') queueAlert(state, { challenge: 'alert', at: 1, expected: 'gpt-5.4', prediction: 'gpt-5.5', expectedWeight: .1, closedSetWeight: .9, outcome: 'difference_signal' });
    });
    const file = sessionPath(directory, session), before = await readFile(file, 'utf8');
    const lease = JSON.stringify({ pid: process.pid, nonce: randomUUID(), at: 1 });
    await writeFile(file + '.lock', lease);
    const event = { session_id: session, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: 'original work' } };
    const [result, control] = await Promise.all([
      handleHook(event, directory),
      handleHook({ ...event, tool_name: 'exec_command', tool_input: { cmd: `node '${path.join(ROOT, 'scripts/guard.mjs')}' status` } }, directory),
    ]);
    if (condition === 'normal') assert.deepEqual(result, {});
    else assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny');
    assert.deepEqual(control, {});
    assert.equal(await readFile(file, 'utf8'), before);
    assert.equal(await readFile(file + '.lock', 'utf8'), lease);
  });
}

test('a busy Stop preserves a pending confirmation and does not start a continuation loop', { timeout: 10000 }, async (t) => {
  const { directory, session } = await fixture(t);
  await withState(directory, session, (state) => { state.enabled = true; state.confirmation = { id: 'batch', status: 'active', target: 3, results: [] }; });
  await writeFile(sessionPath(directory, session) + '.lock', JSON.stringify({ pid: process.pid, nonce: randomUUID(), at: 1 }));
  const event = { session_id: session, hook_event_name: 'Stop' };
  const first = await handleHook(event, directory);
  assert.equal(first.decision, 'block'); assert.match(first.reason, /pause original task work/);
  const second = await handleHook({ ...event, stop_hook_active: true }, directory);
  assert.equal(second.decision, undefined); assert.match(second.systemMessage, /pause original task work/);
});

test('a busy guard cannot silently allow work when the committed state is unreadable', { timeout: 10000 }, async (t) => {
  const { directory, session } = await fixture(t), file = sessionPath(directory, session);
  await writeFile(file, 'not json');
  await writeFile(file + '.lock', JSON.stringify({ pid: process.pid, nonce: randomUUID(), at: 1 }));
  const result = await handleHook({ session_id: session, hook_event_name: 'PreToolUse', tool_name: 'apply_patch' }, directory);
  assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /state.*unavailable/i);
});

test('the actual hook command returns deny, not a generic warning, for a busy halted task', { timeout: 15000 }, async (t) => {
  const { directory, session } = await fixture(t);
  await withState(directory, session, (state) => { state.taskHalt = { id: 'halt', expected: 'gpt-5.4', retryCount: 3 }; });
  await writeFile(sessionPath(directory, session) + '.lock', JSON.stringify({ pid: process.pid, nonce: randomUUID(), at: 1 }));
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts/guard.mjs'), 'hook'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MODELTRACE_GUARD_DATA: directory, CODEX_THREAD_ID: session, MODELTRACE_PROBE_PROCESS: '0' },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (bytes) => { stdout += bytes; }); child.stderr.on('data', (bytes) => { stderr += bytes; });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  child.stdin.end(JSON.stringify({ session_id: session, hook_event_name: 'PreToolUse', tool_name: 'apply_patch' }));
  assert.equal(await done, 0, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny');
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /STOP THE ORIGINAL TASK/);
});
