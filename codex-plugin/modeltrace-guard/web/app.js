'use strict';
const $ = (id) => document.getElementById(id);
// Fragment is not sent in HTTP requests or referrers. Do not persist this local
// capability in cookies/storage or attach it to any external request.
const access = new URLSearchParams(location.hash.slice(1));
const token = access.get('token') || '';
let selected = access.get('session') || '', snapshot = null, dirty = false, loading = false, editingSession = '', stopTarget = null, renameTarget = null, bankInfo = null;
let archivePage = null, archiveKind = 'recent', notificationsEnabled = false, alertStreamStarted = false;
const languageNames = { zh: '中文', en: '英语', ja: '日语', ko: '韩语', fr: '法语', de: '德语', es: '西语', pt: '葡语', ru: '俄语', ar: '阿语' };
const outcomes = {
  compatible: ['本次相符', 'good'], inconclusive: ['证据不足', 'warning'], unknown_expected_model: ['预期标签未收录', 'warning'], missing_expected_model: ['未获取预期模型', 'warning'],
  difference_signal: ['单次强差异', 'bad'], repeated_difference: ['重复差异', 'bad'], candidate_mismatch: ['弱候选不一致', 'warning'],
  not_started: ['尚未开启', 'neutral'], disabled: ['已停止监测', 'neutral'], coverage_gap: ['覆盖缺口', 'warning'], hooks_unverified: ['Hooks 尚未验证', 'warning'],
  awaiting_sample: ['后台检测待完成', 'neutral'], insufficient_evidence: ['等待更多证据', 'neutral'],
  task_halted: ['已要求停止任务', 'bad'], confirming_mismatch: ['异常复测中', 'warning'], confirmed_mismatch: ['复测全部不一致', 'bad'],
  waiting_for_work_tool: ['等待工作活动', 'neutral'],
};
const eventNames = { probe_issued: '发出探针', probe_missed: '采样缺口', segment_started: '开始新分段', frequency_configured: '更新采样设置', monitoring_stopped: '停止监测', compaction_started: '上下文压缩', interrupted: '任务被中断', session_ended: '任务结束', budget_paused: '采样数量上限暂停', agent_reported_user_notified: '智能体确认已告知', task_name_changed: '更新显示名称', model_label_observed: '获取声明模型', configuration_migrated: '迁移采样设置', confirmation_started: '开始异常复测', confirmation_result: '完成一次复测', confirmation_completed: '复测完成', confirmation_interrupted: '复测中断', task_halt_requested: '要求停止原任务', task_resumed: '按用户要求恢复任务' };
const reasons = { monitoring_started: '开启监测', reported_model_changed: '声明模型改变', expected_model_changed: '预期模型改变', context_compaction: '上下文压缩', context_cleared: '上下文清空', reference_bank_changed: '参考库改变', expired_or_ignored: '探针过期或未提交', late_submission: '提交超时', monitoring_stopped: '监测停止', user_interrupted: '用户中断', session_ended: '任务结束', stop_continuation_not_completed: '收尾探针未完成', comparison_changed: '复测条件改变', comparison_unavailable: '无法比较预期模型' };
const date = (at) => at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '—';
const time = (at) => at ? new Date(at).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
const txt = (id, text) => { $(id).textContent = text; };
const displayOutcome = (sample) => sample.displayOutcome || (sample.outcome === 'unknown_expected_model' && !sample.expected ? 'missing_expected_model' : sample.outcome);
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function pill(code) { const [label, color] = outcomes[code] || [code, 'neutral']; return element('span', `pill ${color}`, label); }
function inlineEmpty(parent, text) { parent.replaceChildren(element('div', 'empty-inline', text)); }
function showDetail(record, title = '检查点详情') { txt('detail-title', title); txt('detail-body', JSON.stringify(record, null, 2)); $('detail').showModal(); }
async function api(route, body) {
  const response = await fetch(route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(6000) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || `请求失败 (${response.status})`), { status: response.status });
  return result;
}
function modelPair(expected, prediction) {
  const node = element('div', 'alert-models');
  node.append(document.createTextNode(expected || '未知'), element('span', '', ` → ${prediction || '未知'}`));
  return node;
}
function renderConfirmation(state) {
  const batch = state.confirmation, halt = state.taskHalt;
  $('confirmation-panel').hidden = !batch && !halt;
  if (!batch && !halt) return;
  const done = batch?.results.length || 0, mismatches = batch?.results.filter((result) => result.mismatch).length || 0;
  let label, note, color = 'warning';
  if (halt) {
    label = '已要求停止任务'; color = 'bad';
    note = `首次异常后的 ${halt.retryCount} 次复测全部与预期模型 ${halt.expected} 不一致。已要求智能体立刻停止原任务、告知用户并等待后续决定。确认提醒、修改设置或停止监测不会解除此停止指令。`;
  } else if (batch.status === 'active') {
    label = `复测 ${done} / ${batch.target}`;
    const next = state.pendingNotifications ? '等待智能体告知用户并确认提醒' : state.pending ? '后台复测进行中' : '等待下一次后台复测';
    note = `首次异常已记录；已完成 ${done} / ${batch.target} 次复测，其中 ${mismatches} 次不一致。${next}。本组使用${languageNames[batch.language] || batch.language}，当前次数设置 ${state.frequency.retryCount} 仅影响下一组。`;
  } else if (batch.status === 'completed') {
    label = '复测完成'; color = batch.allMismatch ? 'bad' : 'neutral';
    note = batch.allMismatch ? `${batch.target} 次复测全部不一致；用户已要求恢复任务，历史记录保留。` : `${batch.target} 次复测中 ${mismatches} 次不一致，未满足全部不一致的停止条件。首次异常与复测记录均已保留。`;
  } else {
    label = '复测中断';
    note = `已完成 ${done} / ${batch.target} 次。${reasons[batch.reason] || batch.reason || '复测未完成'}；未完成的复测不计为不一致，已有结果保留。`;
  }
  txt('confirmation-status', label); $('confirmation-status').className = `pill ${color}`;
  txt('confirmation-note', note);
}
function renderAlerts(state) {
  const pending = state.pendingNotifications;
  txt('pending-alerts', pending ? `${pending} 条待告知` : '无待告知');
  $('pending-alerts').className = `pill ${pending ? 'warning' : 'neutral'}`;
  if (!state.alerts.length) return inlineEmpty($('alerts'), '尚无不一致提醒 · 不代表全程无差异');
  const rows = state.alerts.slice(-20).reverse().map((alert) => {
    const item = element('article', 'alert-item');
    const head = element('div', 'alert-item-head');
    head.append(element('span', '', date(alert.at)), element('span', `pill ${alert.acknowledgedAt ? 'neutral' : 'warning'}`, alert.acknowledgedAt ? '智能体已确认' : '待智能体告知'));
    const detail = element('button', '', '查看记录 ↗'); detail.type = 'button'; detail.addEventListener('click', () => showDetail(alert));
    item.append(head, modelPair(alert.expected, alert.prediction), element('p', '', (outcomes[alert.level]?.[0] || alert.level) + ' · 未校准，不构成替换证明'), detail);
    return item;
  });
  $('alerts').replaceChildren(...rows);
}
function renderTrace(state) {
  const points = [...state.samples.map((sample) => ({ ...sample, kind: 'sample' })), ...state.events.filter((event) => event.type === 'probe_missed').map((event) => ({ ...event, kind: 'gap' }))].sort((a, b) => a.at - b.at).slice(-80);
  if (!points.length) { $('trace').replaceChildren(element('div', 'trace-empty', '尚无已完成检查点，等待后台检测结果')); txt('trace-range', '暂无已完成检查点'); return; }
  $('trace').replaceChildren(...points.map((point) => {
    const kind = point.kind === 'gap' ? 'gap' : point.outcome === 'compatible' ? 'compatible' : ['difference_signal', 'repeated_difference'].includes(point.outcome) ? 'difference' : 'uncertain';
    const node = element('button', `trace-point ${kind}`); node.type = 'button';
    node.title = `${date(point.at)} · ${point.kind === 'gap' ? '采样缺口' : outcomes[displayOutcome(point)]?.[0] || point.outcome}${point.prediction ? ` · ${point.prediction}` : ''}`;
    node.setAttribute('aria-label', node.title); node.addEventListener('click', () => showDetail(point)); return node;
  }));
  txt('trace-range', `最近 ${points.length} 个检查点 · ${time(points[0].at)} — ${time(points.at(-1).at)}`);
}
function renderHistory(state) {
  const filter = $('filter').value;
  const records = archivePage ? archivePage.rows.map((r) => archiveKind === 'samples' ? { ...r, type: 'sample' } : archiveKind === 'alerts' ? { ...r, type: r.level, model: `${r.expected} → ${r.prediction}` } : r) : [...state.samples.map((s) => ({ ...s, type: 'sample' })), ...state.events.filter((e) => !['probe_scored', 'model_mismatch_alert'].includes(e.type))].sort((a, b) => b.at - a.at);
  const filtered = records.filter((r) => filter === 'all' || (filter === 'gap' ? r.type === 'probe_missed' : r.type === 'sample' && r.expectedWeight !== null && r.expected && r.expected !== r.prediction));
  const rows = filtered.slice(0, 100).map((record) => {
    const row = element('tr');
    const at = element('td', 'table-time'); const button = element('button', 'row-detail', date(record.at)); button.type = 'button'; button.addEventListener('click', () => showDetail(record)); at.append(button);
    const outcome = element('td'); outcome.append(record.type === 'sample' ? pill(displayOutcome(record)) : element('span', `pill ${record.type === 'probe_missed' || record.type === 'budget_paused' ? 'warning' : 'neutral'}`, eventNames[record.type] || record.type));
    const model = element('td', 'table-model'); model.textContent = record.type === 'sample' ? `${record.expected || '当时未获取'} → ${record.prediction || '未知'}` : record.name || record.model || reasons[record.reason] || record.reason || '—';
    row.append(at, outcome, model, element('td', '', languageNames[record.language] || record.language || '—'), element('td', '', `#${record.epoch}`)); return row;
  });
  if (!rows.length) { const row = element('tr'); const cell = element('td', 'empty-inline', '没有符合筛选条件的记录'); cell.colSpan = 5; row.append(cell); rows.push(row); }
  $('rows').replaceChildren(...rows);
  txt('history-note', `显示${archivePage ? '当前页' : '最近'} ${Math.min(filtered.length, 100)} 条筛选记录${archivePage ? ` · 此类共 ${archivePage.total} 条` : ''}。点击时间查看详情；选择完整历史可逐页读取更早记录。`);
  $('history-more').disabled = !archivePage?.nextBefore;
}
function loadForm(state) {
  if (dirty && editingSession === state.id) return;
  editingSession = state.id; dirty = false;
  for (const [key, value] of Object.entries(state.frequency)) {
    if (key === 'languages') { for (const input of $('languages').querySelectorAll('input')) input.checked = value.includes(input.value); }
    else if ($('config-form').elements.namedItem(key)) $('config-form').elements.namedItem(key).value = value;
  }
  txt('settings-status', state.enabled ? '修改后在原任务内生效' : '已停止 · 请在目标任务内重新开启');
}
function render(state) {
  snapshot = state;
  $('empty').hidden = Boolean(state); $('monitoring').hidden = !state;
  $('rename-task').disabled = !state; $('task-identity').hidden = !state;
  if (!state) {
    for (const id of ['expected', 'accepted', 'mismatches', 'missed']) txt(id, '—');
    txt('issued', ''); txt('expected-note', '等待任务模型信息'); txt('sample-note', '只计算实际提交的样本'); txt('alert-note', '强差异与弱候选分开记录'); txt('hook-note', '尚未观察到 hooks');
    txt('runtime', '尚未开启'); $('runtime').className = 'pill neutral'; return;
  }
  const runtime = outcomes[state.status] || [state.status, 'neutral']; txt('runtime', runtime[0]); $('runtime').className = `pill ${runtime[1]}`;
  txt('task-meta', `任务 ID：${state.session} · 开始时间：${date(state.startedAt || state.createdAt)}${state.workspaceName ? ` · 工作目录：${state.workspaceName}` : ''}`);
  txt('expected', state.expectedModel || '尚未获取'); txt('expected-note', !state.expectedModel ? '尚未取得声明标签，暂时无法比较是否一致' : state.expectedSource === 'explicit' ? `用户指定 · 声明 ${state.reportedModel || '尚未获取'}` : '跟随 Codex 声明标签 · 非后端认证');
  txt('accepted', state.probesAccepted); txt('issued', `/ ${state.probesIssued} 已发出`);
  txt('sample-note', `后台快照 fork · ${state.background?.running ? '正在检测' : state.pending ? '已排队' : '无在途探针'}`);
  txt('mismatches', state.mismatchAlerts); txt('alert-note', `${state.differenceSignals} 次强差异 · ${state.pendingNotifications} 条待告知`);
  txt('missed', state.missedProbes + (state.pendingExpired ? 1 : 0));
  txt('hook-note', state.hookObserved ? `最近工作 hook ${time(state.lastWorkHookAt)}` : state.hookState === 'idle' ? `暂无新工作工具 · 最近 ${date(state.lastWorkHookAt)}` : state.hookState === 'awaiting_background_hook' ? '已观察到工作工具，等待后台 hook 验证' : '等待当前运行中的工作工具验证 hooks');
  renderConfirmation(state); renderTrace(state); renderAlerts(state); renderHistory(state);
  txt('fork-note', `${state.snapshot ? `冻结快照 ${state.snapshot.sha256?.slice(0, 12) || '等待确认'}…` : '当前无保留中的基准快照'}${state.forkCleanup ? ` · 最近清理：${({ pending: '待删除', deleted: '已删除', blocked: '需检查' })[state.forkCleanup.status] || state.forkCleanup.status}` : ''}${state.forkCleanup?.error ? ` · ${state.forkCleanup.error}` : ''}`);
  const latest = state.samples.at(-1); $('weights').replaceChildren();
  txt('latest-language', latest ? languageNames[latest.language] || latest.language : '—');
  if (!latest) inlineEmpty($('latest'), '等待第一个有效样本');
  else {
    $('latest').replaceChildren(element('div', 'latest-model', latest.prediction || '未知'), pill(displayOutcome(latest)), element('p', 'latest-caption', `${date(latest.at)} · ${latest.actualCount} / ${latest.requestedCount} 个整数 · 分段 #${latest.epoch}`));
    if (latest.fork) $('latest').append(element('p', 'section-note', latest.fork.usage ? `缓存输入 ${latest.fork.usage.cachedInputTokens} / ${latest.fork.usage.inputTokens} tokens` : 'Codex 未返回本次缓存计数'));
    if (displayOutcome(latest) === 'missing_expected_model') $('latest').append(element('p', 'section-note', '这次采样时尚未获取预期模型，只能列出指纹候选，不能判定一致或不一致。后来获取的标签不会追写进旧样本。'));
    else if (displayOutcome(latest) === 'unknown_expected_model') $('latest').append(element('p', 'section-note', `采样时的预期标签“${latest.expected}”不在参考库中；此处的第一候选来自已有库，并非确认替换。`));
    for (const candidate of latest.top3 || []) {
      const row = element('div', 'weight-row'), meter = element('meter'); meter.min = 0; meter.max = 1; meter.value = candidate.closedSetWeight; meter.setAttribute('aria-label', `${candidate.model} 闭集权重`);
      row.append(element('span', 'weight-label', candidate.model), meter, element('span', 'weight-number', Number(candidate.closedSetWeight).toFixed(3))); $('weights').append(row);
    }
  }
  $('config-fields').disabled = !state.enabled; $('save').disabled = !state.enabled; $('stop').disabled = !state.enabled;
  loadForm(state);
}
function failure(error) {
  txt('error', error.message); $('error').hidden = false;
  txt('connection', '连接异常 · 显示的可能是旧记录'); $('connection').className = 'connection offline';
  $('save').disabled = true; $('stop').disabled = true;
  $('rename-task').disabled = true;
  txt('runtime', '状态未更新'); $('runtime').className = 'pill warning';
}
async function refresh() {
  if (loading) return;
  loading = true; $('refresh').disabled = true;
  const requested = selected;
  try {
    if (!token) throw new Error('缺少本地访问凭证。请让 Codex 运行 dashboard 并打开返回的完整地址。');
    if (!bankInfo) {
      bankInfo = await api('/api/info');
      txt('bank-badge', `${bankInfo.modelCount} 个候选模型`);
      txt('bank-source', `统一指纹库 · ${bankInfo.modelCount} 个模型 · SHA-256 ${bankInfo.bankSha256.slice(0, 12)}… · 插件打包快照`);
      $('bank-detail').disabled = false;
    }
    const result = await api('/api/sessions');
    if (requested !== selected) return;
    if (!selected && result.sessions.length) selected = result.sessions[0].id;
    const signature = JSON.stringify(result.sessions.map((s) => [s.id, s.displayName, s.expectedModel, s.enabled])) + selected;
    if ($('session').dataset.signature !== signature) {
      const options = result.sessions.map((s) => { const option = element('option', '', `${s.displayName || '监测任务'} · ${s.expectedModel || '模型待获取'}`); option.value = s.id; option.title = `任务 ID：${s.session}`; return option; });
      if (!result.sessions.some((s) => s.id === selected)) { const option = element('option', '', selected ? '当前任务尚未开启监测' : '暂无监测任务'); option.value = selected; options.unshift(option); }
      $('session').replaceChildren(...options); $('session').value = selected; $('session').dataset.signature = signature;
    }
    const target = selected;
    let data = null;
    if (result.sessions.some((s) => s.id === target)) data = await api(`/api/sessions/${target}`);
    if (target !== selected) return;
    render(data); txt('connection', `本地已连接 · ${time(Date.now())}`); $('connection').className = 'connection online';
    $('error').hidden = !result.unreadable;
    if (result.unreadable) txt('error', `${result.unreadable} 个监测状态文件无法读取，未重置或覆盖。请检查 guard status。`);
  } catch (error) { failure(error); }
  finally { loading = false; $('refresh').disabled = false; }
}
for (const [code, name] of Object.entries(languageNames)) {
  const label = element('label', 'language-choice'), input = element('input'); input.type = 'checkbox'; input.name = 'languages'; input.value = code;
  label.append(input, document.createTextNode(name)); $('languages').append(label);
}
$('refresh').addEventListener('click', refresh);
$('session').addEventListener('change', () => { selected = $('session').value; dirty = false; archivePage = null; archiveKind = 'recent'; $('history-kind').value = 'recent'; txt('save-message', ''); render(null); void refresh(); });
$('history-kind').addEventListener('change', () => { archiveKind = $('history-kind').value; archivePage = null; if (archiveKind === 'recent') { if (snapshot) renderHistory(snapshot); } else void loadHistory(); });
$('history-more').addEventListener('click', () => void loadHistory(archivePage?.nextBefore));
async function loadHistory(before) {
  const target = selected, kind = archiveKind;
  $('history-more').disabled = true;
  try {
    const page = await api(`/api/sessions/${target}/history?kind=${kind}${before ? `&before=${before}` : ''}`);
    if (target !== selected || kind !== archiveKind) return;
    archivePage = page; if (snapshot) renderHistory(snapshot);
  } catch (error) { failure(error); }
}
$('filter').addEventListener('change', () => { if (snapshot) renderHistory(snapshot); });
$('config-form').addEventListener('input', () => { dirty = true; txt('settings-status', '有未保存的修改'); });
$('config-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (!snapshot?.enabled) return;
  const target = snapshot.id; const body = {};
  for (const input of $('config-fields').querySelectorAll('input[type=number]')) body[input.name] = Number(input.value);
  body.languages = [...$('languages').querySelectorAll('input:checked')].map((input) => input.value);
  $('save').disabled = true; txt('save-message', '正在保存…'); $('save-message').className = '';
  try {
    if (!body.languages.length) throw new Error('至少选择一种探针语言');
    if (body.toolMin > body.toolMax) throw new Error('最小间隔不能大于最大间隔');
    if (!Number.isInteger(body.retryCount) || body.retryCount < 1 || body.retryCount > 100) throw new Error('异常复测次数需为 1–100 的整数');
    const state = await api(`/api/sessions/${target}/configure`, body);
    if (target !== selected) return;
    dirty = false; render(state); txt('save-message', '已保存 · 历史与累计计数不变');
  } catch (error) { txt('save-message', error.message); $('save-message').className = 'error'; }
  finally { $('save').disabled = !snapshot?.enabled; }
});
$('stop').addEventListener('click', () => { stopTarget = snapshot?.id; $('stop-dialog').showModal(); });
$('cancel-stop').addEventListener('click', () => $('stop-dialog').close());
$('confirm-stop').addEventListener('click', async () => {
  $('stop-dialog').close(); if (!stopTarget) return;
  try { const state = await api(`/api/sessions/${stopTarget}/stop`, {}); if (state.id === selected) render(state); }
  catch (error) { failure(error); }
});
$('close-detail').addEventListener('click', () => $('detail').close());
$('bank-detail').addEventListener('click', () => { if (bankInfo) showDetail(bankInfo, '指纹库与样式来源'); });
$('rename-task').addEventListener('click', () => {
  if (!snapshot) return;
  renameTarget = snapshot.id; $('task-name').value = snapshot.taskName || ''; txt('name-message', ''); $('name-dialog').showModal(); $('task-name').focus();
});
$('cancel-name').addEventListener('click', () => $('name-dialog').close());
$('name-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (!renameTarget) return;
  $('save-name').disabled = true;
  try {
    const result = await api(`/api/sessions/${renameTarget}/name`, { name: $('task-name').value });
    $('name-dialog').close();
    if (result.id === selected) render(result);
    await refresh();
  } catch (error) { txt('name-message', error.message); }
  finally { $('save-name').disabled = false; }
});
$('copy-start').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText('使用 $modeltrace-guard 为本任务开启监测'); txt('copy-start', '已复制'); }
  catch { txt('copy-start', '请手动复制左侧文字'); }
});
// Preserve the capability fragment when using page navigation links.
for (const link of document.querySelectorAll('a[href^="#"]')) link.addEventListener('click', (event) => {
  event.preventDefault();
  const id = link.getAttribute('href').slice(1) || 'overview';
  if ($(id)?.getClientRects().length) {
    for (const nav of document.querySelectorAll('.nav-button')) nav.classList.toggle('active', nav === link);
    $(id).scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
$('enable-notifications').addEventListener('click', async () => {
  if (typeof Notification === 'undefined') { txt('notification-status', '此浏览器不支持桌面通知；网页内提醒仍可用'); return; }
  notificationsEnabled = await Notification.requestPermission() === 'granted';
  txt('notification-status', notificationsEnabled ? '桌面提醒已开启 · 请保持此页面打开' : '未获通知权限 · 网页内提醒仍可用');
  startAlertStream();
});
function startAlertStream() {
  if (alertStreamStarted || !token || typeof TextDecoder === 'undefined') return;
  alertStreamStarted = true;
  const seen = new Set();
  void (async () => {
    for (;;) {
      try {
        const response = await fetch('/api/alerts', { headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) throw new Error('提醒连接不可用');
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const line = event.split('\n').find((row) => row.startsWith('data: '));
            if (!line || event.includes('event: unavailable')) continue;
            const data = JSON.parse(line.slice(6)); const a = data.alert;
            const key = `${data.taskId}:${a.id}:${a.level}`; if (seen.has(key)) continue;
            seen.add(key); if (seen.size > 2000) seen.delete(seen.values().next().value);
            const body = `${data.task}：预期 ${a.expected}，第一候选 ${a.prediction}${a.level === 'confirmed_mismatch' ? `；${a.retryCount} 次复测全部不一致，已要求停止任务` : ''}`;
            txt('live-notice', body); $('live-notice').hidden = false;
            if (notificationsEnabled && Notification.permission === 'granted') new Notification('ModelTrace Guard 不一致提醒', { body, tag: key });
            void refresh();
          }
        }
      } catch { txt('notification-status', '提醒连接中断，正在重连；记录仍保留'); }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  })();
}
startAlertStream();
setInterval(() => { if (!document.hidden) void refresh(); }, 3000);
void refresh();
