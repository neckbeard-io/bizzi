// A tiny structural validator for recipes (no runtime deps). `obj<T>()` requires a schema for every
// key of T, so the TS types in types.ts and the runtime schema can't drift apart silently.

import { ENGINE_VARS, templateVars } from './template.ts';
import { parseRange } from './versions.ts';
import type {
  AuthCommand,
  AuthRule,
  AuthSpec,
  DetectSpec,
  HeadlessLogin,
  InteractiveLogin,
  LatestSource,
  LoginSpec,
  MethodSpec,
  PlatformSpec,
  Recipe,
  RemedySpec,
  Requirement,
  StepSpec,
  SupportSpec,
  VersionDetect,
} from './types.ts';

const BAD: unique symbol = Symbol('bad');
type Bad = typeof BAD;
export type Schema<T> = (v: unknown, path: string, issues: string[]) => T | Bad;

function fail(issues: string[], path: string, msg: string): Bad {
  issues.push(`${path || '<root>'}: ${msg}`);
  return BAD;
}

function str(opts: { pattern?: RegExp; nonEmpty?: boolean } = {}): Schema<string> {
  return (v, p, i) => {
    if (typeof v !== 'string') return fail(i, p, `expected string, got ${describe(v)}`);
    if ((opts.nonEmpty ?? true) && v.length === 0) return fail(i, p, 'must not be empty');
    if (opts.pattern && !opts.pattern.test(v)) return fail(i, p, `"${v}" does not match ${opts.pattern}`);
    return v;
  };
}

function regexStr(): Schema<string> {
  return (v, p, i) => {
    const s = str()(v, p, i);
    if (s === BAD) return BAD;
    try {
      new RegExp(s);
    } catch (e) {
      return fail(i, p, `invalid regex: ${(e as Error).message}`);
    }
    return s;
  };
}

function urlStr(): Schema<string> {
  return str({ pattern: /^https:\/\/\S+$/ });
}

const bool: Schema<boolean> = (v, p, i) => (typeof v === 'boolean' ? v : fail(i, p, `expected boolean, got ${describe(v)}`));

function int(min = 0): Schema<number> {
  return (v, p, i) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min ? v : fail(i, p, `expected integer >= ${min}`);
}

function lit<L extends string | number>(...vals: L[]): Schema<L> {
  return (v, p, i) =>
    (vals as unknown[]).includes(v) ? (v as L) : fail(i, p, `expected one of ${vals.join(', ')}, got ${describe(v)}`);
}

function opt<T>(s: Schema<T>): Schema<T | undefined> {
  return (v, p, i) => (v === undefined || v === null ? undefined : s(v, p, i));
}

function dflt<T>(s: Schema<T>, d: T): Schema<T> {
  return (v, p, i) => (v === undefined || v === null ? d : s(v, p, i));
}

function arr<T>(s: Schema<T>, opts: { min?: number } = {}): Schema<T[]> {
  return (v, p, i) => {
    if (!Array.isArray(v)) return fail(i, p, `expected array, got ${describe(v)}`);
    if (opts.min !== undefined && v.length < opts.min) return fail(i, p, `expected at least ${opts.min} item(s)`);
    const out: T[] = [];
    let bad = false;
    v.forEach((item, idx) => {
      const r = s(item, `${p}[${idx}]`, i);
      if (r === BAD) bad = true;
      else out.push(r);
    });
    return bad ? BAD : out;
  };
}

function record<T>(s: Schema<T>, keyPattern?: RegExp): Schema<Record<string, T>> {
  return (v, p, i) => {
    if (!isPlainObject(v)) return fail(i, p, `expected mapping, got ${describe(v)}`);
    const out: Record<string, T> = {};
    let bad = false;
    for (const [k, val] of Object.entries(v)) {
      if (keyPattern && !keyPattern.test(k)) {
        fail(i, `${p}.${k}`, `key does not match ${keyPattern}`);
        bad = true;
        continue;
      }
      const r = s(val, `${p}.${k}`, i);
      if (r === BAD) bad = true;
      else out[k] = r;
    }
    return bad ? BAD : out;
  };
}

function obj<T>(shape: { [K in keyof T]-?: Schema<T[K]> }): Schema<T> {
  return (v, p, i) => {
    if (!isPlainObject(v)) return fail(i, p, `expected mapping, got ${describe(v)}`);
    const out: Record<string, unknown> = {};
    let bad = false;
    for (const key of Object.keys(v)) {
      if (!(key in shape)) {
        fail(i, p ? `${p}.${key}` : key, 'unknown key');
        bad = true;
      }
    }
    for (const [key, s] of Object.entries(shape) as [string, Schema<unknown>][]) {
      const r = s(v[key], p ? `${p}.${key}` : key, i);
      if (r === BAD) bad = true;
      else if (r !== undefined) out[key] = r;
    }
    return bad ? BAD : (out as T);
  };
}

/** Discriminated union on `key`. */
function tagged<T>(key: string, variants: Record<string, Schema<T>>): Schema<T> {
  return (v, p, i) => {
    if (!isPlainObject(v)) return fail(i, p, `expected mapping, got ${describe(v)}`);
    const tag = v[key];
    const s = typeof tag === 'string' ? variants[tag] : undefined;
    if (!s) return fail(i, `${p}.${key}`, `expected one of ${Object.keys(variants).join(', ')}`);
    return s(v, p, i);
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

// ---- recipe schema ----

const notes = opt(arr(str()));
const envMap = opt(record(str({ nonEmpty: false }), /^[A-Za-z_][A-Za-z0-9_]*$/));
const envName = str({ pattern: /^[A-Za-z_][A-Za-z0-9_]*$/ });
const platformFilter = str({ pattern: /^(darwin|linux)(-(arm64|x64)(-musl)?)?$/ });

const stepSchema = obj<StepSpec>({
  description: str(),
  run: opt(str()),
  argv: opt(arr(str(), { min: 1 })),
  requiresSudo: dflt(bool, false),
  env: envMap,
  cwd: opt(str()),
  timeoutMs: opt(int(1)),
  allowFailure: opt(bool),
  when: opt(lit('pinned', 'unpinned')),
});

const requirementSchema = obj<Requirement>({
  command: str({ pattern: /^[A-Za-z0-9._-]+$/ }),
  tool: opt(str({ pattern: /^[a-z0-9-]+$/ })),
});

const methodSchema = obj<MethodSpec>({
  id: str({ pattern: /^[a-z0-9-]+$/ }),
  kind: lit('script', 'brew', 'npm', 'binary'),
  label: str(),
  platforms: opt(arr(platformFilter, { min: 1 })),
  requires: opt(arr(requirementSchema)),
  targetDir: str(),
  binDir: opt(str()),
  pinnable: bool,
  selfUpdates: opt(bool),
  pathHints: opt(arr(str())),
  watch: opt(arr(str())),
  verified: bool,
  sources: opt(arr(urlStr())),
  notes,
  install: arr(stepSchema, { min: 1 }),
  update: opt(arr(stepSchema, { min: 1 })),
  uninstall: opt(arr(stepSchema, { min: 1 })),
});

const versionDetectSchema = obj<VersionDetect>({
  args: arr(str()),
  regex: regexStr(),
  timeoutMs: opt(int(1)),
});

const detectSchema = obj<DetectSpec>({
  binaries: arr(str({ pattern: /^[A-Za-z0-9._-]+$/ }), { min: 1 }),
  searchPaths: opt(arr(str())),
  version: versionDetectSchema,
});

const latestSchema: Schema<LatestSource> = tagged<LatestSource>('type', {
  npm: obj<Extract<LatestSource, { type: 'npm' }>>({
    type: lit('npm'),
    package: str({ pattern: /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/ }),
    distTag: opt(str()),
    registry: opt(urlStr()),
    verified: bool,
    notes,
  }),
  github: obj<Extract<LatestSource, { type: 'github' }>>({
    type: lit('github'),
    repo: str({ pattern: /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/ }),
    tagPrefix: opt(str()),
    verified: bool,
    notes,
  }),
  url: obj<Extract<LatestSource, { type: 'url' }>>({
    type: lit('url'),
    url: urlStr(),
    format: lit('text', 'json'),
    jsonPath: opt(str()),
    regex: opt(regexStr()),
    verified: bool,
    notes,
  }),
  'node-dist': obj<Extract<LatestSource, { type: 'node-dist' }>>({
    type: lit('node-dist'),
    lts: bool,
    url: opt(urlStr()),
    verified: bool,
    notes,
  }),
});

const headlessSchema = obj<HeadlessLogin>({
  kind: lit('api-key-env', 'token-env', 'token-command', 'device-code', 'stdin-secret', 'config', 'copy-credentials', 'command'),
  description: str(),
  env: opt(envName),
  argv: opt(arr(str(), { min: 1 })),
  stdinFromEnv: opt(envName),
  settingsFile: opt(str()),
  settings: opt(record(str())),
  files: opt(arr(str())),
  verified: bool,
  notes,
});

const interactiveSchema = obj<InteractiveLogin>({
  argv: arr(str(), { min: 1 }),
  description: str(),
  callbackPort: opt(int(1)),
  pastesCode: opt(bool),
  verified: bool,
  notes,
});

const loginSchema = obj<LoginSpec>({
  interactive: interactiveSchema,
  headless: arr(headlessSchema),
  logout: opt(
    obj<NonNullable<LoginSpec['logout']>>({
      argv: opt(arr(str(), { min: 1 })),
      description: str(),
      verified: bool,
    }),
  ),
});

const authCommandSchema = obj<AuthCommand>({
  argv: arr(str(), { min: 1 }),
  sideEffectFree: bool,
  timeoutMs: opt(int(1)),
  format: lit('json', 'text'),
  okExitCodes: opt(arr(int())),
  missingExitCodes: opt(arr(int())),
  loggedInField: opt(str()),
  accountField: opt(str()),
  methodField: opt(str()),
  nonEmptyMeansOk: opt(bool),
  okRegex: opt(regexStr()),
  missingRegex: opt(regexStr()),
  expiredRegex: opt(regexStr()),
  accountRegex: opt(regexStr()),
  verified: bool,
  notes,
});

const authRuleSchema = obj<AuthRule>({
  env: opt(arr(envName, { min: 1 })),
  file: opt(str()),
  jsonField: opt(str()),
  equals: opt(str()),
  account: opt(str()),
});

const authSchema = obj<AuthSpec>({
  command: opt(authCommandSchema),
  rules: opt(arr(authRuleSchema)),
  absent: lit('missing', 'unknown'),
  notes,
});

function rangeStr(): Schema<string> {
  return (v, p, i) => {
    const s = str()(v, p, i);
    if (s === BAD) return BAD;
    try {
      parseRange(s);
    } catch (e) {
      return fail(i, p, (e as Error).message);
    }
    return s;
  };
}

const remedySchema = obj<RemedySpec>({
  kind: lit('upgrade', 'migrate', 'restart-service'),
  title: str(),
  id: opt(str({ pattern: /^[a-z0-9-]+$/ })),
  method: opt(str({ pattern: /^[a-z0-9-]+$/ })),
  command: opt(str()),
  steps: opt(arr(stepSchema, { min: 1 })),
});

const supportSchema = obj<SupportSpec>({
  versions: rangeStr(),
  tested: opt(rangeStr()),
  unsupported: opt(
    obj<NonNullable<SupportSpec['unsupported']>>({
      reason: str(),
      remedies: opt(arr(remedySchema)),
    }),
  ),
  migrate: opt(
    obj<NonNullable<SupportSpec['migrate']>>({
      from: arr(str({ pattern: /^[a-z0-9-]+$/ }), { min: 1 }),
      title: str(),
      reason: opt(str()),
    }),
  ),
  notes,
});

const platformSpecSchema = obj<PlatformSpec>({
  vars: opt(record(str(), /^[a-zA-Z][a-zA-Z0-9]*$/)),
  notes,
});

export const recipeSchema: Schema<Recipe> = obj<Recipe>({
  schema: lit(1),
  name: str({ pattern: /^[a-z0-9-]+$/ }),
  kind: lit('agent', 'tool'),
  displayName: str(),
  homepage: urlStr(),
  docs: arr(urlStr(), { min: 1 }),
  verified: bool,
  notes,
  platforms: record(platformSpecSchema, /^(darwin|linux)-(arm64|x64)(-musl)?$/),
  defaultVersion: opt(str({ pattern: /^[0-9A-Za-z.+_-]+$/ })),
  detect: detectSchema,
  latest: arr(latestSchema, { min: 1 }),
  methods: arr(methodSchema, { min: 1 }),
  support: opt(supportSchema),
  login: opt(loginSchema),
  auth: opt(authSchema),
});

export interface ValidationResult {
  ok: boolean;
  recipe?: Recipe;
  issues: string[];
}

/** Structural + semantic validation. */
export function validateRecipe(data: unknown): ValidationResult {
  const issues: string[] = [];
  const parsed = recipeSchema(data, '', issues);
  if (parsed === BAD) return { ok: false, issues };
  semanticChecks(parsed, issues);
  return issues.length ? { ok: false, issues } : { ok: true, recipe: parsed, issues };
}

/** True when a platform filter (`linux`, `linux-x64`, …) covers the platform key (`linux-x64-musl`). */
export function filterMatches(filter: string, platformKey: string): boolean {
  return platformKey === filter || platformKey.startsWith(`${filter}-`);
}

function semanticChecks(r: Recipe, issues: string[]): void {
  const platformKeys = Object.keys(r.platforms);
  if (platformKeys.length === 0) issues.push('platforms: at least one platform is required');

  if (r.kind === 'agent' && !r.auth) issues.push('auth: required for agent recipes');
  if (r.kind === 'agent' && !r.login) issues.push('login: required for agent recipes');

  const ids = new Set<string>();
  r.methods.forEach((m, mi) => {
    const mp = `methods[${mi}]`;
    if (ids.has(m.id)) issues.push(`${mp}.id: duplicate method id "${m.id}"`);
    ids.add(m.id);

    const keys = platformKeys.filter((k) => !m.platforms || m.platforms.some((f) => filterMatches(f, k)));
    if (m.platforms && keys.length === 0) issues.push(`${mp}.platforms: matches none of the recipe platforms`);

    const strings: [string, string][] = [
      [`${mp}.targetDir`, m.targetDir],
      ...(m.binDir ? ([[`${mp}.binDir`, m.binDir]] as [string, string][]) : []),
      ...(m.watch ?? []).map((w, wi): [string, string] => [`${mp}.watch[${wi}]`, w]),
    ];
    for (const phase of ['install', 'update', 'uninstall'] as const) {
      (m[phase] ?? []).forEach((s, si) => {
        const sp = `${mp}.${phase}[${si}]`;
        if ((s.run === undefined) === (s.argv === undefined)) issues.push(`${sp}: exactly one of run/argv is required`);
        if (s.when === 'pinned' && !m.pinnable) issues.push(`${sp}.when: method is not pinnable`);
        if (s.run) strings.push([`${sp}.run`, s.run]);
        s.argv?.forEach((a, ai) => strings.push([`${sp}.argv[${ai}]`, a]));
        for (const [k, v] of Object.entries(s.env ?? {})) strings.push([`${sp}.env.${k}`, v]);
        if (s.cwd) strings.push([`${sp}.cwd`, s.cwd]);
      });
    }
    for (const key of keys) {
      const known = new Set([...ENGINE_VARS, ...Object.keys(r.platforms[key]?.vars ?? {})]);
      for (const [where, s] of strings) {
        for (const v of templateVars(s)) {
          if (!known.has(v)) issues.push(`${where}: unknown template variable "${v}" on ${key}`);
        }
      }
    }
    if (r.kind === 'agent' && !m.uninstall) issues.push(`${mp}.uninstall: required for agent recipes`);
  });

  r.latest.forEach((l, li) => {
    if (l.type !== 'url') return;
    for (const key of platformKeys) {
      const known = new Set([...ENGINE_VARS, ...Object.keys(r.platforms[key]?.vars ?? {})]);
      for (const v of templateVars(l.url)) {
        if (!known.has(v)) issues.push(`latest[${li}].url: unknown template variable "${v}" on ${key}`);
      }
    }
  });

  if (r.support) {
    if (r.kind !== 'agent') issues.push('support: only agent recipes declare supported versions');
    for (const id of r.support.migrate?.from ?? []) {
      if (!ids.has(id)) issues.push(`support.migrate.from: unknown method "${id}"`);
    }
    const remedyIds = new Set<string>();
    r.support.unsupported?.remedies?.forEach((rem, i) => {
      const rp = `support.unsupported.remedies[${i}]`;
      if (rem.method && !ids.has(rem.method)) issues.push(`${rp}.method: unknown method "${rem.method}"`);
      if (rem.id !== undefined) {
        if (remedyIds.has(rem.id)) issues.push(`${rp}.id: duplicate remedy id "${rem.id}"`);
        remedyIds.add(rem.id);
      }
      if (rem.steps) {
        if (rem.kind !== 'upgrade') issues.push(`${rp}.steps: only upgrade remedies run steps`);
        if (rem.id === undefined) issues.push(`${rp}: a remedy with steps needs an id`);
        rem.steps.forEach((s, si) => {
          if ((s.run === undefined) === (s.argv === undefined)) issues.push(`${rp}.steps[${si}]: exactly one of run/argv is required`);
        });
      }
    });
  }

  const cmd = r.auth?.command;
  if (cmd?.format === 'json' && !cmd.loggedInField && !cmd.nonEmptyMeansOk && !cmd.okExitCodes) {
    issues.push('auth.command: json format needs loggedInField, nonEmptyMeansOk or okExitCodes');
  }
  r.auth?.rules?.forEach((rule, i) => {
    if (!rule.env && !rule.file) issues.push(`auth.rules[${i}]: needs env or file`);
    if ((rule.jsonField === undefined) !== (rule.equals === undefined)) {
      issues.push(`auth.rules[${i}]: jsonField and equals go together`);
    }
  });
  r.login?.headless.forEach((h, i) => {
    const hp = `login.headless[${i}]`;
    if ((h.kind === 'api-key-env' || h.kind === 'token-env') && !h.env) issues.push(`${hp}: ${h.kind} needs env`);
    if ((h.kind === 'token-command' || h.kind === 'device-code' || h.kind === 'stdin-secret' || h.kind === 'command') && !h.argv) {
      issues.push(`${hp}: ${h.kind} needs argv`);
    }
    if (h.kind === 'stdin-secret' && !h.stdinFromEnv) issues.push(`${hp}: stdin-secret needs stdinFromEnv`);
    if (h.kind === 'config' && (!h.settingsFile || !h.settings)) issues.push(`${hp}: config needs settingsFile and settings`);
    if (h.kind === 'copy-credentials' && !h.files?.length) issues.push(`${hp}: copy-credentials needs files`);
  });
  if (r.kind === 'tool' && !r.defaultVersion && r.methods.some((m) => templateVars(m.targetDir).includes('version'))) {
    issues.push('defaultVersion: required when a method installs into a versioned directory');
  }
}
