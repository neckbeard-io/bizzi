// Shared helpers for the end-to-end smoke scripts: spawn `bizzi` processes, a minimal protocol client.

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface Started {
  proc: ChildProcess;
  ready: any;
}

/** Spawns `bizzi <args>` and resolves with its JSON ready line. Warnings and errors are echoed. */
export class Procs {
  readonly list: ChildProcess[] = [];

  start(args: string[], env: Record<string, string> = {}): Promise<Started> {
    const proc = spawn(process.execPath, ['apps/cli/src/main.ts', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BIZZI_LOG_LEVEL: 'warn', ...env },
    });
    this.list.push(proc);
    proc.stderr!.on('data', (d) => {
      const s = String(d);
      if (/"level":"(error|warn)"/.test(s)) process.stderr.write(`  [${args[0]}] ${s}`);
    });
    return new Promise((resolve, reject) => {
      createInterface({ input: proc.stdout! }).once('line', (l) => resolve({ proc, ready: JSON.parse(l) }));
      proc.once('exit', (c) => reject(new Error(`${args.join(' ')} exited ${c}`)));
    });
  }

  async stopAll(): Promise<void> {
    const running = this.list.filter((p) => p.exitCode === null && p.signalCode === null);
    for (const p of running) p.kill('SIGTERM');
    const kill = setTimeout(() => running.forEach((p) => p.exitCode === null && p.kill('SIGKILL')), 10_000);
    await Promise.all(running.map((p) => new Promise((r) => (p.exitCode !== null ? r(null) : p.once('exit', r)))));
    clearTimeout(kill);
  }
}

export class Client {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<string, (m: any) => void>();
  listeners: ((e: any) => void)[] = [];
  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id && this.#pending.has(msg.id)) {
        this.#pending.get(msg.id)!(msg);
        this.#pending.delete(msg.id);
      } else if (msg.ch) for (const l of this.listeners) l(msg);
    };
  }
  static async open(url: string): Promise<Client> {
    const ws = new WebSocket(url);
    await new Promise((r, j) => {
      ws.onopen = r;
      ws.onerror = j;
    });
    return new Client(ws);
  }
  call(method: string, params: unknown): Promise<any> {
    const id = `r_${++this.#id}`;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) =>
      this.#pending.set(id, (m) => (m.error ? reject(Object.assign(new Error(`${method}: ${m.error.message}`), { code: m.error.code })) : resolve(m.result))),
    );
  }
  /** Resolves with the first event (on any subscribed channel) matching `pred`. */
  next(pred: (e: any) => boolean, what: string, timeoutMs = 10_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.listeners = this.listeners.filter((l) => l !== on);
        reject(new Error(`timed out waiting for ${what}`));
      }, timeoutMs);
      const on = (e: any) => {
        if (!pred(e)) return;
        clearTimeout(t);
        this.listeners = this.listeners.filter((l) => l !== on);
        resolve(e);
      };
      this.listeners.push(on);
    });
  }
  close() {
    this.#ws.close();
  }
}

export const step = (s: string) => console.log(`• ${s}`);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns a truthy value. */
export async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

export function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`check failed: ${what}`);
}
