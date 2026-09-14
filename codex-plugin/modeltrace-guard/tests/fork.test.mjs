import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { run, handleHook, loadArtifacts, submitForkResult } from '../scripts/guard.mjs';
import { readState, withState } from '../scripts/state.mjs';
import { runForkProbe, forkParameters, verifyFork, generateProbe } from '../scripts/fork-runner.mjs';
import { cleanSnapshot } from '../scripts/fork-cleanup.mjs';
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
