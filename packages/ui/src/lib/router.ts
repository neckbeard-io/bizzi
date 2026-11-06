// Hash routes, so the app works from file:// (Electron), Capacitor and any hub sub-path.

export type SessionTab = 'chat' | 'plan' | 'files' | 'changes';

export type Route =
  | { name: 'machine' }
  | { name: 'workspaces' }
  | { name: 'workspace'; workspaceId: string }
  | { name: 'session'; sessionId: string; tab: SessionTab }
  | { name: 'inbox' };

const TABS: readonly SessionTab[] = ['chat', 'plan', 'files', 'changes'];

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  switch (parts[0]) {
    case 'machine':
      return { name: 'machine' };
    case 'inbox':
      return { name: 'inbox' };
    case 'w':
      return parts[1] ? { name: 'workspace', workspaceId: parts[1] } : { name: 'workspaces' };
    case 's': {
      if (!parts[1]) return { name: 'workspaces' };
      const tab = TABS.includes(parts[2] as SessionTab) ? (parts[2] as SessionTab) : 'chat';
      return { name: 'session', sessionId: parts[1], tab };
    }
    case 'workspaces':
    default:
      return { name: 'workspaces' };
  }
}

export function routeHref(r: Route): string {
  switch (r.name) {
    case 'machine':
      return '#/machine';
    case 'inbox':
      return '#/inbox';
    case 'workspaces':
      return '#/workspaces';
    case 'workspace':
      return `#/w/${encodeURIComponent(r.workspaceId)}`;
    case 'session':
      return `#/s/${encodeURIComponent(r.sessionId)}${r.tab === 'chat' ? '' : `/${r.tab}`}`;
  }
}
