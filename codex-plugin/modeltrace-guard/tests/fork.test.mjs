import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT, run, handleHook, loadArtifacts, submitForkResult, summarize } from '../scripts/guard.mjs';
import { readState, withState, processAlive } from '../scripts/state.mjs';
import { runForkProbe, forkParameters, verifyFork, generateProbe, requireTrustedGuard } from '../scripts/fork-runner.mjs';
import { BACKGROUND_EVENTS, BACKGROUND_TIMEOUT_SECONDS, handleBackgroundHook, waitForConfirmation } from '../scripts/background.mjs';
import { cleanSnapshot, cleanupPending } from '../scripts/fork-cleanup.mjs';
import { cleanupPath } from '../scripts/fork-snapshot.mjs';

// In-memory protocol double. No Codex process, provider, API or real task is
// contacted; synthetic arrays test workflow invariants, never identification.
const integers = JSON.stringify(Array.from({ length: 300 }, (_, i) => (i * 37 + 11) % 355 + 1));
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'modeltrace-fork-test-'));
  t.after(async () => { assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('modeltrace-fork-test-')); await rm(directory, { recursive: true, force: true }); });
  const session = randomUUID();
  const { bank, analyzeGlobalOutputs } = await loadArtifacts();
  const prediction = analyzeGlobalOutputs([{ text: integers, expected_count: 300 }], bank).results[0].model;
  const model = bank.models.find((m) => m.id !== prediction).id;
  const source = path.join(directory, 'source.jsonl');
  await writeFile(source, JSON.stringify({ type: 'session_meta', payload: { id: session, model_provider: 'fixture', cwd: directory } }) + '\n' + JSON.stringify({ type: 'turn_context', payload: { model, effort: 'high', cwd: directory } }) + '\n');
  const initialHistory = [{ id: 'frozen-turn', status: 'interrupted', items: [{ type: 'userMessage', text: 'Original task context, no probe answers' }] }];
  const threads = new Map([[session, { id: session, path: source, history: structuredClone(initialHistory) }]]), calls = [], generatedHistories = [];
  let createdBase = 0, closed = 0;
  function connect() {
    const ephemeral = [];
    return {
      listeners: new Set(),
      async request(method, params) {
        calls.push({ method, params: structuredClone(params) });
        if (method === 'thread/read') { const thread = threads.get(params.threadId); if (!thread) throw new Error('no rollout found'); return { thread }; }
        if (method === 'thread/turns/list') { const thread = threads.get(params.threadId); return { data: structuredClone(thread.history), nextCursor: null }; }
        if (method === 'thread/fork') {
          const parent = threads.get(params.threadId); assert.ok(parent);
          const id = randomUUID(), thread = { id, path: params.ephemeral ? null : `${source}.${id}`, ephemeral: Boolean(params.ephemeral), forkedFromId: parent.id, history: structuredClone(parent.history) };
          threads.set(id, thread); if (params.ephemeral) ephemeral.push(id); else createdBase++;
          return { thread, model, modelProvider: 'fixture', reasoningEffort: 'high', serviceTier: 'default', instructionSources: [] };
        }
        if (method === 'thread/list') return { data: [] };
        if (method === 'thread/delete') { assert.notEqual(params.threadId, session); threads.delete(params.threadId); return {}; }
        throw new Error(`Unexpected fixture request ${method}`);
      },
      async close() { closed++; for (const id of ephemeral) threads.delete(id); },
    };
  }
  const dependencies = { connect, enforceTrust: async () => {}, submit: submitForkResult,
    generate: async (client, id) => {
      generatedHistories.push(structuredClone(threads.get(id).history));
      threads.get(id).history.push({ id: 'probe-answer', items: [{ text: integers }] });
      return { text: integers, usage: { inputTokens: 10000, cachedInputTokens: 8000 } };
    } };
  const command = (name, ...args) => run([name, '--session', session, '--data-dir', directory, ...args], {});
  await handleHook({ session_id: session, hook_event_name: 'SessionStart', model }, directory);
  return { directory, session, model, threads, calls, initialHistory, generatedHistories, dependencies, connect, command, counts: () => ({ createdBase, closed }) };
}

test('initial probe and all three retries fork one immutable native base, never prior probe answers', async (t) => {
  const f = await fixture(t);
  let pending = (await f.command('start', '--languages', 'en')).pending, base;
  for (let index = 0; index < 4; index++) {
    const result = await runForkProbe(f.directory, f.session, pending.id, {}, f.dependencies);
    assert.equal(result.accepted, true, result.reason); assert.equal(result.sample.numbers, undefined);
    assert.ok(!JSON.stringify(result).includes(integers));
    assert.equal(result.sample.fork.cleanedUp, true); assert.equal(result.sample.fork.cacheHit, true);
    base ||= result.sample.fork.snapshot.id;
    assert.equal(result.sample.fork.snapshot.id, base);
    if (index < 3) pending = (await f.command('acknowledge', '--alert', result.notification.id)).pending;
    else assert.equal(result.taskHalt.retryCount, 3);
  }
  assert.equal(f.counts().createdBase, 1); assert.equal(f.counts().closed, 4);
  assert.equal(f.generatedHistories.length, 4);
  for (const history of f.generatedHistories) assert.deepEqual(history, f.initialHistory);
  const childCalls = f.calls.filter((c) => c.method === 'thread/fork' && c.params.ephemeral);
  assert.equal(childCalls.length, 4);
  for (const call of childCalls) { assert.equal(call.params.threadId, base); assert.equal(call.params.lastTurnId, 'frozen-turn'); assert.equal(call.params.path, undefined); }
  assert.deepEqual(f.threads.get(f.session).history, f.initialHistory);
  const job = JSON.parse(await readFile(cleanupPath(f.directory, base), 'utf8'));
  assert.equal(job.status, 'pending');
  await cleanSnapshot(f.connect(), job);
  assert.equal(f.threads.has(base), false); assert.equal(f.threads.has(f.session), true);
});

test('normal matching probes also use disposable forks and queue base deletion', async (t) => {
  const f = await fixture(t), { bank, analyzeGlobalOutputs } = await loadArtifacts();
  const expected = analyzeGlobalOutputs([{ text: integers, expected_count: 300 }], bank).results[0].model;
  const pending = (await f.command('start', '--expected', expected)).pending;
  const result = await runForkProbe(f.directory, f.session, pending.id, {}, f.dependencies);
  assert.equal(result.accepted, true); assert.equal(result.confirmation, null);
  const state = await readState(f.directory, f.session);
  assert.equal(state.forkSnapshot, null); assert.equal(state.probeRun, null);
  assert.equal(JSON.parse(await readFile(cleanupPath(f.directory, result.sample.fork.snapshot.id), 'utf8')).status, 'pending');
});

test('untrusted guard or malformed fork output becomes a gap, never a main-context fallback', async (t) => {
  for (const fail of ['trust', 'format']) {
    const f = await fixture(t), pending = (await f.command('start')).pending;
    const deps = { ...f.dependencies, ...(fail === 'trust' ? { enforceTrust: async () => { throw Error('untrusted'); } } : { generate: async () => ({ text: '[0,1]' }) }) };
    const result = await runForkProbe(f.directory, f.session, pending.id, {}, deps);
    assert.equal(result.accepted, false); assert.equal(result.agentAction, 'report_coverage_gap');
    const state = await readState(f.directory, f.session);
    assert.equal(state.samples.length, 0); assert.equal(state.missed, 1); assert.equal(state.forkSnapshot, null); assert.equal(state.probeRun, null);
  }
});

test('the public CLI rejects manual numeric submissions', async (t) => {
  const f = await fixture(t), pending = (await f.command('start')).pending;
  await assert.rejects(() => f.command('submit', '--challenge', pending.id, '--numbers', integers), /In-context.*disabled/);
  assert.equal((await readState(f.directory, f.session)).samples.length, 0);
});

test('cleanup refuses source task, changed base, and bases with new descendants', async () => {
  const job = { purpose: 'modeltrace-temporary-base', snapshot: { id: 'base', sourceSession: 'source', path: '/base', sourceTurn: 't' } };
  for (const variant of ['source', 'changed', 'descendants']) {
    const calls = [], current = structuredClone(job);
    if (variant === 'source') current.snapshot.id = 'source';
    const client = { request: async (method) => {
      calls.push(method);
      if (method === 'thread/read') return { thread: { id: 'base', forkedFromId: 'source', path: '/base' } };
      if (method === 'thread/turns/list') return { data: [{ id: variant === 'changed' ? 'new' : 't', status: 'completed' }] };
      if (method === 'thread/list') return { data: ['new-child'] };
      throw Error('Delete must not be called');
    } };
    await assert.rejects(() => cleanSnapshot(client, current));
    assert.ok(!calls.includes('thread/delete'));
  }
});

test('early completion notifications and observed cached tokens are retained; tools invalidate a probe', async () => {
  for (const toolAttempt of [false, true]) {
    const client = { listeners: new Set(), request: async (method) => {
      if (method !== 'turn/start') return {};
      const emit = (method, params) => { for (const f of client.listeners) f({ method, params: { threadId: 'fork', ...params } }); };
      emit('thread/tokenUsage/updated', { turnId: 't', tokenUsage: { last: { inputTokens: 5000, cachedInputTokens: 4000 } } });
      if (toolAttempt) emit('item/started', { item: { type: 'commandExecution' } });
      emit('item/completed', { item: { type: 'agentMessage', phase: 'final_answer', text: integers } });
      emit('turn/completed', { turn: { id: 't', status: 'completed' } });
      return { turn: { id: 't' } };
    } };
    const action = () => generateProbe(client, 'fork', { expiresAt: Date.now() + 5000, language: 'en', count: 300 });
    if (toolAttempt) await assert.rejects(action, /attempted a tool/);
    else { const result = await action(); assert.equal(result.text, integers); assert.equal(result.usage.cachedInputTokens, 4000); }
    assert.equal(client.listeners.size, 0);
  }
});

test('token usage inherited from a previous turn is never reported as the probe cache hit', async () => {
  const client = { listeners: new Set(), request: async (method) => {
    if (method !== 'turn/start') return {};
    for (const listener of client.listeners) {
      listener({ method: 'thread/tokenUsage/updated', params: { threadId: 'fork', turnId: 'source-turn', tokenUsage: { last: { inputTokens: 9000, cachedInputTokens: 8000 } } } });
      listener({ method: 'item/completed', params: { threadId: 'fork', turnId: 'new-turn', item: { type: 'agentMessage', text: integers, phase: 'final_answer' } } });
      listener({ method: 'turn/completed', params: { threadId: 'fork', turn: { id: 'new-turn', status: 'completed' } } });
    }
    return { turn: { id: 'new-turn' } };
  } };
  const result = await generateProbe(client, 'fork', { expiresAt: Date.now() + 5000, language: 'en', count: 300 });
  assert.equal(result.usage, null);
});

const backgroundEvent = (f, extra = {}) => ({ session_id: f.session, hook_event_name: 'PostToolUse', turn_id: 'work-turn', tool_use_id: randomUUID(), ...extra });
const managementEvent = (f, command) => backgroundEvent(f, { tool_name: 'exec_command', tool_input: { cmd: `node guard.mjs ${command}` } });
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };

test('only probe-trigger hooks are native async; tool blocking and cancellation remain synchronous', async () => {
  const config = JSON.parse(await readFile(path.join(ROOT, 'hooks/hooks.json'), 'utf8'));
  for (const [event, groups] of Object.entries(config.hooks)) {
    for (const group of groups) for (const handler of group.hooks) {
      assert.equal(handler.async === true, BACKGROUND_EVENTS.includes(event), event);
      assert.equal(handler.command.includes("main(['background-hook'])"), BACKGROUND_EVENTS.includes(event), event);
      if (handler.async) assert.equal(handler.timeout, BACKGROUND_TIMEOUT_SECONDS);
      else assert.ok(handler.timeout <= 5);
    }
  }
  assert.ok(config.hooks.Interrupt[0].hooks[0].timeout <= 3);
});

test('slow normal background probes allow work and final answers, deduplicate parallel hooks, and return no context', { timeout: 10000 }, async (t) => {
  const f = await fixture(t), { bank, analyzeGlobalOutputs } = await loadArtifacts();
  const expected = analyzeGlobalOutputs([{ text: integers, expected_count: 300 }], bank).prediction;
  const start = await f.command('start', '--expected', expected);
  assert.ok(!start.challengeContext.includes('probe --session'));
  const started = deferred(), finish = deferred();
  const dependencies = { ...f.dependencies, generate: async (...args) => { started.resolve(); await finish.promise; return f.dependencies.generate(...args); } };
  const worker = handleBackgroundHook(managementEvent(f, 'start'), f.directory, {}, dependencies);
  let output;
  try {
    await started.promise;
    const before = await readState(f.directory, f.session);
    assert.equal(before.workTools, 0); assert.equal(before.probeRun.challenge, start.pending.id);
    assert.equal(summarize(before, f.directory).background.running, true);
    const duplicates = await Promise.all(Array.from({ length: 8 }, () => handleBackgroundHook(backgroundEvent(f), f.directory, {}, dependencies)));
    for (const result of duplicates) assert.deepEqual(result, {});
    assert.deepEqual(await handleHook(backgroundEvent(f, { hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_input: { cmd: 'do-original-work' } }), f.directory), {});
    assert.deepEqual(await handleHook(backgroundEvent(f, { hook_event_name: 'Stop' }), f.directory), {});
    const state = await readState(f.directory, f.session);
    assert.equal(state.issued, 1); assert.equal(state.workTools, 8); assert.equal(state.missed, 0);
  } finally { finish.resolve(); output = await worker; }
  assert.deepEqual(output, {});
  const after = await readState(f.directory, f.session);
  assert.equal(after.samples.length, 1); assert.equal(after.probeRun, null); assert.equal(after.pending, null);
  assert.equal(after.alerts.length, 0); assert.equal(f.counts().createdBase, 1);
  assert.deepEqual(f.threads.get(f.session).history, f.initialHistory);
});

test('background mismatch notifies before retry, then three mismatching retries halt using one frozen base', async (t) => {
  const f = await fixture(t);
  await f.command('start', '--languages', 'en');
  const notification = await handleBackgroundHook(managementEvent(f, 'start'), f.directory, {}, f.dependencies);
  assert.ok(notification.systemMessage.includes(f.model));
  assert.ok(notification.hookSpecificOutput.additionalContext.includes('acknowledge --session'));
  let state = await readState(f.directory, f.session);
  assert.equal(state.confirmation.target, 3); assert.equal(state.confirmation.results.length, 0); assert.equal(state.pending, null);
  const base = state.forkSnapshot.id;
  const work = backgroundEvent(f, { hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_input: { cmd: 'original-work' } });
  assert.equal((await handleHook(work, f.directory)).hookSpecificOutput.permissionDecision, 'deny');
  await handleBackgroundHook(backgroundEvent(f), f.directory, {}, f.dependencies);
  assert.equal(f.generatedHistories.length, 1, 'no retry before visible-notification acknowledgement');
  for (let i = 0; i < 3; i++) {
    const alert = state.alerts.find((a) => !a.acknowledgedAt);
    await f.command('acknowledge', '--alert', alert.id);
    assert.equal((await handleHook(work, f.directory)).hookSpecificOutput.permissionDecision, 'deny', 'ack does not resume original work');
    const output = await handleBackgroundHook(managementEvent(f, 'acknowledge'), f.directory, {}, f.dependencies);
    assert.ok(output.systemMessage); assert.ok(!JSON.stringify(output).includes(integers));
    state = await readState(f.directory, f.session);
    assert.equal(state.confirmation.results.length, i + 1);
    assert.equal(state.samples.at(-1).fork.snapshot.id, base);
  }
  assert.equal(state.taskHalt.retryCount, 3); assert.equal(state.pending, null);
  assert.equal((await waitForConfirmation(f.directory, f.session, state.confirmation.id)).agentAction, 'stop_and_notify_user');
  assert.equal(f.counts().createdBase, 1); assert.equal(f.generatedHistories.length, 4);
  for (const history of f.generatedHistories) assert.deepEqual(history, f.initialHistory);
  assert.deepEqual(f.threads.get(f.session).history, f.initialHistory);
});

test('matching background retries advance automatically and release the work guard only after the full batch', async (t) => {
  const f = await fixture(t), { bank, analyzeGlobalOutputs } = await loadArtifacts();
  const classify = (text) => analyzeGlobalOutputs([{ text, expected_count: 300 }], bank).prediction;
  let matching;
  for (let seed = 1; seed < 100; seed++) {
    const text = JSON.stringify(Array.from({ length: 300 }, (_, i) => (i * seed + seed * 17) % 355 + 1));
    if (classify(text) !== classify(integers)) { matching = text; break; }
  }
  assert.ok(matching, 'fixture must offer two distinct predictions in the packaged bank');
  await f.command('start', '--expected', classify(matching));
  await handleBackgroundHook(managementEvent(f, 'start'), f.directory, {}, f.dependencies);
  const before = await readState(f.directory, f.session);
  await f.command('acknowledge', '--alert', before.alerts[0].id);
  const waiting = await waitForConfirmation(f.directory, f.session, before.confirmation.id, { timeoutMs: 0 });
  assert.equal(waiting.waiting, true); assert.equal(f.generatedHistories.length, 1, 'wait never runs inference');
  let generated = 0;
  const output = await handleBackgroundHook(managementEvent(f, 'acknowledge'), f.directory, {}, {
    ...f.dependencies, generate: async () => { generated++; return { text: matching }; },
  });
  assert.equal(generated, 3);
  const state = await readState(f.directory, f.session);
  assert.equal(state.confirmation.status, 'completed'); assert.equal(state.confirmation.allMismatch, false); assert.equal(state.taskHalt, null);
  assert.equal(state.samples.length, 4); assert.equal(state.alerts.length, 1);
  assert.equal(f.counts().createdBase, 1);
  assert.ok(output.hookSpecificOutput.additionalContext.includes('background confirmation completed'));
  assert.equal(output.systemMessage, undefined); assert.ok(!JSON.stringify(output).includes(matching));
  assert.deepEqual(await handleHook(backgroundEvent(f, { hook_event_name: 'PreToolUse' }), f.directory), {});
  assert.equal((await waitForConfirmation(f.directory, f.session, before.confirmation.id)).agentAction, 'confirmation_completed');
});

for (const cancel of ['stop', 'Interrupt', 'PreCompact', 'SessionEnd', 'comparison']) test(`background ${cancel} invalidates a late result without alerting or modifying the next checkpoint`, { timeout: 10000 }, async (t) => {
  const f = await fixture(t), started = deferred(), finish = deferred();
  await f.command('start');
  const worker = handleBackgroundHook(managementEvent(f, 'start'), f.directory, {}, {
    ...f.dependencies, generate: async () => { started.resolve(); await finish.promise; return { text: integers }; },
  });
  let output, next;
  try {
    await started.promise;
    if (cancel === 'stop') await f.command('stop');
    else if (cancel === 'comparison') {
      await f.command('configure', '--expected', 'changed-comparison');
      await handleHook(backgroundEvent(f), f.directory);
      next = (await readState(f.directory, f.session)).pending;
    } else await handleHook(backgroundEvent(f, { hook_event_name: cancel }), f.directory);
  } finally { finish.resolve(); output = await worker; }
  assert.deepEqual(output, {});
  const state = await readState(f.directory, f.session);
  assert.equal(state.samples.length, 0); assert.equal(state.alerts.length, 0); assert.equal(state.missed, 1);
  assert.equal(state.probeRun, null); assert.equal(state.forkSnapshot, null); assert.equal(state.taskHalt, null);
  if (next) assert.deepEqual(state.pending, next);
  if (cancel === 'Interrupt' || cancel === 'SessionEnd') {
    await handleBackgroundHook(backgroundEvent(f), f.directory, {}, f.dependencies);
    assert.equal(f.counts().createdBase, 1, 'late tool completion cannot restart a cancelled runtime');
  }
});

test('background failures report a gap, never a mismatch or a foreground probe fallback', async (t) => {
  const f = await fixture(t); await f.command('start');
  const output = await handleBackgroundHook(managementEvent(f, 'start'), f.directory, {}, {
    ...f.dependencies, generate: async () => { throw Error('fixture transport failure'); },
  });
  assert.ok(output.systemMessage); assert.ok(output.hookSpecificOutput.additionalContext.includes('monitoring gap'));
  const state = await readState(f.directory, f.session);
  assert.equal(state.samples.length, 0); assert.equal(state.missed, 1); assert.equal(state.taskHalt, null);
});

test('probe processes, subagents and other tasks cannot start background inference or update the parent state', async (t) => {
  const f = await fixture(t); await f.command('start');
  const original = await readState(f.directory, f.session);
  for (const [event, env] of [[backgroundEvent(f), { MODELTRACE_PROBE_PROCESS: '1' }], [backgroundEvent(f, { agent_id: 'child' }), {}], [backgroundEvent(f, { parent_session_id: 'other' }), {}], [backgroundEvent(f), { CODEX_THREAD_ID: 'other' }]]) {
    assert.deepEqual(await handleBackgroundHook(event, f.directory, env, f.dependencies), {});
  }
  assert.deepEqual(await readState(f.directory, f.session), original); assert.equal(f.counts().createdBase, 0);
});

test('runtime readiness requires loaded trusted native async hooks and a synchronous work guard from one source', async () => {
  const config = JSON.parse(await readFile(path.join(ROOT, 'hooks/hooks.json'), 'utf8'));
  const hooks = Object.entries(config.hooks).map(([name, groups]) => ({
    eventName: name[0].toLowerCase() + name.slice(1), ...groups[0].hooks[0], async: groups[0].hooks[0].async || false,
    enabled: true, trustStatus: 'trusted', pluginId: 'modeltrace-guard@fixture', handlerType: 'command', sourcePath: path.join(ROOT, 'hooks/hooks.json'),
  }));
  const client = (items) => ({ request: async () => ({ data: [{ hooks: items }] }) });
  await requireTrustedGuard(client(hooks), ROOT);
  for (const change of ['sync-probe', 'async-guard', 'untrusted', 'missing']) {
    const broken = structuredClone(hooks);
    if (change === 'sync-probe') broken.find((h) => h.eventName === 'postToolUse').async = false;
    if (change === 'async-guard') broken.find((h) => h.eventName === 'preToolUse').async = true;
    if (change === 'untrusted') broken.find((h) => h.eventName === 'userPromptSubmit').trustStatus = 'modified';
    if (change === 'missing') broken.splice(broken.findIndex((h) => h.eventName === 'sessionStart'), 1);
    await assert.rejects(() => requireTrustedGuard(client(broken), ROOT), /native async/);
  }
});

test('a cancelled or expired background probe never starts an inference turn', async () => {
  let requests = 0;
  const client = { request: async () => { requests++; throw Error('must not call'); } };
  await assert.rejects(() => generateProbe(client, 'fork', { expiresAt: Date.now() - 1 }), /expired before inference/);
  await assert.rejects(() => generateProbe(client, 'fork', { expiresAt: Date.now() + 10000 }, async () => true), /cancelled/);
  assert.equal(requests, 0);
});

test('bounded confirmation wait notices expiry without scoring a missing retry', async (t) => {
  const f = await fixture(t); await f.command('start');
  await handleBackgroundHook(managementEvent(f, 'start'), f.directory, {}, f.dependencies);
  const before = await readState(f.directory, f.session);
  await f.command('acknowledge', '--alert', before.alerts[0].id);
  await withState(f.directory, f.session, (state) => { state.pending.expiresAt = Date.now() + 50; });
  const result = await waitForConfirmation(f.directory, f.session, before.confirmation.id, { timeoutMs: 2000, pollMs: 10 });
  assert.equal(result.waiting, false); assert.equal(result.agentAction, 'report_coverage_gap');
  assert.equal(result.confirmation.status, 'interrupted'); assert.equal(result.confirmation.results.length, 0);
  assert.equal(result.taskHalt, null); assert.equal(result.missedProbes, 1); assert.equal(f.generatedHistories.length, 1);
  await assert.rejects(() => waitForConfirmation(f.directory, f.session, 'wrong-id'), /No matching/);
  await assert.rejects(() => f.command('wait'), /requires --confirmation/);
});

test('cleanup never deletes a base owned by a live retry after the first background hook has exited', async (t) => {
  const f = await fixture(t); await f.command('start');
  await handleBackgroundHook(managementEvent(f, 'start'), f.directory, {}, f.dependencies);
  const state = await readState(f.directory, f.session);
  // An impossible-to-resolve PID is not assumed dead by production code; use a
  // confirmed absent synthetic PID so this exercises the cross-worker branch.
  let deadPid = 999999;
  while (deadPid > 990000 && processAlive(deadPid)) deadPid--;
  assert.equal(processAlive(deadPid), false);
  const filename = cleanupPath(f.directory, state.forkSnapshot.id);
  const job = JSON.parse(await readFile(filename, 'utf8'));
  job.ownerPid = deadPid;
  await writeFile(filename, JSON.stringify(job));
  await withState(f.directory, f.session, (s) => {
    s.confirmation.startedAt = 1;
    s.probeRun = { pid: process.pid, challenge: 'owned-retry' };
  });
  // An invalid executable makes an accidental cleanup connection fail the test.
  assert.deepEqual(await cleanupPending(f.directory, { MODELTRACE_CODEX_PATH: path.join(f.directory, 'must-not-execute') }), []);
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).status, 'active');
});
