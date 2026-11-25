// The part of a repo's devcontainer.json a container workspace uses (topology.md §7): the image (or a
// Dockerfile build), the container environment, the user, and the create-time commands. Everything else
// (features, compose files, port forwarding, run args, editor customizations) is reported as ignored.

import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { ContainerCommand, WorkspaceContainer } from '@bizzi/protocol';

export interface DevcontainerRecipe {
  /** The file it came from. */
  file: string;
  image?: string;
  build?: NonNullable<WorkspaceContainer['build']>;
  env?: Record<string, string>;
  user?: string;
  postCreate?: ContainerCommand[];
  notes: string[];
}

export const DEVCONTAINER_FILES = ['.devcontainer/devcontainer.json', '.devcontainer.json'];

/** Settings that only matter to an editor; skipped without a note. */
const SILENT = new Set(['name', 'customizations', 'extensions', 'settings', '$schema', 'shutdownAction', 'overrideCommand', 'workspaceFolder', 'workspaceMount']);
const HANDLED = new Set(['image', 'build', 'dockerFile', 'dockerfile', 'context', 'containerEnv', 'remoteEnv', 'remoteUser', 'containerUser', 'onCreateCommand', 'updateContentCommand', 'postCreateCommand']);

/** Find and read the repo's devcontainer.json; undefined when it has none. */
export async function readDevcontainer(workspacePath: string): Promise<DevcontainerRecipe | undefined> {
  for (const rel of DEVCONTAINER_FILES) {
    const file = join(workspacePath, rel);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    return parseDevcontainer(text, file, workspacePath);
  }
  return undefined;
}

/** devcontainer.json text → recipe. Throws on unparseable JSON with comments. */
export function parseDevcontainer(text: string, file: string, workspacePath: string): DevcontainerRecipe {
  let doc: unknown;
  try {
    doc = JSON.parse(stripJsonc(text));
  } catch (err) {
    throw new Error(`${file}: ${(err as Error).message}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${file}: not a JSON object`);
  const d = doc as Record<string, unknown>;
  const dir = dirname(file);
  const notes: string[] = [];
  const out: DevcontainerRecipe = { file, notes };
  const vars = (s: string, what: string): string | undefined => substitute(s, workspacePath, what, notes);

  if (typeof d.image === 'string' && d.image.trim()) {
    const v = vars(d.image.trim(), 'image');
    if (v) out.image = v;
  }
  const build = (d.build && typeof d.build === 'object' ? d.build : {}) as Record<string, unknown>;
  const dockerfile = str(build.dockerfile) ?? str(build.dockerFile) ?? str(d.dockerFile) ?? str(d.dockerfile);
  if (dockerfile && !out.image) {
    const context = str(build.context) ?? str(d.context) ?? '.';
    const df = vars(dockerfile, 'build.dockerfile');
    const ctx = vars(context, 'build.context');
    if (df && ctx) {
      out.build = { dockerfile: abs(dir, df), context: abs(dir, ctx) };
      const args = strRecord(build.args, 'build.args', vars, notes);
      if (args) out.build.args = args;
      if (build.target !== undefined) notes.push('build.target is ignored');
    }
  } else if (dockerfile) {
    notes.push('both image and a Dockerfile are set; the image is used');
  }
  if (d.dockerComposeFile !== undefined) notes.push('dockerComposeFile is not supported; bizzi runs a single container');

  const env = { ...strRecord(d.containerEnv, 'containerEnv', vars, notes), ...strRecord(d.remoteEnv, 'remoteEnv', vars, notes) };
  if (Object.keys(env).length > 0) out.env = env;
  const user = str(d.remoteUser) ?? str(d.containerUser);
  if (user) out.user = user;

  const cmds: ContainerCommand[] = [];
  for (const key of ['onCreateCommand', 'updateContentCommand', 'postCreateCommand']) {
    const v = d[key];
    if (v === undefined) continue;
    if (typeof v === 'string' && v.trim()) cmds.push(v);
    else if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')) cmds.push(v as string[]);
    else notes.push(`${key} in the object (parallel) form is not supported`);
  }
  if (cmds.length > 0) out.postCreate = cmds;

  if (d.features && typeof d.features === 'object' && Object.keys(d.features).length > 0) {
    notes.push(`features are not installed (${Object.keys(d.features).join(', ')}); bake them into the image`);
  }
  for (const key of Object.keys(d)) {
    if (HANDLED.has(key) || SILENT.has(key) || key === 'features' || key === 'dockerComposeFile') continue;
    notes.push(`${key} is ignored`);
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function abs(dir: string, p: string): string {
  return isAbsolute(p) ? p : resolve(dir, p);
}

function strRecord(
  v: unknown,
  what: string,
  vars: (s: string, what: string) => string | undefined,
  notes: string[],
): Record<string, string> | undefined {
  if (v === undefined) return undefined;
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    notes.push(`${what} is not an object; ignored`);
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(v)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean')) {
      notes.push(`${what}.${k} is ignored`);
      continue;
    }
    const s = vars(String(raw), `${what}.${k}`);
    if (s !== undefined) out[k] = s;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * devcontainer variables: the workspace folder is mounted at the same path, so local and container
 * folders are the same. Anything else (`${localEnv:…}`, `${devcontainerId}`) drops the value.
 */
function substitute(s: string, workspacePath: string, what: string, notes: string[]): string | undefined {
  let unknown = false;
  const out = s.replace(/\$\{([^}]+)\}/g, (_m, name: string) => {
    switch (name) {
      case 'localWorkspaceFolder':
      case 'containerWorkspaceFolder':
        return workspacePath;
      case 'localWorkspaceFolderBasename':
      case 'containerWorkspaceFolderBasename':
        return basename(workspacePath);
      default:
        unknown = true;
        return '';
    }
  });
  if (unknown) {
    notes.push(`${what} uses a variable bizzi doesn't substitute; ignored`);
    return undefined;
  }
  return out;
}

/** JSON with comments and trailing commas (devcontainer.json is JSONC) → JSON. */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      i = skipComment(text, i);
    } else if (c === ',' && /[}\]]/.test(text[nextSignificant(text, i + 1)] ?? '')) {
      i++; // a trailing comma
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function skipComment(text: string, i: number): number {
  if (text[i + 1] === '/') {
    while (i < text.length && text[i] !== '\n') i++;
    return i;
  }
  const end = text.indexOf('*/', i + 2);
  return end < 0 ? text.length : end + 2;
}

/** Index of the next character that isn't whitespace or inside a comment. */
function nextSignificant(text: string, i: number): number {
  while (i < text.length) {
    const c = text[i]!;
    if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) i = skipComment(text, i);
    else if (/\s/.test(c)) i++;
    else break;
  }
  return i;
}
