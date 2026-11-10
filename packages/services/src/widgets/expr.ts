// The two small expression languages in widget files: a JSONPath subset for picking values out of an
// HTTP response, and `${env:NAME}` / `${secret:NAME}` templating for URLs, headers and command env.

/** One step of a parsed path: an object key or an array index. */
export type PathStep = string | number;

/**
 * Parse the supported JSONPath subset: `$`, `.key`, `['key']` / `["key"]` and `[n]`, e.g.
 * `$.data[0].value`, `$['max-budget']`. Throws with a short reason on anything else.
 */
export function parsePath(path: string): PathStep[] {
  if (!path.startsWith('$')) throw new Error(`path must start with $: ${path}`);
  const steps: PathStep[] = [];
  let i = 1;
  while (i < path.length) {
    const c = path[i];
    if (c === '.') {
      const m = /^[A-Za-z_$][\w$-]*/.exec(path.slice(i + 1));
      if (!m) throw new Error(`expected a key after '.' at ${i} in ${path}`);
      steps.push(m[0]);
      i += 1 + m[0].length;
    } else if (c === '[') {
      const rest = path.slice(i);
      const idx = /^\[(\d+)\]/.exec(rest);
      const quoted = /^\[(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\]/.exec(rest);
      if (idx) {
        steps.push(Number(idx[1]));
        i += idx[0].length;
      } else if (quoted) {
        steps.push((quoted[1] ?? quoted[2] ?? '').replace(/\\(.)/g, '$1'));
        i += quoted[0].length;
      } else {
        throw new Error(`unsupported selector at ${i} in ${path} (use [n], ['key'] or .key)`);
      }
    } else {
      throw new Error(`unexpected '${c}' at ${i} in ${path}`);
    }
  }
  return steps;
}

/** Evaluate a parsed path; undefined when any step is missing. */
export function evalPath(doc: unknown, steps: readonly PathStep[]): unknown {
  let cur: unknown = doc;
  for (const s of steps) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (typeof s === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[s];
    } else {
      if (Array.isArray(cur) || !Object.hasOwn(cur, s)) return undefined;
      cur = (cur as Record<string, unknown>)[s];
    }
  }
  return cur;
}

export function jsonPath(doc: unknown, path: string): unknown {
  return evalPath(doc, parsePath(path));
}

const TEMPLATE_RE = /\$\{([A-Za-z]+):([^}]*)\}/g;

export interface TemplateContext {
  env: NodeJS.ProcessEnv;
  /** Resolve `${secret:NAME}` (the node's secret store). Undefined when there is no such secret. */
  secret?: (name: string) => Promise<string | undefined>;
  /** Where secrets may appear; elsewhere `${secret:…}` is an error (e.g. command argv, visible in `ps`). */
  allowSecrets: boolean;
}

/** Placeholders used in a string, for validation without resolving anything. */
export function templateRefs(s: string): { kind: string; name: string }[] {
  return [...s.matchAll(TEMPLATE_RE)].map((m) => ({ kind: m[1]!, name: m[2]! }));
}

/**
 * Expand placeholders. Resolved secret values are appended to `secrets` so callers can scrub them out
 * of error messages. Throws on an unknown placeholder kind, an unset variable or a missing secret;
 * messages name the placeholder, never a value.
 */
export async function expand(s: string, ctx: TemplateContext, secrets: string[]): Promise<string> {
  const refs = templateRefs(s);
  if (refs.length === 0) return s;
  const values = new Map<string, string>();
  for (const { kind, name } of refs) {
    const key = `${kind}:${name}`;
    if (values.has(key)) continue;
    if (kind === 'env') {
      const v = ctx.env[name];
      if (v === undefined) throw new Error(`environment variable ${name} is not set`);
      values.set(key, v);
    } else if (kind === 'secret') {
      if (!ctx.allowSecrets) throw new Error(`\${secret:${name}} is not allowed here`);
      const v = ctx.secret ? await ctx.secret(name) : undefined;
      if (v === undefined) throw new Error(`secret ${name} not found`);
      values.set(key, v);
      secrets.push(v);
    } else {
      throw new Error(`unknown placeholder \${${kind}:…} (use env or secret)`);
    }
  }
  return s.replace(TEMPLATE_RE, (_m, kind: string, name: string) => values.get(`${kind}:${name}`) ?? '');
}

/** Replace every secret value in a message (error text, stderr) with `***`. */
export function scrub(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const v of secrets) {
    if (!v) continue;
    for (const form of new Set([v, encodeURIComponent(v)])) out = out.split(form).join('***');
  }
  return out;
}
