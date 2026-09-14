import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LANGUAGES } from './prompts.mjs';
import { compactHistory } from './history.mjs';
import { removeSnapshot } from './fork-snapshot.mjs';

export const DEFAULTS = Object.freeze({
  mode: 'tools', toolMin: 8, toolMax: 16, retryCount: 3,
  pendingSeconds: 180,
  languages: ['zh', 'en'],
});
export const WARNING = 'Closed-set fingerprint evidence for a fork continuation; not backend authentication. Frozen-rollout and multilingual error rates have not been independently measured.';
export const digest = (value) => createHash('sha256').update(value).digest('hex');

export function validateConfig(patch = {}, previous = DEFAULTS) {
  // Migrate retired time triggers and probe-count limits without altering evidence.
  const { secondsMin, secondsMax, maxPerTurn, maxPerSession, ...base } = previous;
  const config = { ...DEFAULTS, ...base, mode: 'tools', ...patch };
  for (const key of Object.keys(config)) if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`Unknown frequency option: ${key}`);
  if (config.mode !== 'tools') throw new Error('Only tool-call frequency is supported; use --tool-min and --tool-max');
  if (!Array.isArray(config.languages) || !config.languages.length || new Set(config.languages).size !== config.languages.length || config.languages.some((code) => !LANGUAGES.includes(code))) throw new Error(`languages must be distinct codes from ${LANGUAGES.join(',')}`);
  for (const key of Object.keys(DEFAULTS).filter((key) => !['mode', 'languages'].includes(key))) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1 || config[key] > 1000000) throw new Error(`${key} must be an integer in 1..1000000`);
  }
  if (config.toolMin > config.toolMax) throw new Error('Minimum interval exceeds maximum');
  if (config.retryCount > 100) throw new Error('retryCount must be an integer in 1..100');
  return config;
}

export function newState(session, now = Date.now()) {
  return {
    schema: 2, session, enabled: false, createdAt: now, config: { ...DEFAULTS }, taskName: null, workspaceName: null,
    epoch: 0, model: null, expected: null, expectedSource: 'auto', turn: null,
    issued: 0, turnIssued: 0, workTools: 0, lastHookAt: null, hooksSeen: 0,
    lastSampleAt: null, maxObservedGapSeconds: 0, missed: 0, pending: null,
    seenTools: [], retiredTurns: [], stopTurn: null, forceProbe: false, samples: [], events: [], alerts: [],
    nextTools: null, nextAt: null, lastOutcome: 'not_started', confirmation: null, taskHalt: null,
    samplingMode: 'fork', forkSnapshot: null, probeRun: null, runtimeStartedAt: null, lastWorkHookAt: null, runtimeEndedAt: null,
    runtimePaused: false, lastBackgroundHookAt: null,
  };
}

export function record(state, type, now, details = {}) {
  state.events.push({ at: now, epoch: state.epoch, type, ...details });
}

export function setTaskName(state, name, now = Date.now()) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('任务名称需为 1–120 个字符，不能包含换行或控制字符');
  const clean = name.trim();
  if (state.taskName !== clean) {
    state.taskName = clean;
    record(state, 'task_name_changed', now, { name: clean });
  }
}

export function workspaceName(cwd) {
  if (typeof cwd !== 'string' || cwd.length > 4096 || /[\x00-\x1f\x7f]/.test(cwd)) return null;
  return cwd.split(/[\\/]/).filter(Boolean).at(-1)?.slice(0, 120) || null;
}

// Legacy records conflated a missing comparison label with a label absent from
// the reference bank. Clarify presentation without modifying historical evidence.
export function displayOutcome(sample) {
  return sample?.outcome === 'unknown_expected_model' && !sample.expected ? 'missing_expected_model' : sample?.outcome;
}

export function publicSample(sample) {
  const { numbers, ...metadata } = sample;
  return { ...metadata, displayOutcome: displayOutcome(sample) };
}

export function currentOutcome(state) {
  return state.lastOutcome === 'budget_paused' ? state.samples.at(-1)?.outcome || 'insufficient_evidence' : state.lastOutcome;
}

export function schedule(state, now, draw = randomInt) {
  state.nextTools = state.workTools + draw(state.config.toolMin, state.config.toolMax + 1);
  state.nextAt = null;
}

export function isDue(state, now) {
  if (state.forceProbe) return true;
  return state.nextTools !== null && state.workTools >= state.nextTools;
}

export function isMismatch(sample) {
  return Boolean(sample.expected && sample.prediction && sample.expected !== sample.prediction && Number.isFinite(sample.expectedWeight)
    && !['missing_expected_model', 'unknown_expected_model'].includes(sample.outcome));
}

export function interruptConfirmation(state, now, reason) {
  if (state.confirmation?.status !== 'active') return;
  state.confirmation.status = 'interrupted';
  state.confirmation.reason = reason;
  state.confirmation.finishedAt = now;
  record(state, 'confirmation_interrupted', now, { confirmation: state.confirmation.id, reason });
}

// The initial mismatch is NOT one of the configured retries. Each accepted
// retry belongs to one immutable comparison segment and cannot spawn a new batch.
export function updateConfirmation(state, sample, checkpoint, now) {
  if (checkpoint.confirmationId) {
    const batch = state.confirmation;
    if (!batch || batch.status !== 'active' || batch.id !== checkpoint.confirmationId) return;
    if (batch.epoch !== sample.epoch || batch.expected !== sample.expected || batch.model !== sample.reportedModel || batch.language !== sample.language || batch.bankSha256 !== sample.bankSha256) {
      interruptConfirmation(state, now, 'comparison_changed'); return;
    }
    if (batch.snapshotSha256 && sample.fork?.snapshot?.sha256 !== batch.snapshotSha256) {
      interruptConfirmation(state, now, 'snapshot_changed'); return;
    }
    if (!sample.expected || !sample.prediction || !Number.isFinite(sample.expectedWeight) || ['missing_expected_model', 'unknown_expected_model'].includes(sample.outcome)) {
      interruptConfirmation(state, now, 'comparison_unavailable'); return;
    }
    batch.results.push({ challenge: sample.challenge, at: sample.at, prediction: sample.prediction, mismatch: isMismatch(sample) });
    record(state, 'confirmation_result', now, { confirmation: batch.id, retryIndex: batch.results.length, target: batch.target, mismatch: isMismatch(sample) });
    if (batch.results.length === batch.target) {
      batch.status = 'completed'; batch.finishedAt = now;
      batch.allMismatch = batch.results.every((result) => result.mismatch);
      record(state, 'confirmation_completed', now, { confirmation: batch.id, target: batch.target, allMismatch: batch.allMismatch });
      if (batch.allMismatch) {
        state.taskHalt = { id: batch.id, at: now, expected: batch.expected, retryCount: batch.target, predictions: batch.results.map((result) => result.prediction), alertId: sample.challenge };
        record(state, 'task_halt_requested', now, { ...state.taskHalt });
      }
    }
    return;
  }
  if (!isMismatch(sample) || state.taskHalt || state.confirmation?.status === 'active') return;
  state.confirmation = {
    id: sample.challenge, status: 'active', startedAt: now, epoch: sample.epoch,
    expected: sample.expected, model: sample.reportedModel, language: sample.language,
    count: checkpoint.count, bankSha256: sample.bankSha256, target: state.config.retryCount, results: [],
    snapshotSha256: sample.fork?.snapshot?.sha256 || null,
  };
  record(state, 'confirmation_started', now, { confirmation: sample.challenge, target: state.config.retryCount, language: sample.language });
}

export function setTurn(state, turn) {
  if (turn && state.turn !== turn) {
    // Background hook processes can reach the state lock out of order. A late
    // completion from a known older turn must not roll model metadata backward.
    if (state.retiredTurns?.includes(turn)) return false;
    const firstBinding = state.turn === null;
    if (!firstBinding) state.retiredTurns = [...(state.retiredTurns || []).slice(-63), state.turn];
    state.turn = turn;
    if (!firstBinding) state.turnIssued = 0;
    state.stopTurn = null;
  }
  return true;
}

export function abandon(state, now, reason) {
  if (!state.pending) return;
  if (state.pending.confirmationId) interruptConfirmation(state, now, reason);
  record(state, 'probe_missed', now, { challenge: state.pending.id, reason });
  state.missed += 1;
  state.pending = null;
  state.lastOutcome = 'coverage_gap';
}

export function segment(state, now, reason, draw = randomInt) {
  abandon(state, now, reason);
  interruptConfirmation(state, now, reason);
  state.epoch += 1;
  state.lastOutcome = 'insufficient_evidence';
  state.forceProbe = true;
  record(state, 'segment_started', now, { reason, model: state.model, expected: state.expected });
  schedule(state, now, draw);
}

export function expirePending(state, now) {
  if (!state.pending) return false;
  // Parallel tool completions may all arrive before the model gets a continuation.
  // Never infer refusal/ignore just from their count.
  if (now >= state.pending.expiresAt) {
    abandon(state, now, 'expired_or_ignored');
    // Do not immediately force another probe: avoid loops if the model is refusing probes.
    schedule(state, now);
    return true;
  }
  return false;
}

export function issue(state, now, draw = randomInt) {
  const batch = state.confirmation?.status === 'active' ? state.confirmation : null;
  if (!state.enabled || state.taskHalt || state.compacting || state.runtimeEndedAt || state.runtimePaused || state.pending || (!batch && !isDue(state, now))) return null;
  // The agent must notify the user and acknowledge the alert before a retry is
  // issued. Retries are bounded by their batch target, not per-turn/task limits.
  if (batch && (state.alerts || []).some((alert) => !alert.acknowledgedAt)) return null;
  state.pending = {
    id: randomUUID(), epoch: state.epoch, model: state.model, expected: state.expected,
    count: batch ? batch.count : draw(292, 333), at: now, expiresAt: now + state.config.pendingSeconds * 1000,
    language: batch ? batch.language : state.config.languages[draw(0, state.config.languages.length)],
    workTools: state.workTools,
    ...(batch ? { confirmationId: batch.id, retryIndex: batch.results.length + 1, retryTarget: batch.target } : {}),
  };
  state.forceProbe = false;
  state.issued += 1;
  state.turnIssued += 1;
  record(state, 'probe_issued', now, { challenge: state.pending.id, count: state.pending.count, language: state.pending.language });
  schedule(state, now, draw);
  return state.pending;
}

// Reject malformed samples before the inherited scorer's permissive parser can alter them.
export function validateNumbers(text, expectedCount) {
  if (typeof text !== 'string' || text.length > 5000 || !/^\s*\[\s*\d+(?:\s*,\s*\d+)*\s*\]\s*$/.test(text)) {
    throw new Error('numbers must be a literal JSON array of integers, without prose or expressions');
  }
  const values = JSON.parse(text);
  if (values.some((value) => !Number.isInteger(value) || value < 1 || value > 355)) throw new Error('Every number must be in 1..355');
  // Natural model counting errors are retained, not manually repaired. Match the bank's lower cutoff.
  if (values.length < Math.max(80, Math.ceil(expectedCount * 0.55)) || values.length > Math.ceil(expectedCount * 1.25)) {
    throw new Error(`Sample length ${values.length} is outside the accepted bounds for ${expectedCount}`);
  }
  return values;
}

export function classifySample(result, expected, previous = []) {
  const candidate = result.results.find((item) => item.model === expected);
  const top = result.results[0];
  let outcome = 'inconclusive';
  if (!expected) outcome = 'missing_expected_model';
  else if (!candidate) outcome = 'unknown_expected_model';
  else if (top.model === expected && top.probability >= 0.5) outcome = 'compatible';
  else if (top.model !== expected && top.probability >= 0.8 && candidate.probability <= 0.15 && top.probability - candidate.probability >= 0.65) outcome = 'difference_signal';
  const recent = [...previous.slice(-2), { prediction: top.model, outcome }];
  if (outcome === 'difference_signal' && recent.filter((sample) => sample.prediction === top.model && ['difference_signal', 'repeated_difference'].includes(sample.outcome)).length >= 2) outcome = 'repeated_difference';
  return { outcome, prediction: top.model, closedSetWeight: top.probability, expectedWeight: candidate?.probability ?? null };
}

export function recentComparable(state, pending) {
  // A same-language hit must also be one of the last TWO physical checkpoints,
  // not a stale matching-language hit from many hours earlier.
  return state.samples.filter((sample) => sample.epoch === state.epoch).slice(-2).filter((sample) => sample.language === pending.language);
}

export function dataDirectory(override, env = process.env) {
  // Stable across plugin reinstalls and the hook / normal-shell environment difference.
  // PLUGIN_DATA is deliberately not used: normal task shell commands may not inherit it.
  return path.resolve(override || env.MODELTRACE_GUARD_DATA || path.join(homedir(), '.codex', 'modeltrace-guard'));
}

export function sessionPath(directory, session) { return path.join(directory, `${digest(session)}.json`); }

export async function readState(directory, session) {
  try {
    const state = JSON.parse(await readFile(sessionPath(directory, session), 'utf8'));
    if (![1, 2].includes(state.schema) || state.session !== session) throw new Error('State schema/session mismatch');
    return state;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function withState(directory, session, callback) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = sessionPath(directory, session);
  const lockname = `${filename}.lock`;
  let lock;
  const deadline = Date.now() + 1200;
  while (!lock) {
    try {
      lock = await open(lockname, 'wx', 0o600);
      await lock.writeFile(JSON.stringify({ pid: process.pid, nonce: randomUUID(), at: Date.now() }));
      await lock.sync();
    }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await reapDeadLock(lockname)) continue;
      if (Date.now() > deadline) throw new Error(`State busy; retry. If no guard command is running, remove stale lock: ${lockname}`);
      await delay(30);
    }
  }
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const state = await readState(directory, session) || newState(session);
    if (state.samplingMode !== 'fork') {
      abandon(state, Date.now(), 'migrated_to_fork');
      interruptConfirmation(state, Date.now(), 'migrated_to_fork');
      state.samplingMode = 'fork';
      record(state, 'sampling_mode_migrated', Date.now(), { mode: 'fork' });
    }
    const config = validateConfig({}, state.config);
    if (JSON.stringify(config) !== JSON.stringify(state.config) || state.lastOutcome === 'budget_paused') {
      const previous = state.config;
      const previousOutcome = state.lastOutcome;
      state.lastOutcome = currentOutcome(state);
      state.config = config; state.nextAt = null;
      delete state.budgetNoticeSent;
      record(state, 'configuration_migrated', Date.now(), { previous, config: { ...config }, previousOutcome });
    }
    const result = await callback(state);
    if (state.forkSnapshot && (!state.probeRun || !processAlive(state.probeRun.pid))
      && (!state.enabled || state.taskHalt || (state.confirmation?.status !== 'active' && !state.pending))) {
      state.forkCleanup = { id: state.forkSnapshot.id, status: 'pending', at: Date.now() };
      await removeSnapshot(directory, state.forkSnapshot); state.forkSnapshot = null;
    }
    await compactHistory(state, directory);
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(state, null, 2) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, filename);
    return result;
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await lock.close();
    await unlink(lockname);
  }
}

export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

export async function reapDeadLock(filename) {
  let bytes, owner;
  try { bytes = await readFile(filename, 'utf8'); owner = JSON.parse(bytes); } catch { return false; }
  // No age-only stealing. Empty/legacy locks and inaccessible PIDs are uncertain.
  if (typeof owner.nonce !== 'string' || !Number.isSafeInteger(owner.pid) || processAlive(owner.pid)) return false;
  const claimName = `${filename}.reap-${digest(bytes)}`;
  let claim;
  try { claim = await open(claimName, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  try {
    // One reaper per old lease. Recheck after claiming, so a new owner's lease
    // cannot be removed by a contender that observed the previous dead owner.
    if (await readFile(filename, 'utf8').catch(() => null) !== bytes) return false;
    await unlink(filename); return true;
  } finally { await claim.close(); await unlink(claimName); }
}
