// Prompt detectors as data (landscape.md §4.3): the shipped set lives in ../data/detectors.json,
// a node can override or extend it with <data dir>/detectors.json, and BIZZI_DETECTORS=off turns
// them all off (only OSC 7501 and the plain idle timer remain).
//
// File schema (schema 1):
//   { "schema": 1, "version": "…", "mode"?: "merge" | "replace",
//     "detectors": [ { "id", "prompt": "approval"|"input"|"question"|"login", "agents"?: AgentKind[],
//                      "patterns": [ { "phrases": [..] } | { "regex", "flags"?, "scope"?: "burst"|"last-line" } ],
//                      "note"?, "disabled"? } ] }
// A detector matches when any of its patterns does. Phrases are case-insensitive and tolerate
// missing/extra whitespace between words (TUIs draw words with cursor moves).

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AGENT_KINDS, type AgentKind } from '@bizzi/protocol';

export type PromptKind = 'input' | 'approval' | 'question' | 'login';
export const PROMPT_KINDS: readonly PromptKind[] = ['approval', 'login', 'question', 'input'];

export interface PromptDetector {
  id: string;
  kind: PromptKind;
  /** Agents this detector applies to; omitted = every agent. */
  agents?: AgentKind[];
  /** Tested against the ANSI-stripped output of the current burst (tail-capped). */
  test(text: string): boolean;
  /** Optional: the matched excerpt (for "explain"), or undefined when it doesn't match. */
  match?(text: string): string | undefined;
  /** Free-form provenance, e.g. "verified against claude 2.1.311" or "unverified". */
  note?: string;
  /** Where the detector came from, e.g. "builtin@2026.11.10" or an override file path. */
  origin?: string;
}

export const DETECTOR_SCHEMA = 1;
export const DETECTORS_FILE_NAME = 'detectors.json';
/** The detector set shipped with this package. */
export const SHIPPED_DETECTORS_PATH = new URL('../data/detectors.json', import.meta.url);

export type PatternSpec = { phrases: string[] } | { regex: string; flags?: string; scope?: 'burst' | 'last-line' };

export interface DetectorSpec {
  id: string;
  prompt: PromptKind;
  agents?: AgentKind[];
  patterns: PatternSpec[];
  note?: string;
  /** Override files only: remove the shipped detector with this id. */
  disabled?: boolean;
}

export interface DetectorFile {
  schema: number;
  version: string;
  mode?: 'merge' | 'replace';
  description?: string;
  detectors: DetectorSpec[];
}

/** Last non-empty line of `text`. */
export function lastLine(text: string): string {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.trimEnd();
    if (l.trim() !== '') return l;
  }
  return '';
}

/** Regex source for a phrase that tolerates missing/extra whitespace between words (cursor moves). */
export function phraseSource(words: string): string {
  return words
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s*');
}

const MAX_EXCERPT = 160;

function excerpt(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > MAX_EXCERPT ? `${one.slice(0, MAX_EXCERPT - 1)}…` : one;
}

/** A detector from a regular expression (the `g`/`y` flags are dropped: they make test() stateful). */
export function regexDetector(
  id: string,
  kind: PromptKind,
  re: RegExp,
  opts: { agents?: AgentKind[]; note?: string; scope?: 'burst' | 'last-line'; origin?: string } = {},
): PromptDetector {
  const safe = re.global || re.sticky ? new RegExp(re.source, re.flags.replace(/[gy]/g, '')) : re;
  const pick = opts.scope === 'last-line' ? lastLine : (t: string) => t;
  const match = (text: string) => {
    const m = safe.exec(pick(text));
    return m ? excerpt(m[0] || pick(text)) : undefined;
  };
  return {
    id,
    kind,
    agents: opts.agents,
    note: opts.note,
    origin: opts.origin,
    test: (text) => safe.test(pick(text)),
    match,
  };
}

// ---------------------------------------------------------------------------------------------
// Validation

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const FLAGS_RE = /^[imsuv]*$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validatePattern(p: unknown, where: string, errors: string[]): PatternSpec | undefined {
  if (!isObject(p)) {
    errors.push(`${where}: pattern must be an object`);
    return undefined;
  }
  if ('phrases' in p) {
    const phrases = p.phrases;
    if (!Array.isArray(phrases) || phrases.length === 0 || !phrases.every((s) => typeof s === 'string' && s.trim() !== '')) {
      errors.push(`${where}: phrases must be a non-empty array of non-empty strings`);
      return undefined;
    }
    return { phrases: phrases as string[] };
  }
  if ('regex' in p) {
    const { regex, flags, scope } = p;
    if (typeof regex !== 'string' || regex === '') {
      errors.push(`${where}: regex must be a non-empty string`);
      return undefined;
    }
    if (flags !== undefined && (typeof flags !== 'string' || !FLAGS_RE.test(flags))) {
      errors.push(`${where}: flags must use only i, m, s, u, v`);
      return undefined;
    }
    if (scope !== undefined && scope !== 'burst' && scope !== 'last-line') {
      errors.push(`${where}: scope must be "burst" or "last-line"`);
      return undefined;
    }
    try {
      new RegExp(regex, flags as string | undefined);
    } catch (e) {
      errors.push(`${where}: invalid regex: ${(e as Error).message}`);
      return undefined;
    }
    const out: PatternSpec = { regex };
    if (flags) out.flags = flags as string;
    if (scope) out.scope = scope as 'burst' | 'last-line';
    return out;
  }
  errors.push(`${where}: pattern needs "phrases" or "regex"`);
  return undefined;
}

function validateDetector(d: unknown, index: number, errors: string[]): DetectorSpec | undefined {
  const at = `detectors[${index}]`;
  if (!isObject(d)) {
    errors.push(`${at}: must be an object`);
    return undefined;
  }
  if (typeof d.id !== 'string' || !ID_RE.test(d.id)) {
    errors.push(`${at}: id must match ${ID_RE}`);
    return undefined;
  }
  const where = `detector ${d.id}`;
  if (d.disabled === true) return { id: d.id, prompt: 'input', patterns: [], disabled: true };
  if (typeof d.prompt !== 'string' || !PROMPT_KINDS.includes(d.prompt as PromptKind)) {
    errors.push(`${where}: prompt must be one of ${PROMPT_KINDS.join(', ')}`);
    return undefined;
  }
  let agents: AgentKind[] | undefined;
  if (d.agents !== undefined) {
    if (!Array.isArray(d.agents) || !d.agents.every((a) => AGENT_KINDS.includes(a as AgentKind))) {
      errors.push(`${where}: agents must be an array of ${AGENT_KINDS.join(', ')}`);
      return undefined;
    }
    agents = d.agents as AgentKind[];
  }
  if (!Array.isArray(d.patterns) || d.patterns.length === 0) {
    errors.push(`${where}: patterns must be a non-empty array`);
    return undefined;
  }
  const patterns: PatternSpec[] = [];
  for (const [i, p] of d.patterns.entries()) {
    const ok = validatePattern(p, `${where} patterns[${i}]`, errors);
    if (!ok) return undefined;
    patterns.push(ok);
  }
  if (d.note !== undefined && typeof d.note !== 'string') {
    errors.push(`${where}: note must be a string`);
    return undefined;
  }
  const spec: DetectorSpec = { id: d.id, prompt: d.prompt as PromptKind, patterns };
  if (agents) spec.agents = agents;
  if (d.note) spec.note = d.note as string;
  return spec;
}

export interface ValidationResult {
  /** Undefined when the file itself is unusable (wrong schema, not an object…). */
  file?: DetectorFile;
  /** Problems found; invalid detectors are left out of `file`. */
  errors: string[];
}

/** Validate parsed JSON against schema 1. Invalid detectors are dropped and reported. */
export function validateDetectorFile(data: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(data)) return { errors: ['file must be a JSON object'] };
  if (data.schema !== DETECTOR_SCHEMA) return { errors: [`unsupported schema ${JSON.stringify(data.schema)} (expected ${DETECTOR_SCHEMA})`] };
  if (typeof data.version !== 'string' || data.version === '') return { errors: ['version must be a non-empty string'] };
  if (data.mode !== undefined && data.mode !== 'merge' && data.mode !== 'replace') {
    return { errors: ['mode must be "merge" or "replace"'] };
  }
  if (!Array.isArray(data.detectors)) return { errors: ['detectors must be an array'] };
  const seen = new Set<string>();
  const detectors: DetectorSpec[] = [];
  for (const [i, d] of data.detectors.entries()) {
    const spec = validateDetector(d, i, errors);
    if (!spec) continue;
    if (seen.has(spec.id)) {
      errors.push(`detector ${spec.id}: duplicate id`);
      continue;
    }
    seen.add(spec.id);
    detectors.push(spec);
  }
  const file: DetectorFile = { schema: DETECTOR_SCHEMA, version: data.version, detectors };
  if (data.mode) file.mode = data.mode as 'merge' | 'replace';
  if (typeof data.description === 'string') file.description = data.description;
  return { file, errors };
}

// ---------------------------------------------------------------------------------------------
// Compilation

/** Turn a validated spec into a runnable detector. */
export function compileDetector(spec: DetectorSpec, origin?: string): PromptDetector {
  const tests = spec.patterns.map((p) => {
    if ('phrases' in p) {
      const re = new RegExp(p.phrases.map(phraseSource).join('|'), 'i');
      return regexDetector(spec.id, spec.prompt, re);
    }
    return regexDetector(spec.id, spec.prompt, new RegExp(p.regex, p.flags), { scope: p.scope });
  });
  const match = (text: string) => {
    for (const t of tests) {
      const m = t.match!(text);
      if (m !== undefined) return m;
    }
    return undefined;
  };
  return {
    id: spec.id,
    kind: spec.prompt,
    agents: spec.agents,
    note: spec.note,
    origin,
    test: (text) => tests.some((t) => t.test(text)),
    match,
  };
}

function readJson(path: string | URL): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

let shipped: { file: DetectorFile; detectors: PromptDetector[] } | undefined;

/** The shipped set (validated once; a broken shipped file is a bug and throws). */
export function shippedDetectors(): { file: DetectorFile; detectors: PromptDetector[] } {
  if (!shipped) {
    const { file, errors } = validateDetectorFile(readJson(SHIPPED_DETECTORS_PATH));
    if (!file || errors.length > 0) throw new Error(`invalid shipped detectors.json: ${errors.join('; ')}`);
    const origin = `builtin@${file.version}`;
    shipped = { file, detectors: file.detectors.map((d) => compileDetector(d, origin)) };
  }
  return shipped;
}

// ---------------------------------------------------------------------------------------------
// Loading

export interface DetectorLoadOptions {
  /** false = no detectors at all. Default: true unless env BIZZI_DETECTORS is "off"/"0"/"false". */
  enabled?: boolean;
  /** Override file. Default: env BIZZI_DETECTORS_FILE, else <dataDir>/detectors.json. */
  file?: string;
  /** Node data dir. Default: env BIZZI_DATA_DIR, else ~/.bizzi (the CLI's default). */
  dataDir?: string;
  /** Environment to read (tests). Default: process.env. */
  env?: Record<string, string | undefined>;
}

export interface DetectorSet {
  detectors: PromptDetector[];
  enabled: boolean;
  /** Shipped data version. */
  version: string;
  /** Override file applied, if any, with its version and mode. */
  override?: { path: string; version: string; mode: 'merge' | 'replace' };
  /** Problems with the override file (it is ignored entirely when it can't be read or parsed). */
  warnings: string[];
}

export function detectorsDisabledByEnv(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.BIZZI_DETECTORS?.trim().toLowerCase();
  return v === 'off' || v === '0' || v === 'false' || v === 'none';
}

/** Default override path: BIZZI_DETECTORS_FILE, else <dataDir | BIZZI_DATA_DIR | ~/.bizzi>/detectors.json. */
export function overridePath(opts: DetectorLoadOptions = {}): string {
  const env = opts.env ?? process.env;
  if (opts.file) return opts.file;
  if (env.BIZZI_DETECTORS_FILE) return env.BIZZI_DETECTORS_FILE;
  const dir = opts.dataDir ?? (env.BIZZI_DATA_DIR || join(homedir(), '.bizzi'));
  return join(dir, DETECTORS_FILE_NAME);
}

/** Merge an override file over a base list: same id replaces in place, new ids append, disabled removes. */
export function mergeDetectors(base: readonly PromptDetector[], override: DetectorFile, origin: string): PromptDetector[] {
  const out = override.mode === 'replace' ? [] : [...base];
  for (const spec of override.detectors) {
    const i = out.findIndex((d) => d.id === spec.id);
    if (spec.disabled) {
      if (i >= 0) out.splice(i, 1);
      continue;
    }
    const compiled = compileDetector(spec, origin);
    if (i >= 0) out[i] = compiled;
    else out.push(compiled);
  }
  return out;
}

/** Resolve the detectors a node should run: shipped set, node override, off switch. Never throws for override problems. */
export function loadDetectorSet(opts: DetectorLoadOptions = {}): DetectorSet {
  const env = opts.env ?? process.env;
  const base = shippedDetectors();
  const enabled = opts.enabled ?? !detectorsDisabledByEnv(env);
  if (!enabled) return { detectors: [], enabled: false, version: base.file.version, warnings: [] };
  const path = overridePath({ ...opts, env });
  const warnings: string[] = [];
  if (!existsSync(path)) {
    if (opts.file || env.BIZZI_DETECTORS_FILE) warnings.push(`${path}: not found; using the shipped detectors`);
    return { detectors: [...base.detectors], enabled: true, version: base.file.version, warnings };
  }
  let data: unknown;
  try {
    data = readJson(path);
  } catch (e) {
    warnings.push(`${path}: ${(e as Error).message}; using the shipped detectors`);
    return { detectors: [...base.detectors], enabled: true, version: base.file.version, warnings };
  }
  const { file, errors } = validateDetectorFile(data);
  for (const e of errors) warnings.push(`${path}: ${e}`);
  if (!file) {
    warnings.push(`${path}: ignored; using the shipped detectors`);
    return { detectors: [...base.detectors], enabled: true, version: base.file.version, warnings };
  }
  const mode = file.mode ?? 'merge';
  return {
    detectors: mergeDetectors(base.detectors, file, path),
    enabled: true,
    version: base.file.version,
    override: { path, version: file.version, mode },
    warnings,
  };
}

/** Detectors that apply to `agent`, blocking kinds first (approval, login, question, then input). */
export function detectorsFor(agent: AgentKind, detectors: readonly PromptDetector[] = shippedDetectors().detectors): PromptDetector[] {
  const applicable = detectors.filter((d) => !d.agents || d.agents.includes(agent));
  return PROMPT_KINDS.flatMap((k) => applicable.filter((d) => d.kind === k));
}
