// Hash routes, so the app works from file:// (Electron), Capacitor and any hub sub-path.

export type SessionTab = 'chat' | 'plan' | 'files' | 'changes';
/** Global (app-level) settings; `general` is Appearance. Machine-scoped settings live on the machine page. */
export type SettingsSection = 'general' | 'knowledge' | 'devices' | 'connection';

export type Route =
  /** Every machine: the machine → workspace tree (phone); on desktop the sidebar is the tree, so it redirects. */
  | { name: 'machines' }
  /** A machine's page (agents, workspaces, machine settings); without `machineId` the selected machine. */
  | { name: 'machine'; machineId?: string }
  /** Workspaces of the selected machine (phone); redirects to the machine page on desktop. */
  | { name: 'workspaces' }
  | { name: 'workspace'; workspaceId: string }
  | { name: 'session'; sessionId: string; tab: SessionTab }
  /** A fan-out group's compare view (spec §12). */
  | { name: 'fanout'; group: string }
  /** A pipeline run: its stages, gate and sessions (docs/pipelines.md). */
  | { name: 'pipeline'; pipelineId: string }
  /** An `agent.login` terminal session with the login helper. */
  | { name: 'login'; sessionId: string }
  | { name: 'inbox' }
  | { name: 'knowledge' }
  | { name: 'settings'; section: SettingsSection };

const TABS: readonly SessionTab[] = ['chat', 'plan', 'files', 'changes'];
const SECTIONS: readonly SettingsSection[] = ['general', 'knowledge', 'devices', 'connection'];

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  switch (parts[0]) {
    case 'machines':
      return { name: 'machines' };
    case 'machine':
      return parts[1] ? { name: 'machine', machineId: parts[1] } : { name: 'machine' };
    case 'm':
      return parts[1] ? { name: 'machine', machineId: parts[1] } : { name: 'machines' };
    case 'inbox':
      return { name: 'inbox' };
    case 'knowledge':
      return { name: 'knowledge' };
    case 'settings': {
      const section = SECTIONS.includes(parts[1] as SettingsSection) ? (parts[1] as SettingsSection) : 'general'; // incl. 'appearance'
      return { name: 'settings', section };
    }
    case 'login':
      return parts[1] ? { name: 'login', sessionId: parts[1] } : { name: 'machine' };
    case 'w':
      return parts[1] ? { name: 'workspace', workspaceId: parts[1] } : { name: 'workspaces' };
    case 'fanout':
      return parts[1] ? { name: 'fanout', group: parts[1] } : { name: 'workspaces' };
    case 'pipeline':
      return parts[1] ? { name: 'pipeline', pipelineId: parts[1] } : { name: 'workspaces' };
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
    case 'machines':
      return '#/machines';
    case 'machine':
      return r.machineId ? `#/machine/${encodeURIComponent(r.machineId)}` : '#/machine';
    case 'inbox':
      return '#/inbox';
    case 'knowledge':
      return '#/knowledge';
    case 'settings':
      return r.section === 'general' ? '#/settings' : `#/settings/${r.section}`;
    case 'login':
      return `#/login/${encodeURIComponent(r.sessionId)}`;
    case 'workspaces':
      return '#/workspaces';
    case 'workspace':
      return `#/w/${encodeURIComponent(r.workspaceId)}`;
    case 'fanout':
      return `#/fanout/${encodeURIComponent(r.group)}`;
    case 'pipeline':
      return `#/pipeline/${encodeURIComponent(r.pipelineId)}`;
    case 'session':
      return `#/s/${encodeURIComponent(r.sessionId)}${r.tab === 'chat' ? '' : `/${r.tab}`}`;
  }
}

/**
 * Desktop: the sidebar is the machine → workspace tree, so the list pages (`#/machines`, `#/workspaces`)
 * open the selected machine's page instead (or the first machine's). Returns null when no redirect applies.
 */
export function desktopRedirect(r: Route, wide: boolean, machineId: string | null): Route | null {
  if (!wide || !machineId) return null;
  if (r.name === 'machines' || r.name === 'workspaces') return { name: 'machine', machineId };
  return null;
}

/** A pairing link the app was opened with (`…/#/pair?code=…` or `?pair=…`), e.g. from a hub's QR code. */
export function pairCodeFromLocation(loc: { search: string; hash: string }): string | null {
  const q = new URLSearchParams(loc.search);
  const fromSearch = q.get('pair');
  if (fromSearch) return fromSearch;
  const h = loc.hash.replace(/^#\/?/, '');
  if (!h.startsWith('pair')) return null;
  const i = h.indexOf('?');
  if (i >= 0) {
    const code = new URLSearchParams(h.slice(i + 1)).get('code');
    if (code) return code;
  }
  const m = /^pair\/([^/?#]+)/.exec(h);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}
