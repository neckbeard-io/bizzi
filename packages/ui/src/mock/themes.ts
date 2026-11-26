// Mock custom-theme storage (`themes.list` / `theme.save` / `theme.delete`) and user-wide prefs
// (`prefs.get` / `prefs.set` → `prefs.updated`), docs/theming.md §5. `?mock=1&demo=nothemes` answers
// `unsupported`, like a pre-1.2 server, so the UI falls back to localStorage.
import { BizziError, GLOBAL_CHANNEL } from '@bizzi/protocol';
import type { DensityPref, ThemeFile, UserPrefs } from '@bizzi/protocol';
import { mergePrefs } from '../lib/prefs.ts';
import { fiveToneTheme } from '../lib/theme/fiveTone.ts';
import type { MockHost, MockModule } from './host.ts';

const METHODS = new Set(['themes.list', 'theme.save', 'theme.delete', 'prefs.get', 'prefs.set']);
const DENSITIES: readonly DensityPref[] = ['theme', 'compact', 'comfortable', 'spacious'];

const SEED: ThemeFile[] = [
  {
    id: 'harbour',
    name: 'Harbour',
    updatedAt: new Date(Date.now() - 3 * 86400_000).toISOString(),
    data: fiveToneTheme(
      { id: 'harbour', name: 'Harbour', description: 'A custom five-tone theme stored on the hub.' },
      {
        light: { background: '#F3F6F8', foreground: '#18232B', primary: '#0B6E8A', secondary: '#7A4E9C', tertiary: '#9A6B12' },
        dark: { background: '#10181D', foreground: '#DCE6EB', primary: '#5CC8E6', secondary: '#C9A2E8', tertiary: '#E9C46A' },
      },
    ),
  },
];

export class MockThemes implements MockModule {
  private readonly host: MockHost;
  private readonly files = new Map<string, ThemeFile>(SEED.map((f) => [f.id, structuredClone(f)]));
  /** Starts empty, like a fresh hub: the first device to connect seeds it with its own choice. */
  private prefs: UserPrefs = {};

  constructor(host: MockHost) {
    this.host = host;
  }

  handles(method: string): boolean {
    return METHODS.has(method);
  }

  handle(method: string, params: Record<string, unknown>): unknown {
    if (this.host.demo.has('nothemes')) throw new BizziError('unsupported', `unknown method ${method}`);
    switch (method) {
      case 'themes.list':
        return { themes: [...this.files.values()].sort((a, b) => a.name.localeCompare(b.name)) };
      case 'theme.save': {
        const name = typeof params.name === 'string' ? params.name.trim() : '';
        if (!name) throw new BizziError('bad_request', 'name is required');
        const id = typeof params.id === 'string' && params.id ? params.id : `theme-${(this.files.size + 1).toString(36)}`;
        const file: ThemeFile = { id, name, data: params.data, updatedAt: new Date().toISOString() };
        this.files.set(id, file);
        return { theme: file };
      }
      case 'prefs.get':
        return { prefs: { ...this.prefs } };
      case 'prefs.set': {
        const raw = params.prefs;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BizziError('bad_request', 'prefs must be an object');
        const r = raw as Record<string, unknown>;
        const patch: Partial<UserPrefs> = {};
        if (r.themeId !== undefined) {
          if (typeof r.themeId !== 'string' || !r.themeId) throw new BizziError('bad_request', 'prefs.themeId must be a theme id');
          patch.themeId = r.themeId;
        }
        if (r.density !== undefined) {
          if (!DENSITIES.includes(r.density as DensityPref)) throw new BizziError('bad_request', 'prefs.density is not a density');
          patch.density = r.density as DensityPref;
        }
        this.prefs = mergePrefs(this.prefs, patch);
        // Agent profiles are replaced as a whole (the real server validates each one).
        if (Array.isArray(r.agentProfiles)) this.prefs.agentProfiles = structuredClone(r.agentProfiles) as UserPrefs['agentProfiles'];
        if (r.preferredProfiles && typeof r.preferredProfiles === 'object') this.prefs.preferredProfiles = { ...(r.preferredProfiles as UserPrefs['preferredProfiles']) };
        this.host.emit(GLOBAL_CHANNEL, { type: 'prefs.updated', data: { prefs: { ...this.prefs } } });
        return { prefs: { ...this.prefs } };
      }
      case 'theme.delete': {
        const id = String(params.id ?? '');
        if (!this.files.delete(id)) throw new BizziError('not_found', `no theme ${id}`);
        return {};
      }
      default:
        throw new BizziError('unsupported', `mock does not implement ${method}`);
    }
  }
}
