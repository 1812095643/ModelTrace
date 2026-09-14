import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { abandon, digest, interruptConfirmation, publicSample, record, schedule, setTaskName, validateConfig, withState } from './state.mjs';
import { summarize } from './status.mjs';
import { historyCount, historyPage } from './history.mjs';

export const SERVICE = 'modeltrace-guard-dashboard-v1';
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/modeltrace.css', ['modeltrace.css', 'text/css; charset=utf-8']],
  ['/dashboard.css', ['dashboard.css', 'text/css; charset=utf-8']],
  ['/mark.svg', ['mark.svg', 'image/svg+xml']],
]);
const fail = (status, message) => Object.assign(new Error(message), { status });
const stateCache = new Map();

async function stateById(directory, id) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw fail(404, '未找到监测任务');
  const file = path.join(directory, `${id}.json`);
  const info = await lstat(file).catch((error) => { if (error.code === 'ENOENT') throw fail(404, '未找到监测任务'); throw error; });
  if (!info.isFile()) throw fail(422, '状态文件无效');
  const signature = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  const cached = stateCache.get(file);
  if (cached?.signature === signature) return cached.state;
  const state = JSON.parse(await readFile(file, 'utf8'));
  if (![1, 2].includes(state.schema) || typeof state.session !== 'string' || digest(state.session) !== id || !Array.isArray(state.samples) || !Array.isArray(state.events)) throw fail(422, '监测状态格式无效；历史未被重置');
  validateConfig({}, state.config);
  if (stateCache.size >= 256) stateCache.delete(stateCache.keys().next().value);
  stateCache.set(file, { signature, state });
  return state;
}

export function dashboardSnapshot(state, directory) {
  const { stateFile, ...status } = summarize(state, directory);
  return {
    id: digest(state.session), session: state.session, createdAt: state.createdAt, ...status,
    samples: state.samples.slice(-1000).map(publicSample),
    alerts: (state.alerts || []).slice(-128), events: state.events.slice(-512), eventCount: historyCount(state, 'events'),
    historyTotals: { samples: historyCount(state, 'samples'), events: historyCount(state, 'events'), alerts: historyCount(state, 'alerts') },
    notificationMeaning: '已告知是智能体的自报确认，不等于独立验证用户已收到。',
  };
}

async function listSessions(directory) {
  const files = await readdir(directory, { withFileTypes: true }).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
  const sessions = [];
  let unreadable = 0;
  for (const file of files) {
    if (!file.isFile() || !/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
    try {
      const state = await stateById(directory, file.name.slice(0, -5));
      if (!state.enabled && !state.issued && !state.samples.length && !state.alerts?.length) continue;
      const { stateFile, pending, latest, notifications, ...status } = summarize(state, directory);
      sessions.push({ id: digest(state.session), session: state.session, ...status, updatedAt: state.lastHookAt || state.lastSampleAt || state.createdAt });
    } catch { unreadable += 1; }
  }
  return { sessions: sessions.sort((a, b) => b.updatedAt - a.updatedAt), unreadable };
}

async function jsonBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw fail(415, '仅接受 JSON');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw fail(413, '请求过大');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail(400, 'JSON 格式无效'); }
  if (!body || Array.isArray(body) || typeof body !== 'object') throw fail(400, '需要 JSON 对象');
  return body;
}

export async function createDashboard({ directory, token = randomBytes(32).toString('hex'), onShutdown } = {}) {
  if (!directory || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid dashboard directory/token');
  directory = path.resolve(directory);
  // Keep an opened dashboard usable if a reinstall replaces its plugin cache.
  const assets = new Map(await Promise.all([...staticFiles].map(async ([route, [name, type]]) => [route, { type, bytes: await readFile(path.join(webRoot, name)) }])));
  const pluginRoot = path.dirname(webRoot);
  const [provenanceText, bankBytes, scorerBytes] = await Promise.all([
    readFile(path.join(pluginRoot, 'assets/provenance.json'), 'utf8'),
    readFile(path.join(pluginRoot, 'assets/unified_bank.json')),
    readFile(path.join(pluginRoot, 'scripts/fingerprint-core.mjs')),
  ]);
  const provenance = JSON.parse(provenanceText);
  if (digest(bankBytes) !== provenance.bankSha256 || digest(scorerBytes) !== provenance.scorerSha256 || digest(assets.get('/modeltrace.css').bytes) !== provenance.sharedStylesSha256) throw new Error('Bundled bank, scorer or shared stylesheet checksum mismatch; rebuild the plugin');
  const info = { ...provenance, assetsVerified: true, models: JSON.parse(bankBytes).models.map(({ id, family }) => ({ id, family })), updatePolicy: 'The fingerprint library, scorer and theme are bundled with the installed plugin package.' };
  let origin;
  const streams = new Set();
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    try {
      // A loopback bind alone does not prevent DNS rebinding or hostile websites
      // from reaching local APIs. Use an exact Host, capability and write Origin.
      if (req.headers.host !== new URL(origin).host) throw fail(403, 'Host 不允许');
      if (req.headers.origin && req.headers.origin !== origin) throw fail(403, 'Origin 不允许');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, '不接受跨站请求');
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const { bytes, type } = assets.get(url.pathname);
        res.writeHead(200, { 'Content-Type': type });
        res.end(bytes);
        return;
      }
      if (!url.pathname.startsWith('/api/')) throw fail(404, '未找到页面');
      const supplied = Buffer.from(req.headers.authorization || '');
      const expected = Buffer.from(`Bearer ${token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw fail(401, '访问凭证缺失或已失效，请让智能体重新打开仪表盘');
      if (req.method === 'GET' && url.pathname === '/api/health') return json(200, { service: SERVICE, directoryHash: digest(directory), pid: process.pid });
      if (req.method === 'GET' && url.pathname === '/api/info') return json(200, info);
      if (req.method === 'GET' && url.pathname === '/api/sessions') return json(200, await listSessions(directory));
      if (req.method === 'GET' && url.pathname === '/api/alerts') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
        res.write(': connected\n\n'); streams.add(res);
        const sent = new Set(); let busy = false;
        const sendAlerts = async () => {
          if (busy || res.destroyed) return;
          busy = true;
          try {
            const { sessions } = await listSessions(directory);
            for (const task of sessions) {
              const state = await stateById(directory, task.id);
              for (const alert of state.alerts || []) {
                const key = `${task.id}:${alert.id}:${alert.level}`;
                if (sent.has(key) || alert.acknowledgedAt) continue;
                sent.add(key);
                if (sent.size > 2000) sent.delete(sent.values().next().value);
                if (res.destroyed || res.writableEnded) return;
                if (!res.write(`data: ${JSON.stringify({ task: task.displayName, taskId: task.id, alert })}\n\n`)) { res.end(); return; }
              }
            }
          } catch { if (!res.destroyed && !res.writableEnded) res.write('event: unavailable\ndata: {}\n\n'); }
          finally { busy = false; }
        };
        const interval = setInterval(() => void sendAlerts(), 1000);
        res.once('close', () => { clearInterval(interval); streams.delete(res); });
        void sendAlerts(); return;
      }
      if (!['GET', 'POST'].includes(req.method)) throw fail(405, '方法不允许');
      if (req.method === 'POST' && req.headers.origin !== origin) throw fail(403, '写入需要同源 Origin');
      if (req.method === 'POST' && url.pathname === '/api/shutdown') {
        const body = await jsonBody(req);
        if (Object.keys(body).length) throw fail(400, '停止服务不接受额外参数');
        json(200, { stopped: true });
        setImmediate(() => { void close().then(() => onShutdown?.()); });
        return;
      }
      const match = url.pathname.match(/^\/api\/sessions\/([a-f0-9]{64})(?:\/(configure|stop|name|history))?$/);
      if (!match) throw fail(404, '未找到接口');
      const state = await stateById(directory, match[1]);
      if (req.method === 'GET' && match[2] === 'history') {
        const kind = url.searchParams.get('kind') || 'samples';
        try {
          const page = await historyPage(directory, state, kind, { before: url.searchParams.has('before') ? url.searchParams.get('before') : undefined, limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 100 });
          if (kind === 'samples') page.rows = page.rows.map(publicSample);
          return json(200, { kind, ...page });
        } catch (error) { if (/Invalid history (page|cursor)/.test(error.message)) throw fail(400, '分页参数无效'); throw error; }
      }
      if (req.method === 'GET' && !match[2]) return json(200, dashboardSnapshot(state, directory));
      if (match[2] === 'history') throw fail(405, '历史记录只读');
      if (req.method !== 'POST' || !match[2]) throw fail(405, '方法不允许');
      const body = await jsonBody(req);
      if (match[2] === 'stop' && Object.keys(body).length) throw fail(400, '停止监测不接受额外参数');
      if (match[2] === 'name' && (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'name'))) throw fail(400, '修改显示名称仅接受 name 字段');
      const result = await withState(directory, state.session, (live) => {
        const now = Date.now();
        if (match[2] === 'configure') {
          if (!live.enabled) throw fail(409, '监测未开启，请在目标 Codex 任务中开启');
          try { live.config = validateConfig(body, live.config); }
          catch (error) { throw fail(400, error.message); }
          schedule(live, now);
          record(live, 'frequency_configured', now, { config: { ...live.config }, source: 'dashboard' });
        } else if (match[2] === 'name') {
          try { setTaskName(live, body.name, now); }
          catch (error) { throw fail(400, error.message); }
        } else {
          abandon(live, now, 'monitoring_stopped');
          interruptConfirmation(live, now, 'monitoring_stopped');
          live.enabled = false;
          record(live, 'monitoring_stopped', now, { source: 'dashboard' });
        }
        return dashboardSnapshot(live, directory);
      });
      json(200, result);
    } catch (error) {
      if (!res.headersSent) json(error.status || 500, { error: error.status ? error.message : '读取或保存本地状态失败；历史未被重置。请检查 guard status。' });
      else res.end();
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  let closed;
  function close() {
    if (!closed) closed = new Promise((resolve, reject) => {
      for (const response of streams) response.end();
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections?.();
    });
    return closed;
  }
  return { server, origin, port: server.address().port, token, close };
}

// Launched only via a local IPC handshake; never accepts tokens in process args.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.send) throw new Error('Start via guard.mjs dashboard');
  process.once('message', async (message) => {
    try {
      const service = await createDashboard({ directory: message.directory, token: message.token, onShutdown: () => process.exit(0) });
      process.send({ port: service.port, pid: process.pid });
    } catch (error) { process.send({ error: error.message }); process.exitCode = 1; }
  });
}
