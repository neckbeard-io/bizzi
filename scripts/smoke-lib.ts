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

export interface Frame {
  dir: 'in' | 'out';
  msg: any;
}

export class Client {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<string, (m: any) => void>();
  listeners: ((e: any) => void)[] = [];
  /** Every frame sent and received, for validating against docs/protocol.schema.json. */
  readonly traffic: Frame[] = [];
  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      this.traffic.push({ dir: 'in', msg });
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
    const msg = { id, method, params };
    this.traffic.push({ dir: 'out', msg });
    this.#ws.send(JSON.stringify(msg));
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

type S = Record<string, any> | boolean;

const CONST_MISS = 'expected the constant';

/**
 * Validates `value` against `#/$defs/<def>` of docs/protocol.schema.json. Covers the keywords
 * scripts/gen-schema.ts emits (type, const, enum, properties, required, additionalProperties, items,
 * prefixItems, min/maxItems, allOf, anyOf, oneOf, not, $ref); returns the errors (empty = valid).
 */
export function validate(root: { $defs: Record<string, S> }, def: string, value: unknown): string[] {
  const errors: string[] = [];
  const resolve = (ref: string): S => {
    const name = ref.replace(/^#\/\$defs\//, '');
    const s = root.$defs[name];
    if (s === undefined) throw new Error(`unresolved $ref ${ref}`);
    return s;
  };
  const typeOk = (t: string, v: unknown): boolean =>
    t === 'null' ? v === null : t === 'array' ? Array.isArray(v) : t === 'object' ? typeof v === 'object' && v !== null && !Array.isArray(v) : t === 'integer' ? Number.isInteger(v) : typeof v === t;
  const walk = (s: S, v: unknown, at: string, out: string[]): void => {
    if (s === true) return;
    if (s === false) return void out.push(`${at}: not allowed`);
    if (s.$ref) walk(resolve(s.$ref), v, at, out);
    if (s.type !== undefined && !(Array.isArray(s.type) ? s.type : [s.type]).some((t: string) => typeOk(t, v))) {
      return void out.push(`${at}: expected ${s.type}, got ${JSON.stringify(v)?.slice(0, 80)}`);
    }
    if ('const' in s && v !== s.const) out.push(`${at}: ${CONST_MISS} ${JSON.stringify(s.const)}, got ${JSON.stringify(v)?.slice(0, 80)}`);
    if (s.enum && !s.enum.includes(v)) out.push(`${at}: ${JSON.stringify(v)} not in ${JSON.stringify(s.enum)}`);
    if (s.not && sub(s.not, v, at).length === 0) out.push(`${at}: matches a forbidden schema`);
    if (typeOk('object', v)) {
      const o = v as Record<string, unknown>;
      for (const r of s.required ?? []) if (!(r in o)) out.push(`${at}: missing ${r}`);
      for (const [k, pv] of Object.entries(o)) {
        if (s.properties?.[k] !== undefined) walk(s.properties[k], pv, `${at}.${k}`, out);
        else if (s.additionalProperties !== undefined) walk(s.additionalProperties, pv, `${at}.${k}`, out);
      }
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) out.push(`${at}: fewer than ${s.minItems} items`);
      if (s.maxItems !== undefined && v.length > s.maxItems) out.push(`${at}: more than ${s.maxItems} items`);
      v.forEach((x, i) => {
        const item = s.prefixItems?.[i] ?? s.items;
        if (item !== undefined) walk(item, x, `${at}[${i}]`, out);
      });
    }
    for (const a of s.allOf ?? []) walk(a, v, at, out);
    if (s.anyOf && !s.anyOf.some((a: S) => sub(a, v, at).length === 0)) out.push(`${at}: matches none of anyOf (${best(s.anyOf, v, at)})`);
    if (s.oneOf) {
      const n = s.oneOf.filter((a: S) => sub(a, v, at).length === 0).length;
      if (n !== 1) out.push(`${at}: matches ${n} of oneOf${n === 0 ? ` (${best(s.oneOf, v, at)})` : ''}`);
    }
  };
  const sub = (s: S, v: unknown, at: string): string[] => {
    const out: string[] = [];
    walk(s, v, at, out);
    return out;
  };
  /**
   * The errors of the closest alternative, to make a failed anyOf/oneOf readable. Alternatives that
   * fail on a `const` (a different `method` / `type`) rank last.
   */
  const constMisses = (errs: string[]) => errs.filter((e) => e.includes(CONST_MISS)).length;
  const best = (alts: S[], v: unknown, at: string): string =>
    alts
      .map((a) => sub(a, v, at))
      .sort((x, y) => constMisses(x) - constMisses(y) || x.length - y.length)[0]!
      .slice(0, 3)
      .join('; ');
  walk({ $ref: `#/$defs/${def}` }, value, def, errors);
  return errors;
}

/**
 * Checks recorded traffic against the published schema: requests as RequestMsg, results as
 * `result:<method>`, errors as ResponseErrMsg, events as ChannelEvent. Returns one line per problem.
 */
export function validateTraffic(root: { $defs: Record<string, S> }, frames: readonly Frame[]): string[] {
  const methods = new Map<string, string>();
  const problems = new Set<string>();
  for (const { dir, msg } of frames) {
    let def: string;
    if (dir === 'out') {
      methods.set(msg.id, msg.method);
      def = 'RequestMsg';
    } else if (typeof msg.ch === 'string') def = 'ChannelEvent';
    else if (msg.error) def = 'ResponseErrMsg';
    else {
      const method = methods.get(msg.id);
      if (!method) continue;
      for (const e of validate(root, `result:${method}`, msg.result)) problems.add(`${method} result: ${e}`);
      continue;
    }
    const label = dir === 'out' ? `${msg.method} request` : typeof msg.ch === 'string' ? `${msg.type} event` : 'error response';
    for (const e of validate(root, def, msg)) problems.add(`${label}: ${e}`);
  }
  return [...problems];
}
