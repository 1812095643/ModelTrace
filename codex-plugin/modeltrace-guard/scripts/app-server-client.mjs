import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';

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
  constructor(child) {
    this.child = child; this.nextId = 0; this.pending = new Map(); this.listeners = new Set(); this.closed = false; this.allowedTurns = new Set();
    this.lines = createInterface({ input: child.stdout });
    child.stderr.resume();
    this.lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const waiting = this.pending.get(message.id);
      if (waiting && !message.method) {
        this.pending.delete(message.id); clearTimeout(waiting.timer);
        if (message.error) waiting.reject(new Error(`Codex ${waiting.method}: ${message.error.message}`));
        else waiting.resolve(message.result);
      } else if (message.method) {
        if (message.method === 'turn/started' && !this.allowedTurns.has(message.params?.threadId)) {
          // A baseline/doctor must never trigger an inherited automatic goal.
          child.kill(); return;
        }
        // A probe is text-only. Never approve a server-initiated tool/permission request.
        if (message.id !== undefined) this.write({ id: message.id, error: { code: -32601, message: 'ModelTrace probes do not execute tools or grant permissions' } });
        for (const listener of this.listeners) listener(message);
      }
    });
    this.exited = new Promise((resolve) => {
      const finish = () => {
        if (this.closed) return;
        this.closed = true;
        for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error('Codex probe transport closed')); }
        this.pending.clear(); resolve();
      };
      child.once('exit', finish); child.once('error', finish);
    });
    child.stdin.on('error', () => {});
  }
  write(message) { if (!this.closed) this.child.stdin.write(JSON.stringify(message) + '\n'); }
  request(method, params = {}, timeout = 15000) {
    if (this.closed) return Promise.reject(new Error('Codex probe transport is closed'));
    if (method === 'turn/start') this.allowedTurns.add(params.threadId);
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer, method }); this.write({ id, method, params });
    });
  }
  async close() {
    if (this.closed) return;
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
    await client.request('initialize', { clientInfo: { name: 'modeltrace_guard', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    client.write({ method: 'initialized' });
    return client;
  } catch (error) { await client.close(); throw error; }
}
