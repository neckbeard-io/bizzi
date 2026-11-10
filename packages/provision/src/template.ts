// `{{name}}` / `{{name|default}}` templates used in recipe strings. A distinct syntax from shell
// `${VAR}` so recipe shell snippets can still use `$HOME` etc.

/** Variables the engine always provides (platform vars from the recipe are added on top). */
export const ENGINE_VARS = [
  'version',
  'home',
  'toolsDir',
  'toolDir',
  'name',
  'os',
  'arch',
  'libc',
  'platform',
  /** Homebrew's bin dir: /opt/homebrew/bin (Apple silicon), /usr/local/bin (Intel), linuxbrew on Linux. */
  'brewBin',
  /**
   * Facts about an adopted install, derived from the binary's real path (install.ts); only set when
   * planning an update/uninstall of an existing install, so steps give them a default:
   * the Homebrew formula (`opencode`, or `tap/name` for tapped ones), the cask, and the npm prefix.
   */
  'brewFormula',
  'brewCask',
  'npmPrefix',
] as const;

export function brewBinFor(os: string, arch: string): string {
  if (os === 'linux') return '/home/linuxbrew/.linuxbrew/bin';
  return arch === 'arm64' ? '/opt/homebrew/bin' : '/usr/local/bin';
}

export type TemplateVars = Record<string, string | undefined>;

const TEMPLATE_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*(?:\|([^}]*))?\}\}/g;

export function templateVars(s: string): string[] {
  return [...s.matchAll(TEMPLATE_RE)].map((m) => m[1] as string);
}

export class TemplateError extends Error {
  readonly variable: string;
  constructor(variable: string, input: string) {
    super(`template variable "${variable}" has no value in: ${input}`);
    this.name = 'TemplateError';
    this.variable = variable;
  }
}

/**
 * Render a template. With `shell: true`, substituted values that contain characters outside a safe
 * set are single-quoted, so values can never inject shell syntax. (Don't wrap templates in quotes
 * inside `run` strings; safe values are inserted raw, unsafe ones get quoted.)
 */
export function render(input: string, vars: TemplateVars, opts: { shell?: boolean } = {}): string {
  return input.replace(TEMPLATE_RE, (_m, name: string, def: string | undefined) => {
    const value = vars[name] ?? def;
    if (value === undefined) throw new TemplateError(name, input);
    return opts.shell ? shellQuote(value) : value;
  });
}

const SAFE_SHELL = /^[A-Za-z0-9_\-.,:/@%+=]+$/;

export function shellQuote(value: string): string {
  if (value !== '' && SAFE_SHELL.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Expand a leading `~` / `~/`. */
export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return `${home}${p.slice(1)}`;
  return p;
}

/** Render + expand `~` for path-like recipe fields. */
export function renderPath(input: string, vars: TemplateVars): string {
  return expandHome(render(input, vars), vars.home ?? '');
}
