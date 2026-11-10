// Theme files (theming.md §5): `.bizzi-theme` / `.chorus-theme` JSON (the §2 model) and base16/base24
// schemes as YAML or JSON. An import that fails validation comes back with its failures and, when its
// shape is usable, a theme to preview; it isn't applied or saved until fixed.
import { parseBase16Scheme, base16ToTheme, schemeId } from './base16.ts';
import type { Theme } from './types.ts';
import { THEME_ID_RE, validateTheme } from './validate.ts';
import type { ValidationResult } from './validate.ts';

export const THEME_FILE_EXT = '.bizzi-theme';
/** What the import picker accepts. */
export const IMPORT_ACCEPT = '.bizzi-theme,.chorus-theme,.json,.yaml,.yml';
/** Relative: resolves for files kept next to the schema (packages/ui/themes/, the hub's themes dir). */
export const THEME_SCHEMA_URL = 'bizzi-theme.schema.json';

export type ThemeFileFormat = 'bizzi' | 'chorus' | 'base16' | 'base24';
export type ImportResult = ValidationResult & { format: ThemeFileFormat | null };

function looksLikeTheme(v: unknown): boolean {
  return typeof v === 'object' && v !== null && 'variants' in v;
}

/** Read a theme from file text. Native JSON first, so a hand-authored theme is never read as a scheme. */
export function parseThemeFile(text: string, fileName = ''): ImportResult {
  const lower = fileName.toLowerCase();
  let json: unknown;
  let jsonError: string | null = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    jsonError = e instanceof Error ? e.message : 'invalid JSON';
  }
  if (json !== undefined && looksLikeTheme(json)) {
    return { ...validateTheme(json), format: lower.endsWith('.chorus-theme') ? 'chorus' : 'bizzi' };
  }
  const scheme = parseBase16Scheme(text);
  if (scheme) return { ...validateTheme(base16ToTheme(scheme)), format: scheme.system };
  const why =
    json !== undefined
      ? 'JSON without "variants" (not a theme) and without base00–base0F (not a base16 scheme)'
      : `not JSON (${jsonError}) and not a base16/base24 YAML scheme (needs name and base00–base0F)`;
  return { ok: false, theme: null, failures: [why], format: null };
}

/** Pretty JSON for download or the hub, with the schema reference first. */
export function serializeTheme(theme: Theme): string {
  return `${JSON.stringify({ $schema: THEME_SCHEMA_URL, ...theme }, null, 2)}\n`;
}

/** A fresh id for a custom theme that can't collide with `taken` (built-ins and other customs). */
export function customThemeId(name: string, taken: (id: string) => boolean): string {
  const base = schemeId(name);
  let id = THEME_ID_RE.test(base) ? base : 'custom-theme';
  if (!taken(id)) return id;
  for (let n = 2; ; n++) {
    const next = `${id.slice(0, 58)}-${n}`;
    if (!taken(next)) return next;
  }
}

/** "Create" (§5): a copy of the current theme under a new name and id, ready to edit and save. */
export function themeFromCurrent(current: Theme, name: string, taken: (id: string) => boolean): Theme {
  const copy = structuredClone(current);
  copy.id = customThemeId(name, taken);
  copy.name = name;
  // Keep provenance: the original's author and licence travel with a derived theme.
  copy.description = `Based on ${current.name}${current.author ? ` by ${current.author}` : ''}.`;
  delete copy.author;
  return copy;
}

export function downloadName(theme: Theme): string {
  return `${theme.id}${THEME_FILE_EXT}`;
}
