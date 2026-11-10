// Widget files (docs/usage.md §4): `<config>/widgets/*.json`, plain JSON with a schema so agents can
// write them. This module validates a parsed file into a WidgetDef and holds the JSON Schema and the
// AGENTS.md written into the directory.

import { AGENT_KINDS, type AgentKind, type BillingClass, type WidgetValue } from '@bizzi/protocol';
import { parsePath, templateRefs } from './expr.ts';

export type WidgetKind = WidgetValue['kind'];
export type WidgetPlacement = WidgetValue['placement'][number];
export type WidgetFormat = NonNullable<WidgetValue['format']>;
export type WidgetTone = NonNullable<WidgetValue['tone']>;

export const WIDGET_KINDS: readonly WidgetKind[] = ['meter', 'text', 'status'];
export const WIDGET_PLACEMENTS: readonly WidgetPlacement[] = ['bar', 'machine', 'workspace', 'session-header'];
export const WIDGET_FORMATS: readonly WidgetFormat[] = ['usd', 'percent', 'number', 'tokens'];
export const WIDGET_TONES: readonly WidgetTone[] = ['neutral', 'ok', 'warn', 'error'];
const BILLING: readonly BillingClass[] = ['metered', 'plan', 'budgetless'];

export const WIDGET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const DEFAULT_EVERY_MS = 60_000;
export const MIN_EVERY_MS = 1_000;
export const MAX_EVERY_MS = 24 * 3_600_000;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_TIMEOUT_MS = 120_000;
export const SCHEMA_FILE = 'widget.schema.json';
export const AGENTS_FILE = 'AGENTS.md';

/** JSONPath fields an http source can map. */
export const HTTP_PATH_FIELDS = ['value', 'max', 'text', 'tone', 'tooltip', 'link', 'resetsAt'] as const;
export type HttpPathField = (typeof HTTP_PATH_FIELDS)[number];

export interface HttpSource {
  type: 'http';
  url: string;
  headers: Record<string, string>;
  paths: Partial<Record<HttpPathField, string>>;
}

export interface CommandSource {
  type: 'command';
  /** argv; argv[0] is resolved against the widgets dir when it contains a slash. */
  command: string[];
  env: Record<string, string>;
  cwd?: string;
}

export interface WidgetBilling {
  account: string;
  agent: AgentKind;
  billing: BillingClass;
  label?: string;
  period?: string;
}

export interface WidgetDef {
  id: string;
  label: string;
  kind: WidgetKind;
  placement: WidgetPlacement[];
  everyMs: number;
  timeoutMs: number;
  source: HttpSource | CommandSource;
  format?: WidgetFormat;
  thresholds?: { warn?: number; error?: number };
  tooltip?: string;
  link?: string;
  billing?: WidgetBilling;
}

/** "500ms", "30s", "5m", "1h" → milliseconds. */
export function parseDuration(s: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/.exec(s.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2] === 'ms' ? 1 : m[2] === 's' ? 1000 : m[2] === 'm' ? 60_000 : 3_600_000;
  return Math.round(n * unit);
}

class Problems {
  readonly list: string[] = [];
  add(msg: string): void {
    this.list.push(msg);
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function strictKeys(o: Record<string, unknown>, allowed: readonly string[], where: string, p: Problems): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) p.add(`${where}: unknown field "${k}"`);
}

function optStr(o: Record<string, unknown>, k: string, where: string, p: Problems, max = 500): string | undefined {
  const v = o[k];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length === 0 || v.length > max) {
    p.add(`${where}.${k} must be a non-empty string (at most ${max} characters)`);
    return undefined;
  }
  return v;
}

function strMap(v: unknown, where: string, p: Problems): Record<string, string> {
  if (v === undefined) return {};
  if (!isObj(v)) {
    p.add(`${where} must be an object of strings`);
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) {
    if (typeof x !== 'string') p.add(`${where}.${k} must be a string`);
    else out[k] = x;
  }
  return out;
}

function checkTemplates(s: string, where: string, allowSecrets: boolean, p: Problems): void {
  for (const r of templateRefs(s)) {
    if (r.kind === 'env') {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(r.name)) p.add(`${where}: bad variable name in \${env:${r.name}}`);
    } else if (r.kind === 'secret') {
      if (!allowSecrets) p.add(`${where}: \${secret:…} is only allowed in http url/headers and command env`);
      else if (!/^([a-z]+:)?[A-Za-z_][A-Za-z0-9_]*$/.test(r.name)) p.add(`${where}: bad secret name in \${secret:${r.name}}`);
    } else {
      p.add(`${where}: unknown placeholder \${${r.kind}:…} (use env or secret)`);
    }
  }
}

function duration(o: Record<string, unknown>, k: string, dflt: number, min: number, max: number, p: Problems): number {
  const v = o[k];
  if (v === undefined) return dflt;
  const ms = typeof v === 'string' ? parseDuration(v) : undefined;
  if (ms === undefined || ms < min || ms > max) {
    p.add(`${k} must be a duration like "30s", "5m" or "1h" between ${min / 1000}s and ${max / 1000}s`);
    return dflt;
  }
  return ms;
}

/** The id a file would get without an explicit `id`: its base name. */
export function idFromFile(file: string): string {
  return file.replace(/\.json$/i, '');
}

/** Validate a parsed widget file. Returns the definition or the list of problems. */
export function parseWidget(raw: unknown, file: string): { def: WidgetDef } | { errors: string[] } {
  const p = new Problems();
  if (!isObj(raw)) return { errors: ['the file must contain a JSON object'] };
  strictKeys(
    raw,
    ['$schema', 'description', 'id', 'label', 'kind', 'placement', 'every', 'timeout', 'source', 'format', 'thresholds', 'tooltip', 'link', 'billing'],
    'widget',
    p,
  );
  const id = raw.id === undefined ? idFromFile(file) : raw.id;
  if (typeof id !== 'string' || !WIDGET_ID_RE.test(id)) p.add('id must be 1-64 letters, digits, . _ - (default: the file name)');
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 100) : undefined;
  if (!label) p.add('label is required (a short string)');
  const kind = raw.kind === undefined ? 'text' : raw.kind;
  if (!WIDGET_KINDS.includes(kind as WidgetKind)) p.add(`kind must be one of ${WIDGET_KINDS.join(', ')}`);
  let placement: WidgetPlacement[] = ['bar'];
  if (raw.placement !== undefined) {
    if (!Array.isArray(raw.placement) || raw.placement.length === 0 || raw.placement.some((x) => !WIDGET_PLACEMENTS.includes(x as WidgetPlacement))) {
      p.add(`placement must be a non-empty array of ${WIDGET_PLACEMENTS.join(', ')}`);
    } else {
      placement = [...new Set(raw.placement as WidgetPlacement[])];
    }
  }
  const everyMs = duration(raw, 'every', DEFAULT_EVERY_MS, MIN_EVERY_MS, MAX_EVERY_MS, p);
  const timeoutMs = duration(raw, 'timeout', DEFAULT_TIMEOUT_MS, 100, MAX_TIMEOUT_MS, p);

  let format: WidgetFormat | undefined;
  const fmt = raw.format ?? (isObj(raw.source) ? raw.source.format : undefined);
  if (fmt !== undefined) {
    if (WIDGET_FORMATS.includes(fmt as WidgetFormat)) format = fmt as WidgetFormat;
    else p.add(`format must be one of ${WIDGET_FORMATS.join(', ')}`);
  }

  let thresholds: WidgetDef['thresholds'];
  if (raw.thresholds !== undefined) {
    if (!isObj(raw.thresholds)) p.add('thresholds must be an object { warn?, error? }');
    else {
      strictKeys(raw.thresholds, ['warn', 'error'], 'thresholds', p);
      thresholds = {};
      for (const k of ['warn', 'error'] as const) {
        const v = raw.thresholds[k];
        if (v === undefined) continue;
        if (typeof v !== 'number' || !Number.isFinite(v)) p.add(`thresholds.${k} must be a number`);
        else thresholds[k] = v;
      }
    }
  }

  let source: WidgetDef['source'] | undefined;
  const src = raw.source;
  if (!isObj(src)) p.add('source is required: { "type": "http", … } or { "type": "command", … }');
  else if (src.type === 'http') {
    strictKeys(src, ['type', 'url', 'headers', 'format', ...HTTP_PATH_FIELDS], 'source', p);
    const url = optStr(src, 'url', 'source', p, 2000);
    if (!url) p.add('source.url is required');
    else {
      checkTemplates(url, 'source.url', true, p);
      if (!/^https?:\/\//i.test(url) && !url.startsWith('${')) p.add('source.url must be an http(s) URL');
    }
    const headers = strMap(src.headers, 'source.headers', p);
    for (const [k, v] of Object.entries(headers)) checkTemplates(v, `source.headers.${k}`, true, p);
    const paths: HttpSource['paths'] = {};
    for (const f of HTTP_PATH_FIELDS) {
      const v = optStr(src, f, 'source', p);
      if (v === undefined) continue;
      try {
        parsePath(v);
        paths[f] = v;
      } catch (err) {
        p.add(`source.${f}: ${(err as Error).message}`);
      }
    }
    if (url) source = { type: 'http', url, headers, paths };
  } else if (src.type === 'command') {
    strictKeys(src, ['type', 'command', 'env', 'cwd', 'format'], 'source', p);
    let command: string[] | undefined;
    if (typeof src.command === 'string' && src.command) command = [src.command];
    else if (Array.isArray(src.command) && src.command.length > 0 && src.command.every((x) => typeof x === 'string') && src.command[0]) {
      command = src.command as string[];
    } else p.add('source.command must be an executable path or an argv array (no shell)');
    for (const [i, a] of (command ?? []).entries()) checkTemplates(a, `source.command[${i}]`, false, p);
    const env = strMap(src.env, 'source.env', p);
    for (const [k, v] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) p.add(`source.env: bad variable name ${k}`);
      checkTemplates(v, `source.env.${k}`, true, p);
    }
    const cwd = optStr(src, 'cwd', 'source', p, 1000);
    if (command) source = { type: 'command', command, env, ...(cwd ? { cwd } : {}) };
  } else {
    p.add('source.type must be "http" or "command"');
  }

  const tooltip = optStr(raw, 'tooltip', 'widget', p);
  const link = optStr(raw, 'link', 'widget', p, 2000);
  if (link && !/^https?:\/\//i.test(link)) p.add('link must be an http(s) URL');

  let billing: WidgetBilling | undefined;
  if (raw.billing !== undefined) {
    if (!isObj(raw.billing)) p.add('billing must be an object { account, agent?, billing?, label?, period? }');
    else {
      const b = raw.billing;
      strictKeys(b, ['account', 'agent', 'billing', 'label', 'period'], 'billing', p);
      const account = optStr(b, 'account', 'billing', p, 256);
      if (!account) p.add('billing.account is required');
      // The agent defaults to the account's prefix ("claude-via-litellm" → claude), as in usage.md §4.1.
      const prefix = account ? AGENT_KINDS.find((a) => account === a || account.startsWith(`${a}-`) || account.startsWith(`${a}:`)) : undefined;
      const agent = (b.agent ?? prefix) as AgentKind | undefined;
      if (!agent || !AGENT_KINDS.includes(agent)) p.add(`billing.agent must be one of ${AGENT_KINDS.join(', ')} (or start billing.account with it)`);
      const cls = (b.billing ?? 'metered') as BillingClass;
      if (!BILLING.includes(cls)) p.add(`billing.billing must be one of ${BILLING.join(', ')}`);
      const bl = optStr(b, 'label', 'billing', p, 100);
      const period = optStr(b, 'period', 'billing', p, 64);
      if (account && agent && AGENT_KINDS.includes(agent)) {
        billing = { account, agent, billing: cls, ...(bl ? { label: bl } : {}), ...(period ? { period } : {}) };
      }
    }
  }

  if (p.list.length > 0 || !source || typeof id !== 'string' || !label) return { errors: p.list.length ? p.list : ['invalid widget'] };
  const def: WidgetDef = { id, label, kind: kind as WidgetKind, placement, everyMs, timeoutMs, source };
  if (format) def.format = format;
  if (thresholds) def.thresholds = thresholds;
  if (tooltip) def.tooltip = tooltip;
  if (link) def.link = link;
  if (billing) def.billing = billing;
  return { def };
}

const pathField = { type: 'string', pattern: '^\\$', description: "JSONPath subset: $, .key, ['key'], [n]" };
const durationField = { type: 'string', pattern: '^\\d+(\\.\\d+)?\\s*(ms|s|m|h)$' };

/** JSON Schema for widget files (written to `<widgets>/widget.schema.json`). */
export const WIDGET_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://bizzi.dev/schema/widget.json',
  title: 'bizzi widget',
  description: 'A node-run widget: data, not UI. See AGENTS.md in this directory.',
  type: 'object',
  additionalProperties: false,
  required: ['label', 'source'],
  properties: {
    $schema: { type: 'string' },
    description: { type: 'string' },
    id: { type: 'string', pattern: WIDGET_ID_RE.source, description: 'Default: the file name without .json' },
    label: { type: 'string', minLength: 1, maxLength: 100 },
    kind: { enum: WIDGET_KINDS, default: 'text' },
    placement: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: WIDGET_PLACEMENTS }, default: ['bar'] },
    every: { ...durationField, default: '60s', description: 'Refresh interval, 1s to 24h' },
    timeout: { ...durationField, default: '10s', description: 'Per-run timeout, at most 120s' },
    format: { enum: WIDGET_FORMATS },
    thresholds: {
      type: 'object',
      additionalProperties: false,
      description: 'Tone from value/max (or value when there is no max): >= error → error, >= warn → warn, else ok',
      properties: { warn: { type: 'number' }, error: { type: 'number' } },
    },
    tooltip: { type: 'string' },
    link: { type: 'string', pattern: '^https?://' },
    billing: {
      type: 'object',
      additionalProperties: false,
      required: ['account'],
      description: 'Also report value/max as spend for this login in usage.list',
      properties: {
        account: { type: 'string', minLength: 1 },
        agent: { enum: AGENT_KINDS, description: "Default: the account's prefix (claude-…)" },
        billing: { enum: BILLING, default: 'metered' },
        label: { type: 'string' },
        period: { type: 'string' },
      },
    },
    source: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'url'],
          properties: {
            type: { const: 'http' },
            url: { type: 'string', description: 'GET; may use ${env:NAME} and ${secret:NAME}' },
            headers: { type: 'object', additionalProperties: { type: 'string' } },
            format: { enum: WIDGET_FORMATS },
            ...Object.fromEntries(HTTP_PATH_FIELDS.map((f) => [f, pathField])),
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'command'],
          properties: {
            type: { const: 'command' },
            command: {
              oneOf: [{ type: 'string' }, { type: 'array', minItems: 1, items: { type: 'string' } }],
              description: 'Executable (relative paths resolve against this directory) and arguments; no shell',
            },
            env: { type: 'object', additionalProperties: { type: 'string' }, description: 'May use ${env:…} and ${secret:…}' },
            cwd: { type: 'string' },
            format: { enum: WIDGET_FORMATS },
          },
        },
      ],
    },
  },
} as const;

export const WIDGETS_AGENTS_MD = `# bizzi widgets

Each \`*.json\` file in this directory is one widget that this machine's bizzi node runs and shows in
the bizzi UI (desktop bottom bar, machine page, …). A widget is **data, not UI**: it produces a small
value (text, a number with a max, a status dot) that bizzi renders natively on every client.
Files are watched: saving a file reloads it within a second. \`${SCHEMA_FILE}\` is the JSON Schema;
point \`"$schema": "./${SCHEMA_FILE}"\` at it for editor help.

## Fields

| field | | |
|---|---|---|
| \`label\` | required | short label, e.g. \`"billed"\` |
| \`id\` | optional | default: file name without \`.json\` |
| \`kind\` | \`meter\` \\| \`text\` \\| \`status\` | meter = value / max, text = one line, status = dot + label (default text) |
| \`placement\` | array | any of \`bar\`, \`machine\`, \`workspace\`, \`session-header\` (default \`["bar"]\`) |
| \`every\` | duration | \`"30s"\`, \`"5m"\`, \`"1h"\` (default 60s, minimum 1s) |
| \`timeout\` | duration | per run (default 10s, max 120s) |
| \`format\` | \`usd\` \\| \`percent\` \\| \`number\` \\| \`tokens\` | how the value is shown |
| \`thresholds\` | \`{ "warn": 0.8, "error": 0.95 }\` | tone from value/max (or value without max) |
| \`tooltip\`, \`link\` | strings | link must be http(s) |
| \`billing\` | \`{ "account": "claude-via-litellm" }\` | also report value/max as this login's spend (usage panel) |
| \`source\` | required | see below |

## Sources

**http**: a GET, values picked with a JSONPath subset (\`$.a.b\`, \`$.items[0].n\`, \`$['odd-key']\`).

\`\`\`json
{
  "label": "billed",
  "kind": "meter",
  "every": "60s",
  "format": "usd",
  "source": {
    "type": "http",
    "url": "\${env:ANTHROPIC_BASE_URL}/key/info",
    "headers": { "Authorization": "Bearer \${secret:LITELLM_KEY}" },
    "value": "$.info.spend",
    "max": "$.info.max_budget",
    "resetsAt": "$.info.budget_reset_at"
  },
  "thresholds": { "warn": 0.8, "error": 0.95 },
  "billing": { "account": "claude-via-litellm" }
}
\`\`\`

Mappable paths: \`value\`, \`max\`, \`text\`, \`tone\`, \`tooltip\`, \`link\`, \`resetsAt\`. Without any path the
first line of the response body is the text.

**command**: an executable run on this machine on the interval. It prints one JSON object
\`{ "text"?, "value"?, "max"?, "tone"?, "tooltip"?, "link"?, "resetsAt"? }\` or one plain line (the text).
It runs without a shell: \`"command": ["./gpu-queue.sh", "--short"]\`. Relative paths resolve against
this directory. A non-zero exit is a failure.

\`\`\`json
{ "label": "h200", "kind": "meter", "every": "15s", "source": { "type": "command", "command": ["./h200.sh"] } }
\`\`\`

## Templating and secrets

- \`\${env:NAME}\`: the node's environment.
- \`\${secret:NAME}\` (or \`\${secret:agent:NAME}\`): a secret stored with bizzi (\`agent.setSecret\`). Allowed in
  http \`url\` and \`headers\` and in command \`env\`, never in command arguments (they show up in \`ps\`).
  Secrets stay on this machine; only the rendered value leaves it, and they are scrubbed from errors.

## Failures

A failed run keeps the previous value and sets \`error\`; the UI shows it with the value's age. An
invalid file shows up as an error widget on the machine page; fix the file and it reloads.
`;
