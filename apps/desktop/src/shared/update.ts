// The self-updater's state as the renderer sees it (main → preload → `window.bizzi.updates`), and
// the actions the renderer may ask for. packages/ui mirrors these shapes in src/lib/updates.ts; keep
// the two in step.

export const IPC_UPDATE_STATE = 'bizzi:update:state';
export const IPC_UPDATE_ACTION = 'bizzi:update:action';

export type UpdateChannel = 'stable' | 'dev';

/** How this copy of bizzi was installed, which decides how it replaces itself. */
export type InstallMethod = 'mac-app' | 'appimage' | 'deb' | 'nsis' | 'unsupported';

export type UpdateStage =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'up-to-date'
  | 'error';

export interface UpdateRelease {
  version: string;
  tag: string;
  title: string;
  /** Changelog for every release newer than the running one, newest first. */
  notes: string;
  url: string;
  publishedAt: string;
  prerelease: boolean;
}

export interface UpdateState {
  stage: UpdateStage;
  currentVersion: string;
  channel: UpdateChannel;
  autoCheck: boolean;
  method: InstallMethod;
  /** Shown next to the version: "macOS app", "AppImage", ... */
  methodLabel: string;
  /** Why this install can't update itself (method `unsupported`), or what to do by hand (deb). */
  hint?: string;
  latest?: UpdateRelease;
  /** The file for this platform in `latest`; absent when the release has none. */
  asset?: { name: string; size: number };
  progress?: { received: number; total: number };
  error?: string;
  lastCheckedAt?: string;
  skippedVersion?: string;
}

export type UpdateAction =
  | { type: 'check' }
  | { type: 'download' }
  | { type: 'install' }
  | { type: 'cancel' }
  | { type: 'skip' }
  | { type: 'channel'; channel: UpdateChannel }
  | { type: 'autoCheck'; enabled: boolean };

/** Validates an action from the renderer; anything else is dropped. */
export function parseUpdateAction(raw: unknown): UpdateAction | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const a = raw as Record<string, unknown>;
  switch (a['type']) {
    case 'check':
    case 'download':
    case 'install':
    case 'cancel':
    case 'skip':
      return { type: a['type'] };
    case 'channel':
      return a['channel'] === 'stable' || a['channel'] === 'dev' ? { type: 'channel', channel: a['channel'] } : null;
    case 'autoCheck':
      return typeof a['enabled'] === 'boolean' ? { type: 'autoCheck', enabled: a['enabled'] } : null;
    default:
      return null;
  }
}
