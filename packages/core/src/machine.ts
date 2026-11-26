import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { BizziError, LABEL_COLORS, MAX_MACHINE_DESCRIPTION, MAX_WORKSPACE_NAME, isLabelColor, isLabelIcon, isMachineTag } from '@bizzi/protocol';
import type { LabelColor, MachineInfo } from '@bizzi/protocol';

export function detectOs(platform: string = process.platform): MachineInfo['os'] {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32' ? platform : 'other';
}

/**
 * Is a GUI session available to agents started by this process?
 * macOS: we run inside the logged-in Aqua session (not a background/SSH-only launchd domain).
 * Linux: an X11 or Wayland display is reachable.
 */
export function detectHeadful(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (platform === 'darwin') {
    try {
      const out = execFileSync('launchctl', ['managername'], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return out.trim() === 'Aqua';
    } catch {
      return false;
    }
  }
  if (platform === 'linux') return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  if (platform === 'win32') return true;
  return false;
}

export function buildMachineInfo(opts: { id: string; name?: string; version: string }): MachineInfo {
  const hostname = os.hostname();
  return {
    id: opts.id,
    name: opts.name?.trim() || hostname,
    hostname,
    os: detectOs(),
    arch: process.arch,
    headful: detectHeadful(),
    alwaysOn: false,
    tags: [],
    online: true,
    roles: ['node'],
    bizziVersion: opts.version,
  };
}

/** The user-owned part of MachineInfo, persisted by the node (machine.set). */
export interface MachineUserFields {
  tags: string[];
  description?: string;
  color?: LabelColor;
}

/** Validate `machine.set` tags: an array of machine tags (see isMachineTag), lowercased, deduped, at most 32. */
export function parseMachineTags(v: unknown): string[] {
  if (!Array.isArray(v)) throw new BizziError('bad_request', 'tags must be an array of strings');
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== 'string') throw new BizziError('bad_request', 'tags must be an array of strings');
    const tag = raw.trim().toLowerCase();
    if (!isMachineTag(tag)) {
      throw new BizziError('bad_request', `invalid tag ${JSON.stringify(raw)}: use letters, digits, '.', '_' or '-' (at most 64)`);
    }
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > 32) throw new BizziError('bad_request', 'at most 32 tags');
  return out;
}

/** Validate a `machine.set` description: trimmed; '' clears it. */
export function parseMachineDescription(v: unknown): string {
  if (typeof v !== 'string') throw new BizziError('bad_request', 'description must be a string');
  const text = v.trim();
  if (text.length > MAX_MACHINE_DESCRIPTION) {
    throw new BizziError('bad_request', `description is longer than ${MAX_MACHINE_DESCRIPTION} characters`);
  }
  return text;
}

/** Validate an identity colour (`machine.set`, `workspace.set`): a palette name; '' clears it (undefined). */
export function parseLabelColor(v: unknown): LabelColor | undefined {
  if (v === '') return undefined;
  if (!isLabelColor(v)) throw new BizziError('bad_request', `color must be one of ${LABEL_COLORS.join(', ')} (or '' to clear it)`);
  return v;
}

/** Validate a workspace icon: trimmed; '' clears it (undefined). */
export function parseLabelIcon(v: unknown): string | undefined {
  if (typeof v !== 'string') throw new BizziError('bad_request', 'icon must be a string');
  const icon = v.trim();
  if (!icon) return undefined;
  if (!isLabelIcon(icon)) throw new BizziError('bad_request', 'icon must be one or two characters or an emoji, without spaces');
  return icon;
}

/** Validate a `workspace.set` name: trimmed, not empty. */
export function parseWorkspaceName(v: unknown): string {
  if (typeof v !== 'string') throw new BizziError('bad_request', 'name must be a string');
  const name = v.trim();
  if (!name) throw new BizziError('bad_request', 'name must not be empty');
  if (name.length > MAX_WORKSPACE_NAME || /\p{Cc}/u.test(name)) throw new BizziError('bad_request', `name must be at most ${MAX_WORKSPACE_NAME} characters, without control characters`);
  return name;
}

/** Read persisted user fields (a JSON string from the node's meta table); bad data is ignored. */
export function readMachineUserFields(json: string | undefined): MachineUserFields {
  if (!json) return { tags: [] };
  try {
    const raw = JSON.parse(json) as { tags?: unknown; description?: unknown; color?: unknown };
    const tags = Array.isArray(raw.tags) ? raw.tags.filter(isMachineTag) : [];
    const description = typeof raw.description === 'string' && raw.description ? raw.description : undefined;
    return { tags, ...(description ? { description } : {}), ...(isLabelColor(raw.color) ? { color: raw.color } : {}) };
  } catch {
    return { tags: [] };
  }
}

/** Copy user fields onto a MachineInfo in place. */
export function applyMachineUserFields(machine: MachineInfo, fields: MachineUserFields): void {
  machine.tags = [...fields.tags];
  if (fields.description) machine.description = fields.description;
  else delete machine.description;
  if (fields.color) machine.color = fields.color;
  else delete machine.color;
}
