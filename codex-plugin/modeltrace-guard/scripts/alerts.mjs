import { isMismatch, record } from './state.mjs';

// A candidate mismatch is not automatically a strong difference signal. Keep both
// visible, with different wording, instead of silently discarding weak evidence.
export function queueAlert(state, sample) {
  if (!isMismatch(sample)) return null;
  state.alerts ||= [];
  const existing = state.alerts.find((alert) => alert.id === sample.challenge);
  if (existing) return existing;
  const level = ['difference_signal', 'repeated_difference'].includes(sample.outcome) ? sample.outcome : 'candidate_mismatch';
  const alert = {
    id: sample.challenge, at: sample.at, epoch: sample.epoch, level,
    expected: sample.expected, prediction: sample.prediction, reportedModel: sample.reportedModel,
    language: sample.language, closedSetWeight: sample.closedSetWeight, expectedWeight: sample.expectedWeight,
    acknowledgedAt: null, deliveryCount: 0, lastDeliveredAt: null, lastDeliveryTurn: null,
  };
  state.alerts.push(alert);
  record(state, 'model_mismatch_alert', sample.at, { alert: alert.id, level, expected: alert.expected, prediction: alert.prediction });
  return alert;
}

export const pendingAlerts = (state) => (state?.alerts || []).filter((alert) => !alert.acknowledgedAt);

export function userNotice(alert) {
  if (alert.level === 'confirmed_mismatch') return `ModelTrace Guard：首次异常后的 ${alert.retryCount} 次复测全部与预期模型 ${JSON.stringify(alert.expected)} 不一致。复测第一候选依次为 ${JSON.stringify(alert.predictions || [alert.prediction])}。已要求智能体立刻停止原任务并告知用户，等待用户决定后续操作。`;
  const strength = { candidate_mismatch: '候选排序不一致，但证据不足', difference_signal: '一次较强的指纹差异线索', repeated_difference: '近期重复的同语言指纹差异线索' }[alert.level];
  return `ModelTrace Guard 提醒：${new Date(alert.at).toISOString()} 的抽样中，预期模型为 ${JSON.stringify(alert.expected)}，指纹第一候选为 ${JSON.stringify(alert.prediction)}（${strength}）。这是未独立校准的实验性结果，不能据此确认模型被替换、降智或厂商作弊；后续匹配也不会抹去本次记录。`;
}

export function acknowledgeAlerts(state, ids, now) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || new Set(ids).size !== ids.length) throw new Error('Provide distinct alert IDs');
  const selected = ids.map((id) => (state.alerts || []).find((alert) => alert.id === id));
  if (selected.some((alert) => !alert)) throw new Error('Unknown alert ID for this task');
  for (const alert of selected) {
    if (alert.acknowledgedAt) continue;
    alert.acknowledgedAt = now;
    // An acknowledgement is the agent's report, not proof of user receipt.
    record(state, 'agent_reported_user_notified', now, { alert: alert.id });
  }
  return { acknowledged: ids, remaining: pendingAlerts(state).length, meaning: 'Agent-reported notification, not independently verified user receipt.' };
}
