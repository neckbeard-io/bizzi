// Custom themes (theming.md §5): stored on the hub through `themes.list` / `theme.save` /
// `theme.delete`, so every device sees them. Servers without those methods answer `unsupported`;
// then they live in this device's localStorage instead.
import type { ThemeFile } from '@bizzi/protocol';
import type { Theme } from './types.ts';
import { schemeId } from './base16.ts';
import { THEME_ID_RE, validateTheme } from './validate.ts';

export type CustomTheme = { file: ThemeFile; theme: Theme | null; ok: boolean; failures: string[] };

/**
 * Validate stored theme files. The file's id and name win over the JSON's (the hub may assign ids in
 * its own format, so the id is checked as a slug and then restored).
 */
export function readThemeFiles(files: ThemeFile[]): CustomTheme[] {
  return files.map((file) => {
    const raw = typeof file.data === 'object' && file.data !== null ? (file.data as Record<string, unknown>) : null;
    const v = validateTheme(raw ? { ...raw, id: THEME_ID_RE.test(file.id) ? file.id : schemeId(file.id), name: file.name } : file.data);
    if (v.theme) v.theme.id = file.id;
    return { file, theme: v.theme, ok: v.ok, failures: v.failures };
  });
}

/** True for the error an older server returns for methods it doesn't have. */
export function isUnsupported(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'unsupported';
}

export function toThemeFile(theme: Theme, now = new Date()): ThemeFile {
  return { id: theme.id, name: theme.name, data: theme, updatedAt: now.toISOString() };
}

/** Insert or replace by id. */
export function upsertFile(list: ThemeFile[], file: ThemeFile): ThemeFile[] {
  return [...list.filter((f) => f.id !== file.id), file].sort((a, b) => a.name.localeCompare(b.name));
}
