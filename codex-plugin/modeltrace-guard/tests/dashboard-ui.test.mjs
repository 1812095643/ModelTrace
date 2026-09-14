import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// A tiny isolated DOM double runs the actual shipped script and form handlers.
// This checks UI logic, not browser rendering or real Codex hook delivery.
class NodeDouble {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.events = {}; this.dataset = {}; this.hidden = false; this.textContent = ''; this.className = ''; this.value = ''; this.checked = false; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, listener) { this.events[name] = listener; }
  setAttribute() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  querySelectorAll() { return []; }
}
async function fixture() {
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const nodes = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new NodeDouble()]));
  const inputs = [...html.matchAll(/<input name="([^"]+)" type="number"[^>]*>/g)].map((match) => Object.assign(new NodeDouble('input'), { name: match[1], type: 'number' }));
  nodes['config-fields'].querySelectorAll = (selector) => selector === 'input[type=number]' ? inputs : [];
  nodes['config-form'].elements = { namedItem: (name) => inputs.find((input) => input.name === name) };
  nodes.languages.querySelectorAll = (selector) => nodes.languages.children.flatMap((label) => label.children).filter((node) => node.tagName === 'input' && (selector !== 'input:checked' || node.checked));
  nodes.filter.value = 'all';
  const calls = [], state = {
    id: 'synthetic-ui-task', session: 'task', enabled: true, status: 'confirming_mismatch', startedAt: 1000,
    expectedModel: 'expected', expectedSource: 'auto', reportedModel: 'expected', probesIssued: 1, probesAccepted: 1,
    missedProbes: 0, differenceSignals: 1, mismatchAlerts: 1, pendingNotifications: 0, pendingExpired: false,
    hookObserved: true, lastHookAt: 2000, pending: null,
    frequency: { mode: 'tools', toolMin: 8, toolMax: 16, retryCount: 3, pendingSeconds: 180, languages: ['en'] },
    alerts: [], samples: [], events: [], eventCount: 0, confirmation: { status: 'active', target: 3, language: 'en', results: [] }, taskHalt: null,
  };
  const context = vm.createContext({
    document: { getElementById: (id) => nodes[id], createElement: (tag) => new NodeDouble(tag), createTextNode: (text) => Object.assign(new NodeDouble('text'), { textContent: text }), querySelectorAll: () => [], addEventListener() {} },
    location: { hash: '#token=synthetic-ui-capability&session=synthetic-ui-task' }, URLSearchParams, AbortSignal,
    setInterval() {}, navigator: {},
    fetch: async (route, options) => {
      calls.push({ route, options });
      let result;
      if (route === '/api/info') result = { modelCount: 33, bankSha256: 'synthetic-hash' };
      else if (route === '/api/sessions') result = { sessions: [{ id: state.id, session: state.session, displayName: '合成交互测试', expectedModel: state.expectedModel, enabled: true }], unreadable: 0 };
      else if (route.endsWith('/configure')) result = { ...state, frequency: { ...state.frequency, ...JSON.parse(options.body) } };
      else result = state;
      return { ok: true, json: async () => result };
    },
  });
  vm.runInContext(source, context);
  // Flush initialization's local promises. No real server/browser is contacted.
  await new Promise((resolve) => setImmediate(resolve));
  return { nodes, inputs, state, calls, context };
}

test('shipped dashboard loads retry default and renders active, completed, interrupted and halted batches', async () => {
  const { context, nodes, inputs, state } = await fixture();
  assert.equal(inputs.find((input) => input.name === 'retryCount').value, 3);
  assert.equal(nodes['confirmation-panel'].hidden, false);
  assert.equal(nodes['confirmation-status'].textContent, '复测 0 / 3');
  state.pendingNotifications = 1;
  context.renderConfirmation(state);
  assert.match(nodes['confirmation-note'].textContent, /等待智能体告知用户并确认提醒/);
  state.pendingNotifications = 0;
  context.renderConfirmation(state);
  assert.match(nodes['confirmation-note'].textContent, /等待下一次复测/);
  state.frequency.retryCount = 7; state.confirmation.results = [{ mismatch: true }, { mismatch: false }];
  context.renderConfirmation(state);
  assert.equal(nodes['confirmation-status'].textContent, '复测 2 / 3');
  assert.match(nodes['confirmation-note'].textContent, /当前次数设置 7 仅影响下一组/);
  state.confirmation.status = 'completed'; state.confirmation.allMismatch = false;
  context.renderConfirmation(state);
  assert.match(nodes['confirmation-note'].textContent, /未满足全部不一致/);
  state.confirmation.status = 'interrupted'; state.confirmation.reason = 'context_compaction';
  context.renderConfirmation(state);
  assert.match(nodes['confirmation-note'].textContent, /上下文压缩/);
  state.taskHalt = { expected: 'expected', retryCount: 3 };
  state.status = 'task_halted';
  context.render(state);
  assert.equal(nodes.runtime.textContent, '已要求停止任务');
  assert.equal(nodes['confirmation-status'].textContent, '已要求停止任务');
  assert.match(nodes['confirmation-note'].textContent, /确认提醒、修改设置或停止监测不会解除/);
  state.taskHalt = state.confirmation = null;
  context.renderConfirmation(state);
  assert.equal(nodes['confirmation-panel'].hidden, true);
});

test('actual form submits configurable retry counts and tool intervals without time-trigger fields', async () => {
  const { nodes, inputs, calls } = await fixture();
  inputs.find((input) => input.name === 'retryCount').value = '5';
  await nodes['config-form'].events.submit({ preventDefault() {} });
  const save = calls.find((call) => call.route.endsWith('/configure'));
  assert.ok(save);
  assert.equal(save.options.headers.Authorization, 'Bearer synthetic-ui-capability');
  const body = JSON.parse(save.options.body);
  assert.equal(body.retryCount, 5); assert.equal(body.toolMin, 8); assert.equal(body.toolMax, 16);
  assert.deepEqual(body.languages, ['en']);
  assert.equal(body.pendingSeconds, 180);
  for (const key of ['mode', 'secondsMin', 'secondsMax', 'maxPerTurn', 'maxPerSession']) assert.equal(body[key], undefined);
  assert.match(nodes['save-message'].textContent, /已保存/);
  const requestCount = calls.length;
  for (const invalid of ['0', '101', '2.5']) {
    inputs.find((input) => input.name === 'retryCount').value = invalid;
    await nodes['config-form'].events.submit({ preventDefault() {} });
    assert.match(nodes['save-message'].textContent, /异常复测次数需为/);
  }
  assert.equal(calls.length, requestCount, 'invalid retry settings do not reach the API');
});
