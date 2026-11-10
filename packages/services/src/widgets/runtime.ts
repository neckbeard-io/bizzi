// Widgets runtime (docs/usage.md §4): loads `<config>/widgets/*.json`, runs each widget's source on its
// interval (http GET + JSONPath, or a command printing one JSON object / line), caches the rendered
// value, publishes `widget.updated` / `widget.removed` on the node's global channel, and serves
// `widgets.list` / `widget.refresh`. A widget with `billing.account` also feeds usage.list.
//
// Trust: http widgets execute nothing. A command widget is code on this machine, the same trust as a
// terminal; files can only be created by someone who can write the widgets directory.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { BizziError, type AccountUsage, type Logger, type WidgetValue } from '@bizzi/protocol';
import { expand, jsonPath, scrub, type TemplateContext } from './expr.ts';
import {
  AGENTS_FILE,
  SCHEMA_FILE,
  WIDGET_JSON_SCHEMA,
  WIDGET_TONES,
  WIDGETS_AGENTS_MD,
  idFromFile,
  parseWidget,
  type CommandSource,
  type HttpSource,
  type WidgetDef,
  type WidgetTone,
} from './schema.ts';
import { asParams, checkMachine, reqString } from '../params.ts';
import type { ExtensionContext, NodeExtension } from '../types.ts';

/** An unchanged value is republished at most this often (to refresh its age on clients). */
export const WIDGET_REPUBLISH_MS = 10 * 60_000;
export const MAX_HTTP_BYTES = 1024 * 1024;
export const MAX_COMMAND_OUTPUT = 64 * 1024;
const MAX_TEXT = 200;

/** `$BIZZI_WIDGETS_DIR`, else `$XDG_CONFIG_HOME/bizzi/widgets`, else `~/.config/bizzi/widgets`. */
export function defaultWidgetsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BIZZI_WIDGETS_DIR) return resolve(env.BIZZI_WIDGETS_DIR);
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'bizzi', 'widgets');
}

export interface WidgetsOptions {
  /** Default defaultWidgetsDir(). */
  dir?: string;
  /** Environment for `${env:…}` and command widgets (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** `${secret:NAME}` lookup (the node's secret store). Without it secrets are "not found". */
  secret?: (name: string) => Promise<string | undefined>;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Watch the directory for changes (default true). */
  watch?: boolean;
  /** Default WIDGET_REPUBLISH_MS. */
  republishMs?: number;
}

export interface WidgetsExtension extends NodeExtension {
  readonly dir: string;
  /** Current values, by id. */
  list(): WidgetValue[];
  /** Run a widget now (the in-flight run, if one is running). */
  refresh(widgetId: string): Promise<WidgetValue>;
  /** Re-read the directory (the watcher calls this). */
  rescan(): void;
  /** Resolves when no run is in flight. */
  idle(): Promise<void>;
}

/** What a source run produced. */
interface Output {
  text?: string;
  value?: number;
  max?: number;
  tone?: WidgetTone;
  tooltip?: string;
  link?: string;
  resetsAt?: string;
}

interface Slot {
  file: string;
  /** File content, to skip unchanged files on rescan. */
  raw: string;
  def?: WidgetDef;
  value: WidgetValue;
  timer?: NodeJS.Timeout;
  running?: Promise<WidgetValue>;
  abort: AbortController;
  sig?: string;
  publishedAt: number;
  /** The last logged failure, to log transitions only. */
  lastError?: string;
}

class RunError extends Error {}

export function createWidgetsExtension(opts: WidgetsOptions = {}): WidgetsExtension {
  return new Widgets(opts);
}

class Widgets implements WidgetsExtension {
  readonly dir: string;
  readonly methods: NodeExtension['methods'];
  readonly #o: WidgetsOptions;
  readonly #env: NodeJS.ProcessEnv;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #slots = new Map<string, Slot>();
  #ctx?: ExtensionContext;
  #log: Logger = { log() {}, child: () => this.#log };
  #watcher?: FSWatcher;
  #debounce?: NodeJS.Timeout;
  #stopped = false;

  constructor(o: WidgetsOptions) {
    this.#o = o;
    this.dir = resolve(o.dir ?? defaultWidgetsDir(o.env));
    this.#env = o.env ?? process.env;
    this.#fetch = o.fetch ?? fetch;
    this.#now = o.now ?? (() => new Date());
    this.methods = {
      'widgets.list': (p: unknown, ctx: ExtensionContext) => {
        checkMachine(asParams(p), ctx.node.machine.id);
        return { widgets: this.list() };
      },
      'widget.refresh': async (p: unknown, ctx: ExtensionContext) => {
        const params = asParams(p);
        checkMachine(params, ctx.node.machine.id);
        return { widget: await this.refresh(reqString(params, 'widgetId')) };
      },
    };
  }

  start(ctx: ExtensionContext): void {
    this.#ctx = ctx;
    this.#log = ctx.logger.child({ component: 'widgets' });
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.#writeDocs();
    this.rescan();
    if (this.#o.watch !== false) {
      try {
        this.#watcher = watch(this.dir, () => {
          clearTimeout(this.#debounce);
          this.#debounce = setTimeout(() => this.rescan(), 150);
          this.#debounce.unref();
        });
        this.#watcher.on('error', (err) => this.#log.log('warn', 'widgets directory watch failed', { dir: this.dir, err: String(err) }));
      } catch (err) {
        this.#log.log('warn', 'cannot watch the widgets directory; changes need a restart', { dir: this.dir, err: String(err) });
      }
    }
    this.#log.log('info', 'widgets ready', { dir: this.dir, widgets: this.#slots.size });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#watcher?.close();
    clearTimeout(this.#debounce);
    for (const s of this.#slots.values()) this.#halt(s);
    await this.idle();
  }

  list(): WidgetValue[] {
    return [...this.#slots.values()].map((s) => ({ ...s.value })).sort((a, b) => a.id.localeCompare(b.id));
  }

  async refresh(widgetId: string): Promise<WidgetValue> {
    const slot = [...this.#slots.values()].find((s) => s.value.id === widgetId);
    if (!slot) throw new BizziError('not_found', `widget ${widgetId} not found`);
    if (!slot.def) return { ...slot.value };
    return { ...(await this.#run(slot)) };
  }

  async idle(): Promise<void> {
    await Promise.allSettled([...this.#slots.values()].map((s) => s.running));
  }

  /** Write the schema (ours, kept current) and AGENTS.md (only when missing; the user may edit it). */
  #writeDocs(): void {
    const schema = JSON.stringify(WIDGET_JSON_SCHEMA, null, 2) + '\n';
    const schemaPath = join(this.dir, SCHEMA_FILE);
    try {
      if (!existsSync(schemaPath) || readFileSync(schemaPath, 'utf8') !== schema) writeFileSync(schemaPath, schema);
      const agents = join(this.dir, AGENTS_FILE);
      if (!existsSync(agents)) writeFileSync(agents, WIDGETS_AGENTS_MD);
    } catch (err) {
      this.#log.log('warn', 'could not write widget docs', { dir: this.dir, err: String(err) });
    }
  }

  rescan(): void {
    if (this.#stopped) return;
    let files: string[];
    try {
      files = readdirSync(this.dir)
        .filter((f) => f.endsWith('.json') && !f.endsWith('.schema.json') && !f.startsWith('.'))
        .sort();
    } catch (err) {
      this.#log.log('warn', 'cannot read the widgets directory', { dir: this.dir, err: String(err) });
      return;
    }
    const present = new Set(files);
    for (const [file, slot] of [...this.#slots]) {
      if (present.has(file)) continue;
      this.#halt(slot);
      this.#slots.delete(file);
      this.#log.log('info', 'widget removed', { id: slot.value.id, file });
      this.#emit({ type: 'widget.removed', data: { machineId: this.#machineId(), widgetId: slot.value.id } });
    }
    for (const file of files) {
      let raw: string;
      try {
        raw = readFileSync(join(this.dir, file), 'utf8');
      } catch {
        continue; // removed between readdir and read; the next event rescans
      }
      const prev = this.#slots.get(file);
      if (prev && prev.raw === raw) continue;
      this.#load(file, raw, prev);
    }
  }

  #load(file: string, raw: string, prev: Slot | undefined): void {
    if (prev) this.#halt(prev);
    let parsed: ReturnType<typeof parseWidget>;
    try {
      parsed = parseWidget(JSON.parse(raw) as unknown, file);
    } catch (err) {
      parsed = { errors: [`not valid JSON: ${(err as Error).message}`] };
    }
    if ('def' in parsed) {
      const id = parsed.def.id;
      const clash = [...this.#slots.values()].find((s) => s.file !== file && s.value.id === id);
      if (clash) parsed = { errors: [`id ${id} is already used by ${clash.file}`] };
    }
    const machineId = this.#machineId();
    if (prev && 'def' in parsed && prev.value.id !== parsed.def.id) {
      this.#emit({ type: 'widget.removed', data: { machineId, widgetId: prev.value.id } });
    }

    if ('errors' in parsed) {
      const error = `invalid widget file ${file}: ${parsed.errors.slice(0, 5).join('; ')}`;
      this.#log.log('warn', 'invalid widget file', { file, errors: parsed.errors });
      const id = prev?.value.id ?? safeId(idFromFile(file));
      const value: WidgetValue = prev
        ? { ...prev.value, error }
        : { id, machineId, label: idFromFile(file), kind: 'status', placement: ['machine'], tone: 'error', error };
      const slot: Slot = { file, raw, value, abort: new AbortController(), publishedAt: 0 };
      this.#slots.set(file, slot);
      this.#publish(slot);
      return;
    }

    const def = parsed.def;
    const value: WidgetValue = { id: def.id, machineId, label: def.label, kind: def.kind, placement: def.placement };
    if (def.format) value.format = def.format;
    if (def.tooltip) value.tooltip = def.tooltip;
    if (def.link) value.link = def.link;
    // Same widget, new definition: keep showing the last value until the first run finishes.
    if (prev && prev.def && prev.value.id === def.id) {
      for (const k of ['text', 'value', 'max', 'tone', 'resetsAt', 'observedAt'] as const) {
        if (prev.value[k] !== undefined) (value as unknown as Record<string, unknown>)[k] = prev.value[k];
      }
    }
    const slot: Slot = { file, raw, def, value, abort: new AbortController(), publishedAt: 0 };
    this.#slots.set(file, slot);
    this.#log.log('info', 'widget loaded', { id: def.id, file, source: def.source.type, everyMs: def.everyMs });
    void this.#run(slot);
  }

  #halt(slot: Slot): void {
    clearTimeout(slot.timer);
    slot.timer = undefined;
    slot.abort.abort();
  }

  #active(slot: Slot): boolean {
    return !this.#stopped && this.#slots.get(slot.file) === slot && !slot.abort.signal.aborted;
  }

  #run(slot: Slot): Promise<WidgetValue> {
    if (slot.running) return slot.running;
    const def = slot.def;
    if (!def) return Promise.resolve(slot.value);
    clearTimeout(slot.timer);
    slot.timer = undefined;
    const run = (async () => {
      const secrets: string[] = [];
      try {
        const out = await this.#execute(def, slot.abort.signal, secrets);
        if (!this.#active(slot)) return slot.value;
        this.#succeed(slot, def, out);
      } catch (err) {
        if (!this.#active(slot)) return slot.value;
        const msg = scrub(err instanceof Error ? err.message : String(err), secrets).slice(0, 500);
        slot.value = { ...slot.value, error: msg };
        if (slot.lastError !== msg) this.#log.log('warn', 'widget run failed', { id: def.id, error: msg });
        slot.lastError = msg;
      }
      this.#publish(slot);
      return slot.value;
    })().finally(() => {
      slot.running = undefined;
      if (this.#active(slot)) {
        slot.timer = setTimeout(() => void this.#run(slot), def.everyMs);
        slot.timer.unref();
      }
    });
    slot.running = run;
    return run;
  }

  #succeed(slot: Slot, def: WidgetDef, out: Output): void {
    if (def.kind === 'meter' && out.value === undefined) throw new RunError('a meter needs a value');
    const v: WidgetValue = { id: def.id, machineId: this.#machineId(), label: def.label, kind: def.kind, placement: def.placement };
    if (def.format) v.format = def.format;
    if (out.text !== undefined) v.text = out.text;
    if (out.value !== undefined) v.value = out.value;
    if (out.max !== undefined) v.max = out.max;
    const tone = out.tone ?? thresholdTone(def, out);
    if (tone) v.tone = tone;
    const tooltip = out.tooltip ?? def.tooltip;
    const link = out.link ?? def.link;
    if (tooltip) v.tooltip = tooltip;
    if (link) v.link = link;
    if (out.resetsAt) v.resetsAt = out.resetsAt;
    v.observedAt = this.#now().toISOString();
    slot.value = v;
    if (slot.lastError !== undefined) this.#log.log('info', 'widget recovered', { id: def.id });
    slot.lastError = undefined;
    if (def.billing && v.value !== undefined) this.#reportUsage(def, v);
  }

  #reportUsage(def: WidgetDef, v: WidgetValue): void {
    const b = def.billing!;
    const ratio = v.max ? v.value! / v.max : undefined;
    const status: AccountUsage['status'] = ratio !== undefined && ratio >= 1 ? 'limited' : v.tone === 'warn' || v.tone === 'error' ? 'warning' : 'ok';
    const spend: NonNullable<AccountUsage['spend']> = { usd: v.value! };
    if (v.max !== undefined) spend.capUsd = v.max;
    if (b.period) spend.period = b.period;
    if (v.resetsAt) spend.resetsAt = v.resetsAt;
    const usage: AccountUsage = {
      agent: b.agent,
      accountId: b.account,
      label: b.label ?? def.label,
      billing: b.billing,
      machines: [this.#machineId()],
      spend,
      status,
      observedAt: v.observedAt!,
    };
    try {
      this.#ctx?.node.usage.report(usage);
    } catch (err) {
      this.#log.log('warn', 'could not report widget usage', { id: def.id, err: String(err) });
    }
  }

  #publish(slot: Slot): void {
    if (this.#stopped) return;
    const { observedAt: _observedAt, ...rest } = slot.value;
    const sig = JSON.stringify(rest);
    const now = this.#now().getTime();
    if (slot.sig === sig && now - slot.publishedAt < (this.#o.republishMs ?? WIDGET_REPUBLISH_MS)) return;
    slot.sig = sig;
    slot.publishedAt = now;
    this.#emit({ type: 'widget.updated', data: { widget: { ...slot.value } } });
  }

  #emit(body: Parameters<ExtensionContext['emitGlobal']>[0]): void {
    if (this.#stopped || !this.#ctx) return;
    try {
      this.#ctx.emitGlobal(body);
    } catch (err) {
      this.#log.log('warn', 'could not publish widget event', { err: String(err) });
    }
  }

  #machineId(): string {
    return this.#ctx?.node.machine.id ?? '';
  }

  // ---- sources -------------------------------------------------------------------------------

  #execute(def: WidgetDef, stop: AbortSignal, secrets: string[]): Promise<Output> {
    const signal = AbortSignal.any([stop, AbortSignal.timeout(def.timeoutMs)]);
    return def.source.type === 'http' ? this.#http(def.source, signal, def.timeoutMs, secrets) : this.#command(def.source, signal, def.timeoutMs, secrets);
  }

  #templates(allowSecrets: boolean): TemplateContext {
    return { env: this.#env, allowSecrets, ...(this.#o.secret ? { secret: this.#o.secret } : {}) };
  }

  async #http(src: HttpSource, signal: AbortSignal, timeoutMs: number, secrets: string[]): Promise<Output> {
    const t = this.#templates(true);
    const url = await expand(src.url, t, secrets);
    if (!/^https?:\/\//i.test(url)) throw new RunError('url is not http(s) after templating');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(src.headers)) headers[k] = await expand(v, t, secrets);
    let res: Response;
    try {
      // Never follow a redirect while carrying a secret: it could forward the credential elsewhere.
      res = await this.#fetch(url, { method: 'GET', headers, signal, redirect: secrets.length > 0 ? 'error' : 'follow' });
    } catch (err) {
      throw new RunError(signal.aborted ? `timed out after ${timeoutMs / 1000}s` : `request failed: ${errText(err)}`);
    }
    const body = await readCapped(res, MAX_HTTP_BYTES, signal);
    if (!res.ok) throw new RunError(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
    const paths = src.paths;
    if (Object.keys(paths).length === 0) {
      const text = firstLine(body);
      if (!text) throw new RunError('empty response');
      return { text };
    }
    let doc: unknown;
    try {
      doc = JSON.parse(body);
    } catch {
      throw new RunError('response is not JSON');
    }
    const out: Output = {};
    for (const [field, path] of Object.entries(paths) as [keyof Output, string][]) {
      const v = jsonPath(doc, path);
      if (field === 'value' || field === 'max') {
        if (v === undefined || v === null) {
          if (field === 'value') throw new RunError(`no value at ${path}`);
          continue; // no cap (e.g. LiteLLM max_budget null)
        }
        const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
        if (!Number.isFinite(n)) throw new RunError(`${field} at ${path} is not a number`);
        out[field] = n;
      } else if (v !== undefined && v !== null) {
        assign(out, field, typeof v === 'string' ? v : JSON.stringify(v));
      }
    }
    return out;
  }

  async #command(src: CommandSource, signal: AbortSignal, timeoutMs: number, secrets: string[]): Promise<Output> {
    const argv: string[] = [];
    for (const a of src.command) argv.push(await expand(a, this.#templates(false), secrets));
    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries(src.env)) extra[k] = await expand(v, this.#templates(true), secrets);
    const [exe0, ...args] = argv;
    const exe = exe0!.includes('/') && !isAbsolute(exe0!) ? resolve(this.dir, exe0!) : exe0!;
    const cwd = src.cwd ? resolve(this.dir, await expand(src.cwd, this.#templates(false), secrets)) : this.dir;
    const { code, stdout, stderr, timedOut, error } = await runProcess(exe, args, { cwd, env: { ...this.#env, ...extra }, signal });
    if (error) throw new RunError(`cannot run ${exe0}: ${error}`);
    if (timedOut) throw new RunError(`timed out after ${timeoutMs / 1000}s`);
    if (code !== 0) {
      const why = firstLine(stderr);
      throw new RunError(`exit ${code ?? 'signal'}${why ? `: ${why}` : ''}`);
    }
    return parseCommandOutput(stdout);
  }
}

function safeId(s: string): string {
  const id = s.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64);
  return id || 'widget';
}

function errText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
  }
  return String(err);
}

function firstLine(s: string): string {
  const line = s.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.slice(0, MAX_TEXT);
}

function assign(out: Output, field: keyof Output, v: string): void {
  switch (field) {
    case 'text':
      out.text = v.slice(0, MAX_TEXT);
      break;
    case 'tone':
      if (!WIDGET_TONES.includes(v as WidgetTone)) throw new RunError(`tone must be one of ${WIDGET_TONES.join(', ')}`);
      out.tone = v as WidgetTone;
      break;
    case 'tooltip':
      out.tooltip = v.slice(0, 500);
      break;
    case 'link':
      if (/^https?:\/\//i.test(v)) out.link = v.slice(0, 2000);
      break;
    case 'resetsAt':
      if (Number.isFinite(Date.parse(v))) out.resetsAt = new Date(v).toISOString();
      break;
    default:
      break;
  }
}

/** One JSON object `{ text?, value?, max?, tone?, tooltip?, link?, resetsAt? }`, or one plain line. */
export function parseCommandOutput(stdout: string): Output {
  const s = stdout.trim();
  if (!s) throw new RunError('the command printed nothing');
  if (!s.startsWith('{')) return { text: firstLine(s) };
  let o: unknown;
  try {
    o = JSON.parse(s);
  } catch {
    throw new RunError('output starts with { but is not one JSON object');
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new RunError('output is not a JSON object');
  const r = o as Record<string, unknown>;
  const out: Output = {};
  for (const k of ['value', 'max'] as const) {
    if (r[k] === undefined || r[k] === null) continue;
    if (typeof r[k] !== 'number' || !Number.isFinite(r[k])) throw new RunError(`${k} must be a number`);
    out[k] = r[k];
  }
  for (const k of ['text', 'tone', 'tooltip', 'link', 'resetsAt'] as const) {
    if (r[k] === undefined || r[k] === null) continue;
    if (typeof r[k] !== 'string') throw new RunError(`${k} must be a string`);
    assign(out, k, r[k]);
  }
  return out;
}

/** Tone from thresholds on value/max (or value when there is no max). */
export function thresholdTone(def: Pick<WidgetDef, 'thresholds'>, out: Pick<Output, 'value' | 'max'>): WidgetTone | undefined {
  const t = def.thresholds;
  if (!t || out.value === undefined) return undefined;
  const x = out.max ? out.value / out.max : out.value;
  if (t.error !== undefined && x >= t.error) return 'error';
  if (t.warn !== undefined && x >= t.warn) return 'warn';
  return 'ok';
}

async function readCapped(res: Response, max: number, signal: AbortSignal): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        throw new RunError(`response is larger than ${max / 1024} KiB`);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof RunError) throw err;
    throw new RunError(signal.aborted ? 'timed out reading the response' : `reading the response failed: ${errText(err)}`);
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

/** Run argv without a shell in its own process group; killed (with its children) on abort. */
function runProcess(exe: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal }): Promise<ProcessResult> {
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let finished = false;
    const detached = process.platform !== 'win32';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, args, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached });
    } catch (err) {
      done({ code: null, stdout, stderr, timedOut, error: (err as Error).message });
      return;
    }
    const kill = () => {
      try {
        if (detached && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
    const onAbort = () => {
      timedOut = true;
      kill();
    };
    if (o.signal.aborted) onAbort();
    else o.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout!.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
      if (stdout.length > MAX_COMMAND_OUTPUT) {
        stdout = stdout.slice(0, MAX_COMMAND_OUTPUT);
        kill();
      }
    });
    child.stderr!.setEncoding('utf8').on('data', (d: string) => {
      if (stderr.length < 8192) stderr += d;
    });
    const finish = (r: ProcessResult) => {
      if (finished) return;
      finished = true;
      o.signal.removeEventListener('abort', onAbort);
      done(r);
    };
    child.on('error', (err) => finish({ code: null, stdout, stderr, timedOut, error: err.message }));
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut }));
  });
}
