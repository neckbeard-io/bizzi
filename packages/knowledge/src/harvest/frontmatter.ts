// Minimal YAML-frontmatter reader for agent memory files: `key: value` pairs, one level of
// nesting by indentation, quoted or bare scalars. Anything fancier is kept as a raw string.

export type FrontmatterValue = string | { [key: string]: FrontmatterValue };
export type Frontmatter = { [key: string]: FrontmatterValue };

export interface ParsedMarkdown {
  data: Frontmatter;
  content: string;
}

function scalar(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    const inner = v.slice(1, -1);
    if (v.startsWith('"')) {
      try {
        return JSON.parse(v) as string;
      } catch {
        return inner;
      }
    }
    return inner.replaceAll("''", "'");
  }
  return v;
}

export function parseFrontmatter(text: string): ParsedMarkdown {
  const src = text.replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { data: {}, content: src };
  const data: Frontmatter = {};
  let parent: { [key: string]: FrontmatterValue } | undefined;
  let parentIndent = -1;
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const kv = /^(\s*)([^:\s][^:]*?)\s*:(?:\s+(.*))?$/.exec(line);
    if (!kv) continue;
    const indent = (kv[1] ?? '').length;
    const key = kv[2] ?? '';
    const value = kv[3];
    if (indent > parentIndent && parent && indent > 0) {
      parent[key] = value === undefined ? {} : scalar(value);
      continue;
    }
    if (value === undefined || value.trim() === '') {
      const obj: { [key: string]: FrontmatterValue } = {};
      data[key] = obj;
      parent = obj;
      parentIndent = indent;
    } else {
      data[key] = scalar(value);
      parent = undefined;
      parentIndent = -1;
    }
  }
  return { data, content: src.slice(m[0].length) };
}

export function fmString(data: Frontmatter, ...path: string[]): string | undefined {
  let cur: FrontmatterValue | undefined = data;
  for (const p of path) {
    if (cur === undefined || typeof cur === 'string') return undefined;
    cur = cur[p];
  }
  return typeof cur === 'string' && cur !== '' ? cur : undefined;
}
