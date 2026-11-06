import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type ChannelEvent, type ErrorObject } from '@bizzi/protocol';
import WebSocket from 'ws';
import { pairWithHub, requestToken, startHub, type BizziHub, type HubCredential, type HubOptions } from '../src/index.ts';

export function tempDir(prefix = 'bizzi-hub-'): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(os.tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 5000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function makeHub(dataDir: string, extra: Partial<HubOptions> = {}): Promise<BizziHub> {
  return startHub({ dataDir, port: 0, version: '0.0.0-test', onSetupCode: () => {}, ...extra });
}

export function setupCode(hub: BizziHub): string {
  return readFileSync(hub.setupCodeFile, 'utf8').trim();
}

/** Pair a device ('device' kind) and return its credential. */
export async function pairDevice(hub: BizziHub, code: string, name = 'test-device'): Promise<HubCredential> {
  const { credential } = await pairWithHub({ hubUrl: hub.url, code, kind: 'device', name });
  return credential;
}

export async function tokenFor(hub: BizziHub, cred: HubCredential): Promise<string> {
  return (await requestToken({ hubUrl: hub.url, deviceId: cred.deviceId, privateKey: cred.privateKey })).token;
}

export async function postJson(url: string, body: unknown): Promise<{ status: number; body: { error?: ErrorObject } & Record<string, unknown> }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as { error?: ErrorObject } & Record<string, unknown> };
}

type Reply = { result?: unknown; error?: ErrorObject };

export class TestClient {
  readonly ws: WebSocket;
  readonly events: ChannelEvent[] = [];
  readonly opened: Promise<void>;
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly #pending = new Map<string, (m: Reply) => void>();
  #n = 0;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
    this.closed = new Promise((resolve) => this.ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if ('ch' in msg) this.events.push(msg);
      else this.#pending.get(msg.id)?.(msg);
    });
  }

  static async connect(url: string, token: string): Promise<TestClient> {
    const c = new TestClient(url);
    await c.call('hello', { protocol: PROTOCOL_VERSION, client: { name: 'test', version: '0' }, token });
    return c;
  }

  async request(method: string, params: unknown = {}): Promise<Reply> {
    await this.opened;
    const id = `r_${++this.#n}`;
    return new Promise<Reply>((resolve) => {
      this.#pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async call<T = Record<string, unknown>>(method: string, params: unknown = {}): Promise<T> {
    const r = await this.request(method, params);
    if (r.error) throw Object.assign(new Error(`${method}: ${r.error.message}`), { code: r.error.code });
    return r.result as T;
  }

  on(ch: string): ChannelEvent[] {
    return this.events.filter((e) => e.ch === ch);
  }

  close(): void {
    this.ws.close();
  }
}

/** Asserts seqs are exactly from..to with no gaps or duplicates; returns them. */
export function seqs(events: ChannelEvent[]): number[] {
  return events.map((e) => e.seq);
}

export function contiguous(events: ChannelEvent[], from = 1): boolean {
  return events.every((e, i) => e.seq === from + i);
}
