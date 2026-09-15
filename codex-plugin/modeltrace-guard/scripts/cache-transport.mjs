import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

// ChatGPT's Codex endpoint derives its cache key from the connection's
// session-id, not JSON prompt_cache_key. Keep the original cache session while
// retaining the disposable thread/turn IDs. Bodies (including compressed HTTP
// and WebSocket frames) are piped verbatim, never parsed, saved or logged.
export async function startSessionCacheTransport({ sessionId, baseId, sourceId, upstream, requestImpl = https.request }) {
  if (![sessionId, baseId, sourceId].every(id => UUID.test(id || ''))) throw new Error('Invalid native cache session ownership');
  const destination = new URL(upstream);
  if (destination.protocol !== 'https:' || destination.username || destination.password || destination.search || destination.hash) throw new Error('Invalid native cache upstream');
  const secret = randomBytes(24).toString('hex');
  const routePrefix = `/${secret}/`;
  const allowed = new Set(), sockets = new Set(), outgoing = new Set();
  let closed = false;
  const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; };
  const resolveRequest = (req, upgrade) => {
    if (closed || !req.url?.startsWith(routePrefix)) return null;
    const relative = req.url.slice(routePrefix.length);
    if (!(upgrade ? relative === 'responses' : /^(?:models(?:\?[^#]*)?|responses)$/.test(relative))) return null;
    if (relative.startsWith('models')) { if (upgrade || req.method !== 'GET') return null; }
    else {
      if (req.method !== (upgrade ? 'GET' : 'POST')) return null;
      const id = req.headers['thread-id'];
      if (!allowed.has(id) || !req.headers.authorization || ![id, sessionId].includes(req.headers['session-id'])) return null;
    }
    const url = new URL(relative, destination);
    const headers = { ...req.headers, host: url.host };
    if (!relative.startsWith('models')) headers['session-id'] = sessionId;
    return { url, headers };
  };
  const send = (req, params, listener) => {
    const remote = requestImpl(params.url, { method: req.method, headers: params.headers }, listener);
    outgoing.add(remote); remote.once('close', () => outgoing.delete(remote));
    return remote;
  };
  const server = http.createServer((req, res) => {
    const params = resolveRequest(req, false);
    if (!params) { req.resume(); res.writeHead(404, { Connection: 'close' }).end(); return; }
    let remote;
    try {
      remote = send(req, params, response => {
        // Native model requests may remain silent while reasoning. This is not
        // a new probe deadline; generateProbe owns cancellation and expiry.
        remote.setTimeout(0);
        res.writeHead(response.statusCode, response.headers);
        response.on('error', () => res.destroy());
        response.pipe(res);
      });
    } catch { res.writeHead(502).end(); return; }
    remote.on('error', () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
    req.on('error', () => remote.destroy());
    res.on('close', () => remote.destroy());
    req.pipe(remote);
  });
  server.on('connection', track);
  server.on('upgrade', (req, socket, head) => {
    const params = resolveRequest(req, true);
    if (!params) { socket.destroy(); return; }
    let remote;
    try { remote = send(req, params); } catch { socket.destroy(); return; }
    remote.once('upgrade', (response, upstreamSocket, upstreamHead) => {
      remote.setTimeout(0); track(upstreamSocket);
      // Preserve the native handshake, including compression negotiation and
      // frame format. Neither endpoint is emulated by the plugin.
      const lines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage}`];
      for (let i = 0; i < response.rawHeaders.length; i += 2) lines.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      socket.on('error', () => upstreamSocket.destroy());
      upstreamSocket.on('error', () => socket.destroy());
      socket.on('close', () => upstreamSocket.destroy());
      upstreamSocket.on('close', () => socket.destroy());
      socket.pipe(upstreamSocket); upstreamSocket.pipe(socket);
    });
    remote.once('response', response => { response.resume(); socket.destroy(); });
    remote.on('error', () => socket.destroy());
    socket.once('close', () => remote.destroy());
    remote.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    mode: 'source_session',
    url: `http://127.0.0.1:${server.address().port}/${secret}`,
    authorize(id) {
      if (closed || !UUID.test(id || '') || id === sourceId || id === baseId) throw new Error('Only disposable probe threads may use the cache transport');
      allowed.add(id);
    },
    async close() {
      if (closed) return;
      closed = true; allowed.clear();
      for (const remote of outgoing) remote.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

export async function prepareCacheTransport(client, snapshot, env = process.env) {
  if (snapshot.provider !== 'openai' || !UUID.test(snapshot.cacheSessionId || '')) return null;
  const [{ account }, { config }] = await Promise.all([
    client.request('account/read', { refreshToken: false }),
    client.request('config/read', { cwd: snapshot.cwd, includeLayers: false }),
  ]);
  // Other native providers and API-key accounts keep their existing transport.
  // Never redirect a custom endpoint/account to the ChatGPT service.
  if (account?.type !== 'chatgpt' || config?.openai_base_url
    || !/^https:\/\/chatgpt\.com\/backend-api\/?$/.test(config?.chatgpt_base_url || '')) return null;
  // Do not bypass proxy or custom-CA configuration that Node's HTTPS client
  // cannot reproduce. Such environments continue through native Codex.
  if (['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy',
    'CODEX_CA_CERTIFICATE', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CODEX_NETWORK_PROXY_ACTIVE']
    .some(key => env[key])) return null;
  return startSessionCacheTransport({ sessionId: snapshot.cacheSessionId, baseId: snapshot.id, sourceId: snapshot.sourceSession,
    upstream: 'https://chatgpt.com/backend-api/codex/' });
}
