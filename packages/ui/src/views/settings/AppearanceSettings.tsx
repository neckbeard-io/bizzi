import { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useBizzi, useStore } from '../../app/context.tsx';
import { useAction } from '../../app/hooks.ts';
import { deleteCustomTheme, saveCustomTheme, themeIdTaken, themeStore, useCustomThemes, useThemeState } from '../../app/theme.ts';
import type { DensityPref } from '../../app/theme.ts';
import { Icon } from '../../components/icons.tsx';
import { SectionTitle } from '../../components/layout.tsx';
import { Badge, Button, Card, CopyButton, ErrorText, Field, Input, Modal, Segmented, cx } from '../../components/ui.tsx';
import { BUILTIN_CATALOGUE, DEVICE_THEME_ID, deviceTheme } from '../../lib/theme/builtins/index.ts';
import type { ThemeGroup } from '../../lib/theme/builtins/index.ts';
import { IMPORT_ACCEPT, customThemeId, downloadName, parseThemeFile, serializeTheme, themeFromCurrent } from '../../lib/theme/files.ts';
import type { ImportResult } from '../../lib/theme/files.ts';
import { resolveTheme } from '../../lib/theme/resolve.ts';
import { STATE_KEYS } from '../../lib/theme/types.ts';
import type { ModePref, Theme, ThemeMode } from '../../lib/theme/types.ts';

const GROUP_LABEL: Record<ThemeGroup, string> = {
  bizzi: 'bizzi',
  'hand-authored': 'Hand-authored',
  'five-tone': 'Five-tone (flax)',
  base16: 'base16',
  custom: 'Custom',
};

type Entry = { id: string; theme: Theme | null; name: string; group: ThemeGroup; failures?: string[] };

/** Appearance settings (docs/theming.md): theme, mode and density are per device; custom themes live on the hub. */
export function AppearanceSettings(): ReactNode {
  const store = useStore();
  const connected = useBizzi((s) => s.connection.state === 'open');
  useCustomThemes(store, connected);
  const s = useThemeState();
  const [importing, setImporting] = useState<{ result: ImportResult; fileName: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = BUILTIN_CATALOGUE.map(({ theme, group }) => ({ id: theme.id, theme: theme.id === DEVICE_THEME_ID ? deviceTheme(s.accent) : theme, name: theme.name, group }));
    for (const c of s.custom) out.push({ id: c.file.id, theme: c.theme, name: c.file.name, group: 'custom', failures: c.ok ? [] : c.failures });
    return out;
  }, [s.custom, s.accent]);

  const onFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    const result = parseThemeFile(await file.text(), file.name);
    // An id a built-in already uses gets a fresh one; a custom one with the same id is replaced.
    if (result.theme && BUILTIN_CATALOGUE.some((e) => e.theme.id === result.theme!.id)) result.theme.id = customThemeId(result.theme.name, themeIdTaken);
    if (result.theme) themeStore.preview(result.theme);
    setImporting({ result, fileName: file.name });
  };

  return (
    <>
      <SectionTitle>Appearance</SectionTitle>
      <Card className="grid gap-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex-1 text-sm">Mode</span>
          <Segmented<ModePref>
            value={s.mode}
            onChange={(m) => themeStore.setMode(m)}
            items={[
              { value: 'system', label: 'Auto' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex-1 text-sm">
            Density
            {s.phone && s.effectiveDensity !== (s.density === 'theme' ? (s.resolved.layout.density ?? 'comfortable') : s.density) ? (
              <span className="ml-2 text-xs text-muted">(at least comfortable on a phone)</span>
            ) : null}
          </span>
          <Segmented<DensityPref>
            value={s.density}
            onChange={(d) => themeStore.setDensity(d)}
            items={[
              { value: 'theme', label: 'Theme' },
              { value: 'compact', label: 'Compact' },
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'spacious', label: 'Spacious' },
            ]}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <span className="min-w-0 flex-1 text-sm">
            <span className="font-medium">{s.theme.name}</span>
            {s.theme.author ? <span className="text-muted"> · {s.theme.author}</span> : null}
            {s.resolved.variant !== s.requested ? <span className="text-muted"> · no {s.requested} variant, showing {s.resolved.variant}</span> : null}
          </span>
          <input
            ref={fileRef}
            type="file"
            accept={IMPORT_ACCEPT}
            className="hidden"
            onChange={(e) => {
              void onFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <Button size="sm" icon="upload" onClick={() => fileRef.current?.click()}>
            Import
          </Button>
          <Button size="sm" icon="plus" onClick={() => setCreating(true)}>
            Create from current
          </Button>
        </div>
        {s.preview && !importing ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-warn/40 px-2 py-1.5 text-xs">
            <span className="flex-1">Previewing {s.preview.name}; it fails validation, so it isn't applied.</span>
            <Button size="sm" variant="ghost" onClick={() => themeStore.preview(null)}>
              Stop preview
            </Button>
          </div>
        ) : null}
        {s.resolved.notes.length > 0 ? <p className="text-xs text-muted">{s.resolved.notes.join('; ')}.</p> : null}
        {s.customError ? <p className="text-xs text-err">Couldn't load custom themes: {s.customError}</p> : null}
      </Card>

      {(['bizzi', 'hand-authored', 'five-tone', 'custom', 'base16'] as const).map((g) => {
        const list = entries.filter((e) => e.group === g);
        if (list.length === 0) return null;
        return (
          <div key={g} className="mt-4">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium tracking-wide text-muted uppercase">
              {GROUP_LABEL[g]}
              {g === 'custom' ? <span className="tracking-normal normal-case">{s.customSource === 'local' ? '· on this device (the server has no theme storage)' : s.customSource === 'hub' ? '· synced through the hub' : ''}</span> : null}
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-2">
              {list.map((e) => (
                <ThemeCard key={e.id} entry={e} mode={s.requested} selected={!s.preview && s.themeId === e.id} onDelete={g === 'custom' ? () => deleteCustomTheme(store, e.id) : undefined} />
              ))}
            </div>
          </div>
        );
      })}

      {importing ? (
        <ImportModal
          result={importing.result}
          fileName={importing.fileName}
          onClose={() => {
            themeStore.preview(null);
            setImporting(null);
          }}
        />
      ) : null}
      {creating ? <CreateModal base={s.theme} onClose={() => setCreating(false)} /> : null}
    </>
  );
}

function ThemeCard(props: { entry: Entry; mode: ThemeMode; selected: boolean; onDelete?: (() => Promise<void>) | undefined }): ReactNode {
  const { entry: e } = props;
  const del = useAction(async () => props.onDelete?.());
  const r = useMemo(() => (e.theme ? resolveTheme(e.theme, props.mode) : null), [e.theme, props.mode]);
  const broken = (e.failures?.length ?? 0) > 0;
  const variants = e.theme ? (['light', 'dark'] as const).filter((m) => e.theme!.variants[m]) : [];
  return (
    <div className={cx('group relative rounded-lg border p-1.5 text-left', props.selected ? 'border-accent ring-1 ring-accent' : 'border-border hover:border-muted')}>
      <button
        type="button"
        className="block w-full text-left"
        disabled={!e.theme}
        title={broken ? `Needs fixing:\n${e.failures!.join('\n')}` : (e.theme?.description ?? e.name)}
        onClick={() => {
          if (!e.theme) return;
          if (broken) themeStore.preview(e.theme);
          else themeStore.setTheme(e.id);
        }}
      >
        {r ? (
          <div className="flex h-12 overflow-hidden rounded-md border border-border" style={{ background: r.colors.background }} aria-hidden>
            <div className="w-1/4" style={{ background: r.colors.sidebar, borderRight: `1px solid ${r.colors.sidebarBorder}` }}>
              <div className="mt-1.5 ml-1 flex flex-col gap-0.5">
                {STATE_KEYS.map((k) => (
                  <span key={k} className="block h-1.5 w-1.5 rounded-full" style={{ background: r.colors[k] }} />
                ))}
              </div>
            </div>
            <div className="flex flex-1 flex-col justify-between p-1.5">
              <div className="h-1.5 w-3/4 rounded-full" style={{ background: r.colors.foreground, opacity: 0.85 }} />
              <div className="h-1.5 w-1/2 rounded-full" style={{ background: r.colors.mutedForeground }} />
              <div className="flex items-center gap-1">
                <span className="h-3 w-6 rounded-sm" style={{ background: r.colors.primary }} />
                {r.terminal.ansi.slice(1, 7).map((c, i) => (
                  <span key={i} className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex h-12 items-center justify-center rounded-md border border-dashed border-border text-xs text-muted">unreadable</div>
        )}
        <div className="mt-1 flex items-center gap-1 px-0.5">
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{e.name}</span>
          {props.selected ? <Icon name="check" size={12} className="shrink-0 text-accent" /> : null}
        </div>
        <div className="flex items-center gap-1 px-0.5 text-[11px] text-muted">
          {broken ? <Badge tone="err">needs fixing</Badge> : variants.length === 1 ? `${variants[0]} only` : 'light · dark'}
        </div>
      </button>
      {props.onDelete ? (
        <button
          type="button"
          aria-label={`Delete ${e.name}`}
          title="Delete"
          className="absolute top-2.5 right-2.5 hidden h-6 w-6 items-center justify-center rounded bg-panel/90 text-muted group-hover:flex hover:text-err"
          onClick={() => {
            if (window.confirm(`Delete the theme "${e.name}"? Every device loses it.`)) void del.run();
          }}
        >
          <Icon name="trash" size={13} />
        </button>
      ) : null}
      <ErrorText error={del.error} className="mt-1 text-xs" />
    </div>
  );
}

function download(theme: Theme): void {
  const url = URL.createObjectURL(new Blob([serializeTheme(theme)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = downloadName(theme);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ImportModal(props: { result: ImportResult; fileName: string; onClose: () => void }): ReactNode {
  const store = useStore();
  const { result } = props;
  const theme = result.theme;
  const save = useAction(async () => {
    if (!theme || !result.ok) return;
    const id = await saveCustomTheme(store, theme);
    themeStore.setTheme(id);
    props.onClose();
  });
  const format = result.format === 'base16' || result.format === 'base24' ? `${result.format} scheme` : result.format === 'chorus' ? 'Chorus theme' : 'bizzi theme';
  return (
    <Modal
      title={result.ok ? `Import ${theme?.name ?? ''}` : 'Import failed'}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            {result.ok ? 'Cancel' : 'Close'}
          </Button>
          {theme ? (
            <Button variant="primary" icon="check" disabled={!result.ok} busy={save.busy} onClick={() => void save.run()}>
              Save and use
            </Button>
          ) : null}
        </>
      }
    >
      <div className="grid gap-2 text-sm">
        <div className="text-muted">
          <span className="font-mono text-xs">{props.fileName}</span>
          {result.format ? ` · read as a ${format}` : null}
          {theme?.author ? ` · by ${theme.author}` : null}
        </div>
        {theme ? (
          <p>{result.ok ? 'Previewing now. Save it to keep it (custom themes sync through the hub).' : 'Previewing now, but it fails validation, so it can’t be saved or applied until the file is fixed:'}</p>
        ) : null}
        {result.failures.length > 0 ? (
          <ul className="max-h-56 list-disc overflow-auto pl-5 text-xs text-err">
            {result.failures.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        ) : null}
        <ErrorText error={save.error} />
      </div>
    </Modal>
  );
}

function CreateModal(props: { base: Theme; onClose: () => void }): ReactNode {
  const store = useStore();
  const [name, setName] = useState(`${props.base.name} (custom)`);
  const theme = useMemo(() => themeFromCurrent(props.base, name.trim() || 'My theme', themeIdTaken), [props.base, name]);
  const save = useAction(async () => {
    const id = await saveCustomTheme(store, theme);
    themeStore.setTheme(id);
    props.onClose();
  });
  return (
    <Modal
      title="Create a theme"
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <CopyButton text={serializeTheme(theme)} label="Copy JSON" />
          <Button icon="download" onClick={() => download(theme)}>
            Download
          </Button>
          <Button variant="primary" icon="check" busy={save.busy} onClick={() => void save.run()}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3 text-sm">
        <p className="text-muted">
          Starts from {props.base.name}. Edit the JSON (or ask an agent: “make me a theme like Nord but warmer”, see packages/ui/themes/AGENTS.md), then import it. Five colours per variant are
          enough; everything else is derived and checked.
        </p>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <div className="font-mono text-xs text-muted">{downloadName(theme)}</div>
        <ErrorText error={save.error} />
      </div>
    </Modal>
  );
}
