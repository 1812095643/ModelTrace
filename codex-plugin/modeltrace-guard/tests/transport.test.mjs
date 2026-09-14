import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { AppServerClient, CODEX_CLIENT_INFO } from '../scripts/app-server-client.mjs';
import { MAX_PROTOCOL_MESSAGE_BYTES, readProtocolLines } from '../scripts/protocol-lines.mjs';

function transport(t, options) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdin.resume();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kills = 0;
  child.kill = () => { child.kills++; queueMicrotask(() => child.emit('exit', 1)); return true; };
  child.stdin.on('finish', () => queueMicrotask(() => child.emit('exit', 0)));
  const client = new AppServerClient(child, options);
  t.after(async () => { await client.close(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); });
  return { client, child };
}

test('protocol frames handle split UTF-8, CRLF, multiple messages and a final unterminated frame', async (t) => {
  const { client, child } = transport(t);
  const first = client.request('thread/read'), second = client.request('thread/turns/list');
  const frame = Buffer.from('\r\n' + JSON.stringify({ id: 1, result: { text: '上下文 ✓' } }) + '\r\n' + JSON.stringify({ id: 2, result: { data: [] } }));
  for (const byte of frame) child.stdout.write(Buffer.from([byte]));
  child.stdout.end();
  assert.deepEqual(await first, { text: '上下文 ✓' });
  assert.deepEqual(await second, { data: [] });
  assert.equal(child.kills, 0);
});

test('oversized unfinished frames reject all requests without an uncaught readline failure', async (t) => {
  for (const split of [false, true]) {
    const { client, child } = transport(t, { maxMessageBytes: 128 });
    const first = client.request('thread/turns/list'), second = client.request('thread/read');
    const failures = Promise.all([first, second].map((pending) => assert.rejects(pending, (error) => error.code === 'MODELTRACE_PROTOCOL_MESSAGE_TOO_LARGE' && !error.message.includes('private-history'))));
    const chunk = Buffer.from('private-history'.repeat(12));
    if (split) { child.stdout.write(chunk.subarray(0, 100)); child.stdout.write(chunk.subarray(100)); }
    else child.stdout.write(chunk);
    await failures;
    assert.equal(client.pending.size, 0);
    assert.equal(child.kills, 1);
    await assert.rejects(() => client.request('thread/read'), { code: 'MODELTRACE_PROTOCOL_MESSAGE_TOO_LARGE' });
    await client.exited;
  }
});

test('frame limits are per message and apply to complete frames too', async (t) => {
  const { client, child } = transport(t, { maxMessageBytes: 80 });
  const first = client.request('first'), second = client.request('second');
  const one = JSON.stringify({ id: 1, result: 'x'.repeat(35) }) + '\n';
  const two = JSON.stringify({ id: 2, result: 'y'.repeat(35) }) + '\n';
  assert.ok(Buffer.byteLength(one + two) > 80);
  child.stdout.write(one + two);
  assert.equal(await first, 'x'.repeat(35)); assert.equal(await second, 'y'.repeat(35));
  const third = client.request('third');
  const rejected = assert.rejects(third, { code: 'MODELTRACE_PROTOCOL_MESSAGE_TOO_LARGE' });
  child.stdout.write(JSON.stringify({ id: 3, result: 'z'.repeat(100) }) + '\n');
  await rejected;
});

test('malformed protocol output is a transport failure without exposing its contents', async (t) => {
  for (const line of ['{private-history', 'null', '[]']) {
    const { client, child } = transport(t);
    const rejected = assert.rejects(client.request('thread/read'), (error) => error.code === 'MODELTRACE_PROTOCOL_INVALID_MESSAGE' && !error.message.includes('private-history'));
    child.stdout.write(line + '\n');
    await rejected;
    assert.equal(child.kills, 1); assert.equal(client.pending.size, 0);
  }
});

test('request serialization failures clear pending timers without damaging the transport', async (t) => {
  const { client, child } = transport(t), circular = {};
  circular.self = circular;
  await assert.rejects(() => client.request('invalid', circular), /circular/i);
  assert.equal(client.pending.size, 0);
  const next = client.request('thread/read');
  child.stdout.write(JSON.stringify({ id: 2, result: {} }) + '\n');
  assert.deepEqual(await next, {});
  assert.equal(child.kills, 0);
});

test('protocol notifications and server errors retain existing handling', async (t) => {
  const { client, child } = transport(t), seen = [];
  client.listeners.add((message) => seen.push(message.method));
  const rejected = assert.rejects(client.request('thread/read'), /Codex thread\/read: unavailable/);
  child.stdout.write(JSON.stringify({ method: 'thread/status/changed', params: {} }) + '\n' + JSON.stringify({ id: 1, error: { message: 'unavailable' } }) + '\n');
  await rejected;
  assert.deepEqual(seen, ['thread/status/changed']);
  assert.equal(child.kills, 0);
});

test('oversized unsolicited notifications also close the transport safely', async (t) => {
  const { client, child } = transport(t, { maxMessageBytes: 128 }), seen = [];
  client.listeners.add((message) => seen.push(message));
  child.stdout.write(JSON.stringify({ method: 'thread/started', params: { content: 'x'.repeat(200) } }) + '\n');
  await client.exited;
  assert.equal(client.failure.code, 'MODELTRACE_PROTOCOL_MESSAGE_TOO_LARGE');
  assert.equal(child.kills, 1); assert.deepEqual(seen, []);
});

test('protocol byte budget cannot be disabled or enlarged past the safe maximum', () => {
  const input = new PassThrough();
  for (const maxMessageBytes of [0, -1, 1.5, NaN, Infinity, MAX_PROTOCOL_MESSAGE_BYTES + 1]) {
    assert.throws(() => readProtocolLines(input, () => {}, () => {}, { maxMessageBytes }), /Invalid.*limit/);
  }
  input.destroy();
});

test('an unrequested turn rejects a pending fork even when its reply arrives in the same chunk', async (t) => {
  const { client, child } = transport(t);
  const rejected = assert.rejects(client.request('thread/fork'), { code: 'MODELTRACE_UNREQUESTED_TURN' });
  child.stdout.write(JSON.stringify({ method: 'turn/started', params: { threadId: 'base', turn: { id: 'auto-goal' } } }) + '\n' + JSON.stringify({ id: 1, result: {} }) + '\n');
  await rejected;
  assert.equal(child.kills, 1);
  assert.equal(client.pending.size, 0);
});

test('one explicit probe turn never permits automatic follow-up turns', async (t) => {
  const { client, child } = transport(t);
  const started = client.request('turn/start', { threadId: 'fork' });
  child.stdout.write(JSON.stringify({ method: 'turn/started', params: { threadId: 'fork', turn: { id: 'probe' } } }) + '\n' + JSON.stringify({ id: 1, result: { turn: { id: 'probe' } } }) + '\n');
  assert.equal((await started).turn.id, 'probe');
  assert.equal(child.kills, 0);
  const rejected = assert.rejects(client.request('thread/read'), { code: 'MODELTRACE_UNREQUESTED_TURN' });
  child.stdout.write(JSON.stringify({ method: 'turn/started', params: { threadId: 'fork', turn: { id: 'automatic-follow-up' } } }) + '\n');
  await rejected;
  assert.equal(child.kills, 1);
});

test('failed or timed-out turn requests revoke permission for a later automatic turn', async (t) => {
  for (const variant of ['error', 'timeout', 'serialization']) {
    const { client, child } = transport(t), params = { threadId: 'fork' };
    if (variant === 'serialization') params.self = params;
    const rejected = assert.rejects(client.request('turn/start', params, 10));
    if (variant === 'error') child.stdout.write(JSON.stringify({ id: 1, error: { message: 'unavailable' } }) + '\n');
    await rejected;
    assert.equal(client.allowedTurns.size, 0);
    child.stdout.write(JSON.stringify({ method: 'turn/started', params: { threadId: 'fork', turn: { id: 'late' } } }) + '\n');
    await client.exited;
    assert.equal(client.failure.code, 'MODELTRACE_UNREQUESTED_TURN');
  }
});

test('plugin manifest, package and protocol identify the same release', async () => {
  const manifest = JSON.parse(await readFile(new URL('../.codex-plugin/plugin.json', import.meta.url), 'utf8'));
  const packageInfo = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.name, packageInfo.name);
  assert.equal(manifest.version, packageInfo.version);
  assert.equal(CODEX_CLIENT_INFO.version, manifest.version);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});
