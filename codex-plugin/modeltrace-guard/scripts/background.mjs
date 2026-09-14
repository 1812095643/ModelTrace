import { setTimeout as delay } from 'node:timers/promises';
import { pendingAlerts, userNotice } from './alerts.mjs';
import { controlContext, handleHook, notificationContext, submitForkResult } from './guard.mjs';
import { runForkProbe } from './fork-runner.mjs';
import { BACKGROUND_STATE_LOCK, expirePending, processAlive, readState, withState } from './state.mjs';
import { summarize } from './status.mjs';

export const BACKGROUND_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse'];
// One configurable checkpoint may live for at most 1,000,000 seconds. The
// native hook timeout allows that plus transport/cleanup overhead, but each
// real probe still obeys its much shorter individual deadline (180s default).
export const BACKGROUND_TIMEOUT_SECONDS = 1000120;

const injected = (event, context, message) => ({
  hookSpecificOutput: { hookEventName: event, additionalContext: context },
  ...(message ? { systemMessage: message } : {}),
});

async function backgroundNotice(event, directory, session, confirmationId) {
  const observed = await readState(directory, session);
  // Most hooks have nothing to deliver. Avoid an additional lock/fsync for an
  // empty notification; a writer that commits a new alert delivers it itself.
  if (!observed || (!pendingAlerts(observed).some((alert) => alert.lastDeliveryTurn !== (observed.turn || 'no-turn'))
    && !observed.taskHalt && !(confirmationId && observed.confirmation?.id === confirmationId))) return {};
  return withState(directory, session, (state) => {
    const alerts = pendingAlerts(state).filter((alert) => alert.lastDeliveryTurn !== (state.turn || 'no-turn')).slice(0, 5);
    if (alerts.length) {
      for (const alert of alerts) {
        alert.deliveryCount += 1; alert.lastDeliveredAt = Date.now(); alert.lastDeliveryTurn = state.turn || 'no-turn';
      }
      return injected(event, notificationContext(state, directory, alerts), alerts.map(userNotice).join('\n'));
    }
    if (state.taskHalt) return injected(event, controlContext(state, directory));
    if (confirmationId && state.confirmation?.id === confirmationId) {
      if (state.confirmation.status === 'active') return injected(event, controlContext(state, directory));
      const context = state.confirmation.status === 'completed'
        ? 'ModelTrace Guard: background confirmation completed; not all retries mismatched. Explain the retry candidates to the user, then continue the original task if it is still requested.'
        : 'ModelTrace Guard: background confirmation was interrupted; missing results are not matches or mismatches. Report the monitoring gap and follow the current user request.';
      return injected(event, context + '\n' + JSON.stringify(state.confirmation));
    }
    return {};
  }, BACKGROUND_STATE_LOCK);
}

// Called ONLY by command handlers declared async in hooks.json. Awaiting the
// fork here keeps its pipe and lifecycle owned by Codex's background hook,
// never the foreground agent's tool call. No detached inference daemon or API.
export async function handleBackgroundHook(event, directory, env = process.env, dependencies = {}) {
  if (event.agent_id || event.parent_session_id || env.MODELTRACE_PROBE_PROCESS === '1'
    || (env.CODEX_THREAD_ID && event.session_id !== env.CODEX_THREAD_ID)
    || !BACKGROUND_EVENTS.includes(event.hook_event_name)) return {};
  const output = await handleHook(event, directory, undefined, undefined, { background: true });
  // Deliver already-known alerts immediately, without delaying them for a probe.
  if (Object.keys(output).length) return output;
  const deadline = Date.now() + (dependencies.budgetMs ?? (BACKGROUND_TIMEOUT_SECONDS - 60) * 1000);
  let confirmationId = null;
  for (let count = 0; count < 100; count++) {
    const state = await readState(directory, event.session_id);
    if (!state?.enabled || state.taskHalt || state.compacting || state.runtimeEndedAt || state.runtimePaused
      || !state.pending || pendingAlerts(state).length || (state.probeRun && processAlive(state.probeRun.pid))) break;
    // Extremely long configured retries continue in a later background hook;
    // never exceed the host's timeout or change a checkpoint's deadline.
    if (state.pending.expiresAt > deadline) break;
    confirmationId ||= state.pending.confirmationId || null;
    const result = await runForkProbe(directory, event.session_id, state.pending.id, env,
      { ...dependencies, submit: dependencies.submit || submitForkResult, background: true });
    if (result.skipped || result.cancelled) break;
    if (!result.accepted) return injected(event.hook_event_name,
      `ModelTrace Guard: the background checkpoint failed. Tell the user about this monitoring gap, not a model mismatch. Do not generate probe numbers in the main task. Reason: ${JSON.stringify(result.reason)}`,
      'ModelTrace Guard: 后台检测未完成，请查看状态。');
    if (result.notification || result.taskHalt) break;
    // Normal matches are completely silent. Only an existing confirmation may
    // advance directly to its next retry, still using the same frozen baseline.
    if (result.confirmation?.status !== 'active') break;
    confirmationId = result.confirmation.id;
  }
  return backgroundNotice(event.hook_event_name, directory, event.session_id, confirmationId);
}

// Foreground waiting is reserved for an actionable mismatch, when original
// work is deliberately paused. This is read-only except expiry bookkeeping;
// it never starts inference and returns within 30s even if the worker is lost.
export async function waitForConfirmation(directory, session, id, { timeoutMs = 30000, pollMs = 200 } = {}) {
  if (!id) throw new Error('wait requires --confirmation <current confirmation id>');
  const deadline = Date.now() + Math.min(30000, Math.max(0, timeoutMs));
  let state;
  do {
    state = await readState(directory, session);
    if (state?.confirmation?.id !== id) throw new Error('No matching confirmation batch');
    if (state.pending && Date.now() >= state.pending.expiresAt) {
      await withState(directory, session, (current) => { expirePending(current, Date.now()); });
      state = await readState(directory, session);
    }
    if (!state.enabled || state.taskHalt || pendingAlerts(state).length || state.confirmation.status !== 'active' || Date.now() >= deadline) break;
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  } while (true);
  return { ...summarize(state, directory), waiting: state.enabled && state.confirmation.status === 'active' && !pendingAlerts(state).length,
    notificationContext: notificationContext(state, directory), controlContext: controlContext(state, directory),
    agentAction: state.taskHalt ? 'stop_and_notify_user' : pendingAlerts(state).length ? 'notify_user_now'
      : state.confirmation.status === 'active' ? 'wait_for_background_retries'
        : state.confirmation.status === 'completed' ? 'confirmation_completed' : 'report_coverage_gap' };
}
