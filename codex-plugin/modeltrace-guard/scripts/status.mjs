import { WARNING, currentOutcome, displayOutcome, processAlive, publicSample, sessionPath, validateConfig } from './state.mjs';
import { pendingAlerts } from './alerts.mjs';
import { historyCount } from './history.mjs';
import { publicSnapshot } from './fork-snapshot.mjs';

export function summarize(state, directory, now = Date.now()) {
  if (!state) return { enabled: false, status: 'not_started', warning: WARNING };
  const pendingExpired = state.pending && now >= state.pending.expiresAt;
  const boundary = Math.max(state.runtimeStartedAt || 0, state.enabledAt || state.startedAt || state.createdAt);
  const workHookAge = state.lastWorkHookAt ? now - state.lastWorkHookAt : null;
  const workHookObserved = !state.runtimeEndedAt && state.lastWorkHookAt >= boundary && workHookAge !== null && workHookAge < 10 * 60 * 1000;
  const backgroundObserved = Boolean(!state.runtimeEndedAt && state.lastBackgroundHookAt && state.lastBackgroundHookAt >= boundary);
  const hookObserved = workHookObserved && backgroundObserved;
  const hookState = state.runtimeEndedAt ? 'session_ended' : state.lastWorkHookAt >= boundary && workHookAge !== null
    ? (workHookObserved ? (backgroundObserved ? 'recent_work_observed' : 'awaiting_background_hook') : 'idle') : 'awaiting_work_tool';
  const latestSample = state.samples.at(-1);
  const outcome = currentOutcome(state);
  const fingerprintDisplayStatus = latestSample?.outcome === outcome ? displayOutcome(latestSample) : outcome;
  const status = state.taskHalt ? 'task_halted' : !state.enabled ? 'disabled' : pendingExpired ? 'coverage_gap' : state.pending ? 'awaiting_sample' : !hookObserved ? (hookState === 'idle' ? 'waiting_for_work_tool' : 'hooks_unverified') : state.confirmation?.status === 'active' ? 'confirming_mismatch' : fingerprintDisplayStatus;
  const startedAt = state.startedAt || state.createdAt;
  const fallbackDate = new Date(startedAt).toLocaleString('zh-CN', { hour12: false });
  return {
    enabled: state.enabled, status, fingerprintStatus: outcome, fingerprintDisplayStatus,
    taskName: state.taskName || null, codexTaskName: state.codexTaskName || null,
    displayName: state.taskName || state.codexTaskName || `未命名任务${state.workspaceName ? `（${state.workspaceName}）` : ''} · ${fallbackDate}`,
    workspaceName: state.workspaceName || null, startedAt, enabledAt: state.enabledAt || state.startedAt || null,
    reportedModel: state.model, expectedModel: state.expected, expectedSource: state.expectedSource,
    epoch: state.epoch, frequency: validateConfig({}, state.config), hookObserved, hookState,
    runtimeStartedAt: state.runtimeStartedAt || null, lastWorkHookAt: state.lastWorkHookAt || null,
    samplingMode: state.samplingMode || 'legacy_in_context', snapshot: publicSnapshot(state.forkSnapshot), forkHealth: state.forkHealth || null,
    executionMode: 'async_hooks', lastBackgroundHookAt: state.lastBackgroundHookAt || null,
    background: { observed: backgroundObserved,
      running: Boolean(state.probeRun && processAlive(state.probeRun.pid)), challenge: state.probeRun?.challenge || null,
      startedAt: state.probeRun?.startedAt || null },
    forkCleanup: state.forkCleanup || null,
    confirmation: state.confirmation || null, taskHalt: state.taskHalt || null,
    lastHookAt: state.lastHookAt, probesIssued: state.issued, probesAccepted: historyCount(state, 'samples'),
    missedProbes: state.missed, pendingExpired: Boolean(pendingExpired), pending: state.pending,
    observedWorkTools: state.workTools, nextToolCheckpoint: state.nextTools, nextTimeCheckpoint: null,
    secondsSinceLastProbe: state.startedAt ? Math.max(0, (now - (state.lastSampleAt || state.startedAt)) / 1000) : null,
    maxObservedGapSeconds: state.maxObservedGapSeconds,
    differenceSignals: (state.history?.samples?.differenceSignals || 0) + state.samples.filter((p) => ['difference_signal', 'repeated_difference'].includes(p.outcome)).length,
    mismatchAlerts: historyCount(state, 'alerts'), pendingNotifications: pendingAlerts(state).length,
    notifications: (state.alerts || []).slice(-5),
    latest: state.samples.slice(-3).map(publicSample),
    stateFile: sessionPath(directory, state.session), warning: WARNING,
    coverageNote: 'Normal checkpoints use work-tool counts only, with no per-turn or task-total probe limit. Mismatch retries are consecutive and bounded by retryCount. Only sampled continuations are observed.',
  };
}
