import { execFileSync } from 'node:child_process';
import os from 'node:os';
import type { MachineInfo } from '@bizzi/protocol';

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
