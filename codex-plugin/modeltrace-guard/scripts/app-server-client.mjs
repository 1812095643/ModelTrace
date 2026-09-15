import { spawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import { readProtocolLines } from './protocol-lines.mjs';

export const CODEX_CLIENT_INFO = Object.freeze({ name: 'modeltrace_guard', version: '0.1.3' });

// Use Codex's own transport and configured account/provider, never a parallel
// hand-written Responses/Chat client. Do not print protocol history or stderr.
export async function codexExecutable(env = process.env) {
  if (env.MODELTRACE_CODEX_PATH) {
    if (!path.isAbsolute(env.MODELTRACE_CODEX_PATH)) throw new Error('MODELTRACE_CODEX_PATH must be an absolute executable path');
    await access(env.MODELTRACE_CODEX_PATH);
    return env.MODELTRACE_CODEX_PATH;
  }
  if (process.platform === 'win32' && env.LOCALAPPDATA) {
    const root = path.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const found = [];
    for (const entry of entries.filter((e) => e.isDirectory())) {
      const executable = path.join(root, entry.name, 'codex.exe');
      try { await access(executable); found.push(executable); } catch {}
    }
    if (found.length === 1) return found[0];
    if (found.length > 1) throw new Error('Multiple Codex runtimes found; set MODELTRACE_CODEX_PATH to the runtime used by this Codex app');
  }
  return process.platform === 'win32' ? 'codex.exe' : 'codex';
}

export class AppServerClient {
  constructor(child, protocolOptions = {}) {
    this.child = child; this.nextId = 0; this.pending = new Map(); this.listeners = new Set(); this.closed = false; this.allowedTurns = new Set(); this.failure = null;
    const rejectPending = (error) => {
      for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(error); }
      this.pending.clear();
    };
    const fail = (error) => {
      if (this.failure || this.closed) return;
      this.failure = error;
      rejectPending(error);
      this.lines?.close();
      child.kill();
    };
    this.exited = new Promise((resolve) => {
      const finish = () => {
        if (this.closed) return;
        this.closed = true; this.lines?.close();
        rejectPending(this.failure || new Error('Codex probe transport closed'));
        resolve();
      };
      child.once('exit', finish); child.once('error', finish);
    });
    this.lines = readProtocolLines(child.stdout, (message) => {
      const waiting = this.pending.get(message.id);
      if (waiting && !message.method) {
        this.pending.delete(message.id); clearTimeout(waiting.timer);
        if (message.error) {
          if (waiting.method === 'turn/start') this.allowedTurns.delete(waiting.threadId);
          waiting.reject(new Error(`Codex ${waiting.method}: ${message.error.message}`));
        }
        else waiting.resolve(message.result);
      } else if (message.method) {
        if (message.method === 'turn/started') {
          // One explicit request permits one turn, not automatic continuation.
          if (!this.allowedTurns.delete(message.params?.threadId)) {
            const error = new Error('Codex probe attempted an unrequested turn; no sample accepted');
            error.code = 'MODELTRACE_UNREQUESTED_TURN';
            fail(error); return;
          }
        }
        // A probe is text-only. Never approve a server-initiated tool/permission request.
        if (message.id !== undefined) this.write({ id: message.id, error: { code: -32601, message: 'ModelTrace probes do not execute tools or grant permissions' } });
        for (const listener of this.listeners) listener(message);
      }
    }, fail, protocolOptions);
    child.stderr.resume();
    child.stdin.on('error', (error) => { if (!this.closing) fail(error); });
  }
  write(message) { if (this.failure) throw this.failure; if (!this.closed) this.child.stdin.write(JSON.stringify(message) + '\n'); }
  request(method, params = {}, timeout = 15000) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error('Codex probe transport is closed'));
    if (method === 'turn/start') this.allowedTurns.add(params.threadId);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); if (method === 'turn/start') this.allowedTurns.delete(params.threadId); reject(new Error(`Codex ${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer, method, threadId: params.threadId });
      try { this.write({ id, method, params }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); if (method === 'turn/start') this.allowedTurns.delete(params.threadId); reject(error); }
    });
  }
  async close() {
    if (this.closed) return;
    this.closing = true;
    this.child.stdin.end();
    let timer;
    await Promise.race([this.exited, new Promise((resolve) => { timer = setTimeout(resolve, 2000); })]);
    clearTimeout(timer);
    if (!this.closed) this.child.kill();
    await Promise.race([this.exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Could not confirm temporary Codex process cleanup')), 3000);
    })]).finally(() => clearTimeout(timer));
    this.lines.close();
  }
}

export async function openAppServer(env = process.env) {
  const executable = await codexExecutable(env);
  const child = spawn(executable, ['app-server', '--stdio'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...env, MODELTRACE_PROBE_PROCESS: '1' },
  });
  const client = new AppServerClient(child);
  try {
    await client.request('initialize', { clientInfo: CODEX_CLIENT_INFO, capabilities: { experimentalApi: true } });
    client.write({ method: 'initialized' });
    return client;
  } catch (error) { await client.close(); throw error; }
}
