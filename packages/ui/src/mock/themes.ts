// Mock custom-theme storage (`themes.list` / `theme.save` / `theme.delete`, docs/theming.md §5).
// `?mock=1&demo=nothemes` answers `unsupported`, like a pre-1.2 server, so the UI falls back to
// localStorage.
import { BizziError } from '@bizzi/protocol';
import type { ThemeFile } from '@bizzi/protocol';
import { fiveToneTheme } from '../lib/theme/fiveTone.ts';
import type { MockHost, MockModule } from './host.ts';

const METHODS = new Set(['themes.list', 'theme.save', 'theme.delete']);

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
