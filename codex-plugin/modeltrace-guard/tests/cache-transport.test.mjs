import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { startSessionCacheTransport, prepareCacheTransport } from '../scripts/cache-transport.mjs';
import { forkParameters, prepareProbeFork } from '../scripts/fork-runner.mjs';
import { sourceSettings } from '../scripts/fork-snapshot.mjs';

// Protocol fixtures only: no account, inference, history, diagnostic dumps or
// externally reachable endpoint. All upstream calls terminate at this mock.
async function fixture(t, handler = (req, res) => res.end()) {
  const received = [], sockets = new Set();
  const upstream = http.createServer((req, res) => { received.push(req); handler(req, res); });
  upstream.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const sourceId = randomUUID(), sessionId = randomUUID(), baseId = randomUUID(), childId = randomUUID();
  const relay = await startSessionCacheTransport({ sessionId, baseId, sourceId, upstream: 'https://chatgpt.com/backend-api/codex/',
    requestImpl: (url, options, listener) => http.request({ ...options, hostname: '127.0.0.1', port: upstream.address().port, path: url.pathname + url.search }, listener) });
  relay.authorize(childId);
  t.after(async () => { await relay.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => upstream.close(resolve)); });
  const headers = { authorization: 'Bearer fixture-only', 'thread-id': childId, 'session-id': childId };
  return { relay, upstream, received, sourceId, sessionId, baseId, childId, headers };
}

async function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, async res => {
      const parts = []; for await (const chunk of res) parts.push(chunk);
      resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) });
    });
    req.on('error', reject); req.end(body);
  });
}

test('HTTP changes only cache-session scope, preserving compressed bytes and disposable identity', async t => {
  const body = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, ...Array.from({ length: 4096 }, (_, i) => i % 256)]);
  const f = await fixture(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), body);
    assert.equal(req.headers['content-encoding'], 'zstd');
    assert.equal(req.headers['session-id'], f.sessionId);
    assert.equal(req.headers['thread-id'], f.childId);
    assert.equal(req.headers['x-codex-turn-metadata'], '{"turn_id":"fixture"}');
    assert.equal(req.headers.authorization, f.headers.authorization);
    assert.equal(req.url, '/backend-api/codex/responses');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: fixture\n\n');
  });
  const result = await request(f.relay.url + '/responses', { method: 'POST', headers: { ...f.headers, 'content-encoding': 'zstd', 'x-codex-turn-metadata': '{"turn_id":"fixture"}' }, body });
  assert.equal(result.status, 200); assert.equal(result.body.toString(), 'data: fixture\n\n');
});

test('WebSocket handshakes and binary frames pass through byte-for-byte without emulation', async t => {
  const f = await fixture(t), fromNative = Buffer.from([0xc1, 0x82, 1, 2, 3, 4, 0x51, 0x53]);
  const fromServer = Buffer.from([0xc1, 2, 0x31, 0x32]);
  f.upstream.on('upgrade', (req, socket, head) => {
    assert.equal(req.headers['session-id'], f.sessionId);
    assert.equal(req.headers['thread-id'], f.childId);
    assert.equal(req.headers['sec-websocket-extensions'], 'permessage-deflate');
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n`);
    let data = Buffer.from(head);
    const check = () => { if (data.length >= fromNative.length) { assert.deepEqual(data, fromNative); socket.write(fromServer); } };
    socket.on('data', chunk => { data = Buffer.concat([data, chunk]); check(); }); check();
  });
  const url = new URL(f.relay.url + '/responses');
  const data = await new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname);
    let chunks = Buffer.alloc(0);
    socket.setTimeout(5000, () => socket.destroy(new Error('Fixture socket timed out')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(Buffer.concat([Buffer.from(`GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Extensions: permessage-deflate\r\nAuthorization: ${f.headers.authorization}\r\nSession-Id: ${f.childId}\r\nThread-Id: ${f.childId}\r\n\r\n`), fromNative])));
    socket.on('data', part => { chunks = Buffer.concat([chunks, part]); const end = chunks.indexOf('\r\n\r\n'); if (end >= 0 && chunks.length >= end + 4 + fromServer.length) { socket.destroy(); resolve(chunks); } });
  });
  const split = data.indexOf('\r\n\r\n');
  assert.match(data.subarray(0, split).toString(), /101 Switching Protocols/);
  assert.match(data.subarray(0, split).toString(), /Sec-WebSocket-Extensions: permessage-deflate/i);
  assert.deepEqual(data.subarray(split + 4), fromServer);
});

test('only authorized disposable threads can send model requests; originals and arbitrary routes are denied', async t => {
  const f = await fixture(t);
  assert.throws(() => f.relay.authorize(f.sourceId), /disposable/);
  assert.throws(() => f.relay.authorize(f.baseId), /disposable/);
  for (const [url, headers, method] of [
    [f.relay.url + '/responses', { ...f.headers, 'thread-id': f.sourceId }, 'POST'],
    [f.relay.url + '/responses', { ...f.headers, 'thread-id': randomUUID() }, 'POST'],
    [f.relay.url + '/responses', { ...f.headers, 'session-id': randomUUID() }, 'POST'],
    [f.relay.url + '/responses', { 'thread-id': f.childId, 'session-id': f.childId }, 'POST'],
    [f.relay.url + '/responses', f.headers, 'GET'],
    [f.relay.url + '/arbitrary', f.headers, 'POST'],
    [new URL('/wrong/responses', f.relay.url).href, f.headers, 'POST'],
  ]) assert.equal((await request(url, { method, headers, ...(method === 'POST' ? { body: 'not forwarded' } : {}) })).status, 404);
  assert.equal(f.received.length, 0);
});

test('model catalogue reads retain native query parameters and do not inject thread headers', async t => {
  const f = await fixture(t, (req, res) => {
    assert.equal(req.url, '/backend-api/codex/models?client_version=fixture');
    assert.equal(req.headers['session-id'], undefined);
    res.end('{"models":[]}');
  });
  assert.equal((await request(f.relay.url + '/models?client_version=fixture')).status, 200);
});

test('closing the cache transport tears down active connections and is idempotent', async t => {
  const f = await fixture(t), url = new URL(f.relay.url);
  const socket = net.connect(Number(url.port), url.hostname);
  await new Promise(resolve => socket.once('connect', resolve));
  const closed = new Promise(resolve => socket.once('close', resolve));
  await f.relay.close(); await closed; await f.relay.close();
  assert.throws(() => f.relay.authorize(randomUUID()), /disposable/);
});

test('custom providers, API accounts, custom endpoints and proxy settings retain native routing', async () => {
  const snapshot = { provider: 'openai', cacheSessionId: randomUUID(), cwd: process.cwd() };
  const calls = [];
  let account = { type: 'chatgpt' }, config = { openai_base_url: null, chatgpt_base_url: 'https://chatgpt.com/backend-api/' };
  const client = { request: async (method, params) => { calls.push({ method, params }); return method === 'account/read' ? { account } : { config }; } };
  assert.equal(await prepareCacheTransport(client, { ...snapshot, provider: 'custom' }, {}), null);
  assert.equal(await prepareCacheTransport(client, { ...snapshot, cacheSessionId: undefined }, {}), null);
  assert.equal(calls.length, 0);
  account = { type: 'apiKey' }; assert.equal(await prepareCacheTransport(client, snapshot, {}), null);
  account = { type: 'chatgpt' }; config.openai_base_url = 'https://custom.example/v1';
  assert.equal(await prepareCacheTransport(client, snapshot, {}), null);
  config.openai_base_url = null; config.chatgpt_base_url = 'https://custom.example/backend-api/';
  assert.equal(await prepareCacheTransport(client, snapshot, {}), null);
  config.chatgpt_base_url = 'https://chatgpt.com/backend-api/';
  for (const key of ['HTTPS_PROXY', 'all_proxy', 'CODEX_CA_CERTIFICATE', 'CODEX_NETWORK_PROXY_ACTIVE']) assert.equal(await prepareCacheTransport(client, snapshot, { [key]: 'configured' }), null);
  for (const call of calls.filter(x => x.method === 'account/read')) assert.deepEqual(call.params, { refreshToken: false });
});

test('cache session comes from source metadata, never the baseline or the new fork', async () => {
  const id = randomUUID(), root = randomUUID(); let reads = 0;
  const settings = await sourceSettings({ request: async (method, params) => {
    reads++; assert.equal(method, 'thread/read'); assert.equal(params.includeTurns, false);
    return { thread: { id, path: new URL(import.meta.url).pathname, cwd: process.cwd(), model: 'fixture', modelProvider: 'openai', reasoningEffort: 'max', sessionId: root } };
  } }, id);
  assert.equal(settings.cacheSessionId, root); assert.equal(reads, 1);
});

test('cache transport is a fork-local override and preserves model, effort, history and thread identity', async () => {
  const snapshot = { id: randomUUID(), sourceSession: randomUUID(), sourceTurn: 'boundary', model: 'fixture', provider: 'openai', effort: 'max', cwd: process.cwd() };
  let authorized;
  const transport = { url: 'http://127.0.0.1:12345/fixture', authorize: id => { authorized = id; } };
  assert.deepEqual(forkParameters(snapshot, transport).config, { model_reasoning_effort: 'max', openai_base_url: transport.url });
  const id = randomUUID();
  await prepareProbeFork({ request: async (method, params) => {
    assert.equal(method, 'thread/fork'); assert.equal(params.threadId, snapshot.id); assert.equal(params.lastTurnId, snapshot.sourceTurn);
    assert.equal(params.model, snapshot.model); assert.equal(params.ephemeral, true); assert.equal(params.excludeTurns, true); assert.equal(params.history, undefined);
    return { model: snapshot.model, modelProvider: snapshot.provider, reasoningEffort: snapshot.effort, cwd: snapshot.cwd, thread: { id, ephemeral: true, forkedFromId: snapshot.id, cwd: snapshot.cwd } };
  } }, snapshot, transport);
  assert.equal(authorized, id);
});
