import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULTS, digest, readState, sessionPath, withState } from '../scripts/state.mjs';
import { createDashboard, SERVICE } from '../scripts/dashboard-server.mjs';
import { launchDashboard, stopDashboard } from '../scripts/dashboard.mjs';
import { queueAlert } from '../scripts/alerts.mjs';
import { loadArtifacts } from '../scripts/guard.mjs';

const session = 'dashboard-synthetic-fixture';
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'modeltrace-dashboard-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('modeltrace-dashboard-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
async function syntheticState(directory) {
  await withState(directory, session, (s) => {
    s.enabled = true; s.model = 'gpt-5.4'; s.expected = s.model; s.epoch = 1; s.startedAt = Date.now(); s.issued = 2;
    const sample = { at: Date.now(), challenge: 'synthetic-checkpoint', epoch: 1, expected: s.expected, reportedModel: s.model, prediction: 'o3', language: 'en', outcome: 'difference_signal', closedSetWeight: .92, expectedWeight: .04, numbers: [1, 2, 3], top3: [{ model: 'o3', closedSetWeight: .92 }] };
    s.samples.push(sample); queueAlert(s, sample);
  });
}
async function serverFixture(t, directory) {
  const service = await createDashboard({ directory });
  t.after(() => service.close());
  const call = (route, body, headers = {}) => fetch(service.origin + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${service.token}`, ...(body === undefined ? {} : { Origin: service.origin, 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ...service, call };
}

test('dashboard binds only loopback and requires a capability for all session data', async (t) => {
  const dir = await fixture(t), s = await serverFixture(t, dir);
  assert.equal(s.server.address().address, '127.0.0.1');
  assert.equal((await fetch(s.origin + '/api/sessions')).status, 401);
  assert.equal((await s.call('/api/sessions', undefined, { Authorization: 'Bearer wrong' })).status, 401);
  assert.deepEqual(await (await s.call('/api/sessions')).json(), { sessions: [], unreadable: 0 });
  assert.equal((await (await s.call('/api/health')).json()).service, SERVICE);
  const home = await fetch(s.origin);
  assert.equal(home.status, 200); assert.equal(home.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(home.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert.equal(home.headers.get('cache-control'), 'no-store');
  assert.equal((await s.call('/assets/unified_bank.json')).status, 404);
  assert.equal((await s.call('/api/sessions/../../_dashboard.json')).status, 404);
});

test('foreign Origin, DNS-rebinding Host and cross-site requests cannot reach dashboard APIs', async (t) => {
  const dir = await fixture(t), s = await serverFixture(t, dir);
  assert.equal((await s.call('/api/sessions', undefined, { Origin: 'https://hostile.invalid' })).status, 403);
  // Node's fetch may normalize forbidden browser headers; use raw HTTP for Host.
  const status = await new Promise((resolve, reject) => {
    const req = request(s.origin + '/api/sessions', { headers: { Host: `hostile.invalid:${s.port}`, Authorization: `Bearer ${s.token}` } }, (res) => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end();
  });
  assert.equal(status, 403);
  const crossSite = await new Promise((resolve, reject) => {
    const req = request(s.origin + '/api/sessions', { headers: { Authorization: `Bearer ${s.token}`, 'Sec-Fetch-Site': 'cross-site' } }, (res) => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end();
  });
  assert.equal(crossSite, 403);
});

test('dashboard reports verified provenance and reuses the original ModelTrace theme', async (t) => {
  const dir = await fixture(t), s = await serverFixture(t, dir);
  const metadata = await (await s.call('/api/info')).json();
  const { bank, metadata: provenance } = await loadArtifacts();
  assert.equal(metadata.assetsVerified, true); assert.equal(metadata.modelCount, bank.models.length);
  assert.equal(metadata.modelCount, provenance.modelCount);
  assert.deepEqual(metadata.models, bank.models.map(({ id, family }) => ({ id, family })));
  const css = await (await s.call('/modeltrace.css')).text();
  assert.equal(digest(css), metadata.sharedStylesSha256);
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  // Repository development additionally checks exact upstream sources; installed
  // standalone copies still validate their bundled files against provenance.
  for (const [file, expectedHash] of [['static/styles.css', metadata.sharedStylesSha256], ['data/unified_bank.json', metadata.bankSha256], ['static/fingerprint-core.js', metadata.scorerSha256]]) {
    const original = await readFile(path.join(repoRoot, file), 'utf8').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (original !== null) assert.equal(digest(original.replace(/\r\n/g, '\n')), expectedHash, file);
  }
  assert.equal((await fetch(s.origin + '/api/info')).status, 401);
  const page = await (await s.call('/')).text();
  for (const [, route] of page.matchAll(/(?:href|src)="(\/[^"#]+)"/g)) assert.equal((await s.call(route)).status, 200, `Bundled UI asset ${route} is served`);
});

test('page refresh reads existing evidence without mutating state or exposing probe arrays', async (t) => {
  const dir = await fixture(t); await syntheticState(dir);
  const before = await readFile(sessionPath(dir, session), 'utf8'), s = await serverFixture(t, dir);
  const index = await (await s.call('/api/sessions')).json(); assert.equal(index.sessions.length, 1);
  for (let i = 0; i < 3; i += 1) {
    const data = await (await s.call(`/api/sessions/${digest(session)}`)).json();
    assert.equal(data.pendingNotifications, 1); assert.equal(data.mismatchAlerts, 1);
    assert.equal(data.samples.length, 1); assert.equal(data.samples[0].numbers, undefined);
    assert.equal(data.stateFile, undefined); assert.equal(data.alerts[0].acknowledgedAt, null);
  }
  assert.equal(await readFile(sessionPath(dir, session), 'utf8'), before);
});

test('dashboard keeps operational labels without the removed disclaimer copy', async (t) => {
  const dir = await fixture(t), s = await serverFixture(t, dir);
  const page = await (await s.call('/')).text();
  for (const removed of ['显示名称仅用于此仪表盘', '不会重命名 Codex', '抽样证据，不是全程保证', '抽样结果不构成全程保证', '指纹权重不是后端身份或作弊概率', '同上下文、多语言阈值尚未独立校准', '探针之间、隐藏推理和子代理', '不能独立验证用户收到', '不是模型真实身份概率', '只更改仪表盘名称']) {
    assert.ok(!page.includes(removed), `Removed UI copy must stay absent: ${removed}`);
  }
  for (const id of ['task-identity', 'task-meta', 'name-dialog', 'alerts', 'weights', 'error']) assert.ok(page.includes(`id="${id}"`));
  assert.ok(page.includes('检测到指纹不一致时，要求智能体主动告知用户。'));
  assert.ok(page.includes('参考库内的相对权重'));
  assert.ok(!page.includes('class="notice disclaimer"'));
  assert.ok(!page.includes('本地计算 · 实验版'));
  assert.ok(!page.includes('class="privacy-badge"'));
  assert.ok(page.includes('id="refresh"'));
});

test('configuration API preserves counts, pending probe and alert history and rejects invalid payloads', async (t) => {
  const dir = await fixture(t); await syntheticState(dir);
  await withState(dir, session, (s) => { s.pending = { id: 'already-issued', language: 'en', expiresAt: Date.now() + 30000 }; });
  const s = await serverFixture(t, dir), route = `/api/sessions/${digest(session)}/configure`;
  const res = await s.call(route, { toolMin: 120, toolMax: 120, retryCount: 5, languages: ['ja', 'ar'] });
  assert.equal(res.status, 200);
  const after = await readState(dir, session);
  assert.equal(after.config.mode, 'tools'); assert.equal(after.config.toolMin, 120); assert.equal(after.config.retryCount, 5); assert.deepEqual(after.config.languages, ['ja', 'ar']);
  assert.equal(after.pending.id, 'already-issued'); assert.equal(after.pending.language, 'en'); assert.equal(after.issued, 2); assert.equal(after.alerts.length, 1);
  const beforeInvalid = JSON.stringify(after);
  for (const body of [{ toolMin: 9, toolMax: 2 }, { languages: [] }, { mode: 'time' }, { mode: 'either' }, { secondsMin: 3 }, { retryCount: 0 }, { retryCount: 101 }, { retryCount: 2.5 }, { retryCount: '3' }, { maxPerTurn: 8 }, { maxPerSession: 40 }, { enabled: true }, { expected: 'other' }, JSON.parse('{"__proto__":{"x":true}}'), { constructor: 'no' }]) assert.equal((await s.call(route, body)).status, 400);
  assert.equal(JSON.stringify(await readState(dir, session)), beforeInvalid);
  assert.equal((await s.call(route, {}, { Origin: '' })).status, 403);
  assert.equal((await s.call(route, {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await s.call(route, { tooLarge: 'x'.repeat(9000) })).status, 413);
  assert.equal((await s.call(`/api/sessions/${digest(session)}/start`, {})).status, 404);
  assert.equal((await s.call(`/api/sessions/${digest(session)}/acknowledge`, {})).status, 404);
});

test('dashboard reads retired time/cap settings without rewriting evidence or showing a stale budget pause', async (t) => {
  const dir = await fixture(t); await syntheticState(dir);
  const legacy = await readState(dir, session);
  delete legacy.config.retryCount;
  legacy.config.mode = 'either'; legacy.config.secondsMin = 180; legacy.config.secondsMax = 420; legacy.nextAt = 2000;
  legacy.config.maxPerTurn = 1; legacy.config.maxPerSession = 2;
  legacy.lastOutcome = 'budget_paused'; legacy.lastHookAt = Date.now(); legacy.turnIssued = 2;
  await writeFile(sessionPath(dir, session), JSON.stringify(legacy));
  const before = await readFile(sessionPath(dir, session), 'utf8'), s = await serverFixture(t, dir);
  const view = await (await s.call(`/api/sessions/${digest(session)}`)).json();
  assert.equal(view.frequency.mode, 'tools'); assert.equal(view.frequency.retryCount, 3);
  assert.equal(view.frequency.secondsMin, undefined); assert.equal(view.nextTimeCheckpoint, null);
  assert.equal(view.frequency.maxPerTurn, undefined); assert.equal(view.frequency.maxPerSession, undefined);
  assert.equal(view.status, 'hooks_unverified'); assert.equal(view.fingerprintDisplayStatus, 'difference_signal'); assert.equal(view.fingerprintStatus, 'difference_signal');
  assert.equal(await readFile(sessionPath(dir, session), 'utf8'), before);
  const page = await (await s.call('/')).text();
  assert.match(page, /name="retryCount"[^>]*min="1"[^>]*max="100"/);
  assert.ok(page.includes('id="confirmation-panel"'));
  for (const removed of ['name="mode"', 'name="secondsMin"', 'name="secondsMax"', 'name="maxPerTurn"', 'name="maxPerSession"', '每轮探针上限', '任务累计探针上限']) assert.ok(!page.includes(removed));
  assert.match(page, /aria-describedby="expiry-note"/);
  assert.match(page, /超时只记为采样缺口/);
});

test('dashboard updates next retry count without changing the active batch or clearing task halt', async (t) => {
  const dir = await fixture(t); await syntheticState(dir);
  await withState(dir, session, (state) => {
    state.confirmation = { id: 'batch', status: 'active', target: 3, language: 'en', results: [] };
    state.taskHalt = { id: 'prior-halt', retryCount: 1, expected: state.expected };
  });
  const service = await serverFixture(t, dir), prefix = `/api/sessions/${digest(session)}`;
  const result = await (await service.call(prefix + '/configure', { retryCount: 9, languages: ['ja'] })).json();
  assert.equal(result.frequency.retryCount, 9); assert.equal(result.confirmation.target, 3);
  assert.equal(result.confirmation.language, 'en'); assert.equal(result.taskHalt.id, 'prior-halt');
  assert.equal(result.status, 'task_halted');
  const stopped = await (await service.call(prefix + '/stop', {})).json();
  assert.equal(stopped.confirmation.status, 'interrupted'); assert.equal(stopped.confirmation.reason, 'monitoring_stopped');
  assert.equal(stopped.taskHalt.id, 'prior-halt'); assert.equal(stopped.probesIssued, 2);
  assert.equal((await service.call(prefix + '/resume', { halt: 'prior-halt' })).status, 404);
});

test('stopping through the dashboard retains evidence and cannot silently re-enable sampling', async (t) => {
  const dir = await fixture(t); await syntheticState(dir); const s = await serverFixture(t, dir);
  const prefix = `/api/sessions/${digest(session)}`;
  assert.equal((await s.call(prefix + '/stop', {})).status, 200);
  assert.equal((await readState(dir, session)).enabled, false);
  assert.equal((await readState(dir, session)).alerts.length, 1);
  assert.equal((await s.call(prefix + '/configure', { mode: 'tools' })).status, 409);
});

test('unreadable session is reported and left intact; other sessions remain viewable', async (t) => {
  const dir = await fixture(t); await syntheticState(dir);
  const broken = path.join(dir, digest('broken') + '.json'); await writeFile(broken, '{not json');
  const s = await serverFixture(t, dir), res = await (await s.call('/api/sessions')).json();
  assert.equal(res.sessions.length, 1); assert.equal(res.unreadable, 1); assert.equal(await readFile(broken, 'utf8'), '{not json');
});

test('launcher reuses one authenticated service and shutdown does not affect monitor state', async (t) => {
  const dir = await fixture(t); await syntheticState(dir);
  const before = await readFile(sessionPath(dir, session), 'utf8');
  // Use the actual entrypoint, not just imported functions: catches CLI-only
  // top-level-await module cycles and detached startup/stdio problems.
  const cli = fileURLToPath(new URL('../scripts/guard.mjs', import.meta.url));
  const first = JSON.parse((await promisify(execFile)(process.execPath, [cli, 'dashboard', '--session', session, '--data-dir', dir], { timeout: 15000 })).stdout);
  t.after(async () => { await stopDashboard(dir); });
  const second = await launchDashboard(dir, session);
  assert.equal(first.reused, false); assert.equal(second.reused, true); assert.equal(first.url, second.url);
  assert.equal(first.samplingStarted, false);
  const url = new URL(first.url); assert.equal(url.search, ''); assert.ok(new URLSearchParams(url.hash.slice(1)).get('token'));
  assert.equal((await stopDashboard(dir)).stopped, true);
  // Wait a bounded period for an acknowledged, graceful shutdown (no PID kill).
  for (let i = 0; i < 20; i += 1) { if (!(await stopDashboard(dir)).stopped) break; await delay(30); }
  assert.equal(await readFile(sessionPath(dir, session), 'utf8'), before);
});
