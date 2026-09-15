import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAppServer } from './app-server-client.mjs';
import { prepareCacheTransport } from './cache-transport.mjs';
import { freezeSnapshot, publicSnapshot, removeSnapshot, verifySnapshot } from './fork-snapshot.mjs';
import { forkPrompt } from './prompts.mjs';
import { BACKGROUND_STATE_LOCK, abandon, digest, interruptConfirmation, processAlive, readState, record, schedule, setCodexTaskName, withState } from './state.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function forkParameters(snapshot, cacheTransport = null) {
  return {
    // Native ephemeral forks reject deferGoalContinuation. The transport only
    // permits the one turn explicitly requested for this disposable fork.
    threadId: snapshot.id, lastTurnId: snapshot.sourceTurn, ephemeral: true, excludeTurns: true,
    model: snapshot.model, modelProvider: snapshot.provider, cwd: snapshot.cwd,
    ...(snapshot.effort || cacheTransport ? { config: {
      ...(snapshot.effort ? { model_reasoning_effort: snapshot.effort } : {}),
      ...(cacheTransport ? { openai_base_url: cacheTransport.url } : {}),
    } } : {}),
  };
}

export function verifyFork(response, snapshot) {
  if (!response?.thread?.ephemeral || !response.thread.id || response.thread.path || response.thread.id === snapshot.sourceSession || response.thread.id === snapshot.id || response.thread.forkedFromId !== snapshot.id) throw new Error('Codex did not create a disposable in-memory fork');
  if (response.model !== snapshot.model || response.modelProvider !== snapshot.provider || (snapshot.effort && response.reasoningEffort !== snapshot.effort)) throw new Error('Codex fork model/provider/reasoning settings differ from the source snapshot');
  if (response.cwd !== snapshot.cwd || response.thread.cwd !== snapshot.cwd) throw new Error('Codex fork workspace differs from the source snapshot');
  return {
    model: response.model, provider: response.modelProvider, effort: response.reasoningEffort ?? null, cwd: response.cwd,
    serviceTier: response.serviceTier ?? null,
    instructionSourcesSha256: digest(JSON.stringify(response.instructionSources || [])),
  };
}

export async function prepareProbeFork(client, snapshot, cacheTransport = null) {
  const response = await client.request('thread/fork', forkParameters(snapshot, cacheTransport), 30000);
  const effective = verifyFork(response, snapshot);
  cacheTransport?.authorize(response.thread.id);
  return { response, effective };
}

export async function requireTrustedGuard(client, cwd) {
  const listing = await client.request('hooks/list', { cwds: [cwd] });
  const hooks = (listing.data || []).flatMap((entry) => entry.hooks || []).filter((hook) =>
    hook.enabled && ['trusted', 'managed'].includes(hook.trustStatus)
    && /^modeltrace-guard(?:@|$)/.test(hook.pluginId || '') && hook.handlerType === 'command'
    && (!hook.matcher || hook.matcher === '.*'));
  const candidates = hooks.filter((hook) => hook.eventName === 'preToolUse' && hook.async === false);
  const expected = digest(await readFile(path.join(ROOT, 'scripts', 'guard.mjs')));
  for (const hook of candidates) {
    try {
      const installed = path.resolve(path.dirname(hook.sourcePath), '../scripts/guard.mjs');
      const backgroundReady = ['sessionStart', 'userPromptSubmit', 'postToolUse'].every((event) =>
        hooks.some((item) => item.sourcePath === hook.sourcePath && item.eventName === event && item.async === true && item.command.includes('background-hook')));
      if (backgroundReady && digest(await readFile(installed)) === expected && hook.command.includes('guard.mjs')) return;
    } catch {}
  }
  throw new Error('The synchronous PreToolUse guard and native async background hooks must be loaded and trusted. Reload the updated plugin, use a Codex runtime with async hook support, and review ModelTrace Guard in /hooks before probing.');
}

export async function forkDoctor(session, directory, env = process.env) {
  const client = await openAppServer(env); let snapshot;
  try {
    snapshot = await freezeSnapshot(client, session, directory);
    await verifySnapshot(client, snapshot);
    const { effective } = await prepareProbeFork(client, snapshot);
    let toolsBlocked = false, hookError = null;
    try { await requireTrustedGuard(client, snapshot.cwd); toolsBlocked = true; } catch (error) { hookError = error.message; }
    return { forkAvailable: true, ready: toolsBlocked, toolsBlocked, backgroundHooksReady: toolsBlocked, hookError, snapshot: publicSnapshot(snapshot), effective, inferenceRequests: 0, cleanup: 'Temporary inference process closed; native base deletion queued with an ownership check' };
  } finally { try { await client.close(); } finally { await removeSnapshot(directory, snapshot); } }
}

// Exported for protocol fixtures: notifications may arrive before turn/start's
// response. Keep the listener installed first; never leak raw text to stdout.
export async function generateProbe(client, forkId, pending, isCancelled = async () => false) {
  if (Date.now() >= pending.expiresAt || await isCancelled()) throw new Error('Probe cancelled or expired before inference');
  let resolve, reject, settled = false, finalText = null, otherText = [], turnId;
  const usageByTurn = new Map();
  const completed = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Avoid an unhandled rejection if transport events beat the turn/start reply.
  completed.catch(() => {});
  const fail = (message) => { if (!settled) { settled = true; reject(new Error(message)); } };
  const onMessage = (message) => {
    const p = message.params;
    if (p?.threadId !== forkId) return;
    if (message.method === 'thread/tokenUsage/updated' && typeof p.turnId === 'string') {
      const last = p.tokenUsage?.last;
      if (last && Number.isSafeInteger(last.inputTokens) && last.inputTokens >= 0 && Number.isSafeInteger(last.cachedInputTokens) && last.cachedInputTokens >= 0) usageByTurn.set(p.turnId, {
        inputTokens: last.inputTokens, cachedInputTokens: last.cachedInputTokens,
        outputTokens: last.outputTokens ?? null, cacheWriteInputTokens: last.cacheWriteInputTokens ?? null,
      });
    }
    if (message.method === 'item/started' && !['userMessage', 'agentMessage', 'reasoning'].includes(p.item?.type)) fail('Probe attempted a tool or changed context; no sample accepted');
    if (message.method === 'item/completed' && p.item?.type === 'agentMessage') {
      if (p.item.phase === 'final_answer' || p.item.phase === 'final') finalText = p.item.text;
      else if (!p.item.phase) otherText.push(p.item.text);
    }
    if (message.method === 'turn/completed') {
      if (turnId && p.turn?.id !== turnId) return;
      if (p.turn?.status !== 'completed') return fail('Codex probe turn did not complete');
      if (!settled) { settled = true; resolve(finalText ?? (otherText.length === 1 ? otherText[0] : null)); }
    }
    if (message.method === 'error' && !p.willRetry) fail('Codex probe inference failed; no sample accepted');
  };
  client.listeners.add(onMessage);
  client.exited?.then(() => fail('Codex probe transport exited before completion'));
  const timeout = setTimeout(() => fail('Probe deadline expired'), Math.max(1, pending.expiresAt - Date.now()));
  let checking = false;
  const cancelCheck = setInterval(async () => {
    if (checking || settled) return;
    checking = true;
    try { if (await isCancelled()) fail('Probe cancelled because task monitoring or comparison conditions changed'); }
    catch { fail('Cannot verify probe ownership; no sample accepted'); }
    finally { checking = false; }
  }, 1000);
  try {
    const response = await client.request('turn/start', { threadId: forkId, input: [{ type: 'text', text: forkPrompt(pending.language, pending.count) }] }, Math.max(1, Math.min(15000, pending.expiresAt - Date.now())));
    turnId = response.turn?.id;
    const text = await completed;
    if (typeof text !== 'string') throw new Error('Probe did not return one final text answer');
    return { text, usage: usageByTurn.get(turnId) || null };
  } finally {
    clearTimeout(timeout); clearInterval(cancelCheck); client.listeners.delete(onMessage);
    if (turnId) await client.request('turn/interrupt', { threadId: forkId, turnId }, 1000).catch(() => {});
  }
}

export async function runForkProbe(directory, session, challenge, env = process.env, dependencies = {}) {
  const connect = dependencies.connect || openAppServer;
  const enforceTrust = dependencies.enforceTrust || requireTrustedGuard;
  const generate = dependencies.generate || generateProbe;
  const stateOptions = dependencies.background ? BACKGROUND_STATE_LOCK : undefined;
  const updateState = (callback) => withState(directory, session, callback, stateOptions);
  let client, cacheTransport, snapshot, pending, receipt, text, cleanupConfirmed = false;
  const claimed = await updateState((state) => {
    // Parallel background hooks race for one atomic checkpoint lease. A losing
    // contender must not report an error or cancel the winning worker's batch.
    if (dependencies.background && (!state.enabled || state.taskHalt || !state.pending || state.pending.id !== challenge
      || (state.probeRun && processAlive(state.probeRun.pid)))) return false;
    if (!state.enabled || state.taskHalt || !state.pending || state.pending.id !== challenge) throw new Error('No matching live fork checkpoint');
    if (state.probeRun && processAlive(state.probeRun.pid)) throw new Error('A fork probe is already running for this task');
    if (Date.now() >= state.pending.expiresAt) throw new Error('Checkpoint has expired');
    if (state.pending.confirmationId && !state.forkSnapshot) throw new Error('Retry snapshot is missing; a fresh snapshot cannot replace it');
    state.probeRun = { pid: process.pid, challenge, startedAt: Date.now() };
    pending = structuredClone(state.pending); snapshot = state.forkSnapshot;
    return true;
  });
  if (!claimed) return { skipped: true };
  try {
    client = await connect(env);
    if (!snapshot) {
      snapshot = await freezeSnapshot(client, session, directory);
      await updateState((state) => {
        if (!state.enabled || state.pending?.id !== challenge || state.pending.epoch !== pending.epoch) throw new Error('Checkpoint changed before snapshot capture');
        if (state.model && state.model !== snapshot.model) throw new Error('Source task model metadata differs from the active hook model; wait for task metadata to synchronize');
        if (!state.model) { state.model = snapshot.model; if (state.expectedSource === 'auto') state.expected = state.model; }
        setCodexTaskName(state, snapshot.sourceTaskName);
        state.forkSnapshot = snapshot;
        record(state, 'fork_snapshot_frozen', Date.now(), publicSnapshot(snapshot));
      });
    }
    await verifySnapshot(client, snapshot);
    cacheTransport = await prepareCacheTransport(client, snapshot, env);
    const { response: fork, effective } = await prepareProbeFork(client, snapshot, cacheTransport);
    await enforceTrust(client, snapshot.cwd);
    await updateState((state) => {
      if (!state.enabled || state.pending?.id !== challenge) throw new Error('Checkpoint cancelled');
      if (Date.now() >= state.pending.expiresAt) throw new Error('Checkpoint expired during fork preparation');
      if (state.forkSnapshot.effective && JSON.stringify(state.forkSnapshot.effective) !== JSON.stringify(effective)) throw new Error('Fork settings changed within the retry batch');
      state.forkSnapshot.effective = effective;
      state.forkHealth = { checkedAt: Date.now(), ready: true, boundary: 'persisted_rollout', toolsBlocked: true };
    });
    const generated = await generate(client, fork.thread.id, pending, async () => {
      const state = await readState(directory, session);
      return !state?.enabled || state.taskHalt || state.pending?.id !== challenge || state.epoch !== pending.epoch;
    });
    text = generated.text;
    await client.close(); await cacheTransport?.close(); cleanupConfirmed = true;
    receipt = { mode: 'ephemeral_fork', snapshot: publicSnapshot(snapshot), effective, cleanedUp: true, usage: generated.usage || null,
      cacheHit: generated.usage ? generated.usage.cachedInputTokens > 0 : null, routingScope: 'fork_continuation',
      cacheScope: cacheTransport?.mode || 'native_fork' };
    const result = await dependencies.submit(directory, session, challenge, text, receipt, stateOptions);
    return result;
  } catch (error) {
    const cancelled = await updateState((state) => {
      if (!state.enabled || state.pending?.id !== challenge || state.epoch !== pending.epoch) return true;
      abandon(state, Date.now(), 'fork_probe_failed');
      interruptConfirmation(state, Date.now(), 'fork_probe_failed'); schedule(state, Date.now());
      state.forkHealth = { ready: false, checkedAt: Date.now(), error: error.message };
      record(state, 'fork_probe_failed', Date.now(), { challenge, reason: error.message });
      return false;
    });
    if (cancelled) return { accepted: false, cancelled: true };
    return { accepted: false, reason: error.message, agentAction: 'report_coverage_gap', instruction: 'Tell the user this fork checkpoint failed. Do not generate numbers in the main task or substitute a new API conversation.' };
  } finally {
    try { if (client && !cleanupConfirmed) await client.close(); }
    finally {
      await cacheTransport?.close();
      await updateState(async (state) => {
        if (state.probeRun?.challenge === challenge) state.probeRun = null;
        if (state.confirmation?.status !== 'active' || !state.enabled || state.taskHalt) {
          if (snapshot) state.forkCleanup = { id: snapshot.id, status: 'pending', at: Date.now() };
          await removeSnapshot(directory, snapshot);
          if (state.forkSnapshot?.id === snapshot?.id) state.forkSnapshot = null;
        }
      });
    }
  }
}
