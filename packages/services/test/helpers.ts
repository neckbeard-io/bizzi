// Test harness: a real core node (event bus, sessions, workspaces) plus a minimal ExtensionContext
// wired the way the core's NodeExtension API will wire it, so the extensions can be tested before
// `createNode({ extensions })` lands.

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { createNode, type BizziNode, type NodeOptions } from '@bizzi/core';
import {
  GLOBAL_CHANNEL,
  sessionChannel,
  type AdapterContext,
  type AdapterSession,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentProbe,
  type ChannelEvent,
  type EmitFn,
  type Logger,
  type SessionMode,
  type StartSessionOptions,
} from '@bizzi/protocol';
import type { AgentEnvProvider, ExtensionContext, NodeExtension } from '../src/index.ts';

export const logger: Logger = { log() {}, child: () => logger };

/** Captures every log line (to check that secrets never reach a log). */
export function capturingLogger(): Logger & { lines: { level: string; msg: string; fields?: Record<string, unknown> }[] } {
  const lines: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const l = {
    lines,
    log(level: string, msg: string, fields?: Record<string, unknown>) {
      lines.push({ level, msg, ...(fields ? { fields } : {}) });
    },
    child: () => l,
  };
  return l as Logger & { lines: typeof lines };
}

export function tempDir(prefix = 'bizzi-services-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function writeScript(path: string, body: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(pred: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/**
 * Wraps an adapter so `command` reaches StartSessionOptions even while the core's `session.create`
 * doesn't forward it yet: the harness stashes the command of each `session.create` call.
 */
export class CommandStashAdapter implements AgentAdapter {
  readonly inner: AgentAdapter;
  readonly starts: StartSessionOptions[] = [];
  readonly stash: string[][] = [];
  constructor(inner: AgentAdapter) {
    this.inner = inner;
  }
  get agent() {
    return this.inner.agent;
  }
  probe(): Promise<AgentProbe> {
    return this.inner.probe();
  }
  capabilities(mode: SessionMode): AgentCapabilities {
    return this.inner.capabilities(mode);
  }
  start(opts: StartSessionOptions, emit: EmitFn, ctx: AdapterContext): Promise<AdapterSession> {
    const stashed = this.stash.shift();
    const full = opts.command || !stashed ? opts : { ...opts, command: stashed };
    this.starts.push(full);
    return this.inner.start(full, emit, ctx);
  }
}

export interface Harness {
  node: BizziNode;
  ctx: ExtensionContext;
  dataDir: string;
  /** Every global event since the harness started. */
  global: ChannelEvent[];
  envProvider(): AgentEnvProvider | undefined;
  call(ext: NodeExtension, method: keyof NodeExtension['methods'], params?: unknown): Promise<any>;
  sessionEvents(sessionId: string): ChannelEvent[];
  close(): Promise<void>;
}

export interface HarnessOptions {
  adapters?: AgentAdapter[];
  extensions?: NodeExtension[];
  /** Adapters that receive the stashed `command` of session.create calls. */
  commandAdapters?: CommandStashAdapter[];
}

export async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const dataDir = tempDir('bizzi-services-node-');
  let provider: AgentEnvProvider | undefined;
  const nodeOpts: NodeOptions = {
    dataDir,
    adapters: opts.adapters ?? [],
    logger,
    version: '0.0.0-test',
    // What the core's setAgentEnvProvider does: merge the provider's env into every session start.
    prepareStart: async (session) => (provider ? { env: await provider(session.agent) } : {}),
  };
  const node = await createNode(nodeOpts);
  const global: ChannelEvent[] = [];
  const globalSub = node.subscribe(GLOBAL_CHANNEL, node.bus.lastSeq(GLOBAL_CHANNEL), (ev) => global.push(ev));

  // Route session.create's command to the stash adapters (see CommandStashAdapter).
  const call = (async (method: string, params: any) => {
    if (method === 'session.create' && Array.isArray(params?.command)) {
      for (const a of opts.commandAdapters ?? []) if (a.agent === params.agent) a.stash.push(params.command);
    }
    return node.dispatch(method, params);
  }) as BizziNode['call'];
  // A proxy (not Object.create): the node's methods use private fields, so `this` must stay the node.
  const wrapped = new Proxy(node, {
    get(target, prop) {
      if (prop === 'call') return call;
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });

  const ctx: ExtensionContext = {
    node: wrapped,
    logger,
    emitGlobal: (body) => void node.bus.append(GLOBAL_CHANNEL, body),
    emitSession: (sessionId, body) => void node.bus.append(sessionChannel(sessionId), body),
    setAgentEnvProvider: (fn) => {
      provider = fn;
    },
  };
  for (const ext of opts.extensions ?? []) await ext.start?.(ctx);

  return {
    node,
    ctx,
    dataDir,
    global,
    envProvider: () => provider,
    async call(ext, method, params = {}) {
      const fn = ext.methods[method];
      if (!fn) throw new Error(`extension has no ${method}`);
      return fn(params, ctx);
    },
    sessionEvents: (sessionId) => node.bus.replay(sessionChannel(sessionId)),
    async close() {
      for (const ext of opts.extensions ?? []) await ext.stop?.();
      globalSub.unsubscribe();
      await node.close();
    },
  };
}

/** Does this core's createNode accept `extensions`? (The API lands in parallel.) */
export async function coreSupportsExtensions(): Promise<boolean> {
  const dataDir = tempDir('bizzi-services-probe-');
  const probe: NodeExtension = { methods: { 'agent.secrets': () => ({ secrets: [], extensionProbe: true }) } };
  const node = await createNode({ dataDir, adapters: [], logger, version: '0', extensions: [probe] } as NodeOptions);
  try {
    const r = (await node.call('agent.secrets', {})) as { extensionProbe?: boolean };
    return r.extensionProbe === true;
  } catch {
    return false;
  } finally {
    await node.close();
  }
}
