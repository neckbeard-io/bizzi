// The desktop app's self-updater, as exposed by its preload (`window.bizzi.updates`). The shapes
// mirror apps/desktop/src/shared/update.ts; keep the two in step. Browsers and the phone app have no
// bridge, so everything here is a no-op there.

import { useEffect, useState } from 'react';

export type UpdateChannel = 'stable' | 'dev';
export type UpdateStage = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'up-to-date' | 'error';

export interface UpdateState {
  stage: UpdateStage;
  currentVersion: string;
  channel: UpdateChannel;
  autoCheck: boolean;
  method: 'mac-app' | 'appimage' | 'deb' | 'nsis' | 'unsupported';
  methodLabel: string;
  hint?: string;
  latest?: { version: string; tag: string; title: string; notes: string; url: string; publishedAt: string; prerelease: boolean };
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

export interface UpdateBridge {
  get(): Promise<UpdateState | null>;
  act(a: UpdateAction): Promise<UpdateState | null>;
  subscribe(cb: (s: UpdateState) => void): () => void;
}

export function updateBridge(): UpdateBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.bizzi?.updates;
}

/** The updater's live state, or null outside the desktop app (or before the first answer). */
export function useUpdates(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    const bridge = updateBridge();
    if (!bridge) return;
    let live = true;
    const off = bridge.subscribe((s) => live && setState(s));
    void bridge.get().then((s) => live && s && setState(s));
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}

/** An update is on offer (or on its way in): the sidebar shows its pill. */
export function updateOffered(s: UpdateState | null): boolean {
  return s !== null && ['available', 'downloading', 'ready', 'installing'].includes(s.stage) && s.latest !== undefined;
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The short label on the sidebar pill. */
export function pillLabel(s: UpdateState): string {
  switch (s.stage) {
    case 'downloading':
      return s.progress && s.progress.total > 0 ? `${Math.floor((s.progress.received / s.progress.total) * 100)}%` : 'Downloading';
    case 'ready':
      return s.method === 'deb' ? 'Downloaded' : 'Restart to update';
    case 'installing':
      return 'Updating…';
    default:
      return s.latest ? `v${s.latest.version}` : 'Update';
  }
}
