import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { KnowledgeScopeLevel, KnowledgeSettings as Settings } from '@bizzi/protocol';
import { useBizzi, useStore } from '../../app/context.tsx';
import { useAction } from '../../app/hooks.ts';
import { Icon } from '../../components/icons.tsx';
import { SectionTitle } from '../../components/layout.tsx';
import { Card, ErrorText, Select, Spinner, cx } from '../../components/ui.tsx';
import { AGENT_SCOPE_LEVELS, PRESETS, SCOPE_HELP } from '../../lib/knowledge.ts';

/** Acceptance preset (what goes live vs. into the inbox) and the default scope for agent writes. */
export function KnowledgeSettings(): ReactNode {
  const store = useStore();
  const settings = useBizzi((s) => s.knowledgeSettings);
  const open = useBizzi((s) => s.connection.state === 'open');
  const [loadError, setLoadError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const save = useAction(async (patch: Partial<Settings>) => {
    await store.setKnowledgeSettings(patch);
    setSaved(true);
  });

  useEffect(() => {
    if (settings || !open) return;
    setLoadError(null);
    store.loadKnowledgeSettings().catch((e: unknown) => setLoadError(e));
  }, [store, settings, open]);

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 1500);
    return () => clearTimeout(t);
  }, [saved]);

  if (!settings) {
    return loadError ? (
      <ErrorText error={loadError} />
    ) : (
      <div className="flex justify-center py-8 text-muted">
        <Spinner />
      </div>
    );
  }

  return (
    <>
      <SectionTitle
        actions={
          save.busy ? (
            <Spinner size={12} className="text-muted" />
          ) : saved ? (
            <span className="inline-flex items-center gap-1 text-xs text-ok">
              <Icon name="check" size={12} /> Saved
            </span>
          ) : null
        }
      >
        What agents may write
      </SectionTitle>
      <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Acceptance preset">
        {PRESETS.map((p) => {
          const active = settings.preset === p.value;
          return (
            <button
              key={p.value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={save.busy}
              onClick={() => !active && void save.run({ preset: p.value })}
              className={cx('rounded-lg border bg-panel p-3 text-left transition-colors', active ? 'border-accent ring-1 ring-accent' : 'border-border hover:bg-panel-2')}
            >
              <div className="flex items-center gap-2">
                <span className={cx('flex h-4 w-4 items-center justify-center rounded-full border', active ? 'border-accent bg-accent text-accent-fg' : 'border-border')}>
                  {active ? <Icon name="check" size={10} /> : null}
                </span>
                <span className="font-medium">{p.label}</span>
                {p.value === 'balanced' ? <span className="text-[11px] text-muted">default</span> : null}
              </div>
              <div className="mt-1 text-xs text-muted">{p.description}</div>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted">Whatever you write yourself is always live. Suggestions wait in the inbox; nothing about knowledge sends push notifications.</p>

      <SectionTitle>Default scope for agent writes</SectionTitle>
      <Card className="flex flex-wrap items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="text-sm">When an agent saves without naming a scope</div>
          <div className="text-xs text-muted">{SCOPE_HELP[settings.defaultAgentScope]}</div>
        </div>
        <Select
          className="w-auto"
          value={settings.defaultAgentScope}
          disabled={save.busy}
          onChange={(e) => void save.run({ defaultAgentScope: e.target.value as KnowledgeScopeLevel })}
          aria-label="Default agent scope"
        >
          {AGENT_SCOPE_LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
              {l === 'project' ? ' (recommended)' : ''}
            </option>
          ))}
          {!AGENT_SCOPE_LEVELS.includes(settings.defaultAgentScope) ? <option value={settings.defaultAgentScope}>{settings.defaultAgentScope}</option> : null}
        </Select>
      </Card>
      <ErrorText error={save.error} className="mt-2" />
    </>
  );
}
