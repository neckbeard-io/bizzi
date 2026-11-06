import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { AgentKind, SecretInfo } from '@bizzi/protocol';
import { useStore } from '../../app/context.tsx';
import { useAction } from '../../app/hooks.ts';
import { Icon } from '../../components/icons.tsx';
import { SectionTitle } from '../../components/layout.tsx';
import { Badge, Button, Card, ErrorText, Field, Input, Select, Spinner } from '../../components/ui.tsx';
import { formatRelative } from '../../lib/format.ts';
import { isValidSecretName, suggestedSecretNames } from '../../lib/provision.ts';

const AGENTS: AgentKind[] = ['claude', 'codex', 'opencode', 'agy'];

/**
 * API keys stored on the machine (its keychain / secret store) and injected into an agent's environment.
 * Values are write-only: the node never returns them.
 */
export function SecretsPanel(props: { machineId: string | null; online: boolean; preset: AgentKind | null; onPresetUsed: () => void }): ReactNode {
  const { machineId, online, preset, onPresetUsed } = props;
  const store = useStore();
  const [secrets, setSecrets] = useState<SecretInfo[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [adding, setAdding] = useState<AgentKind | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setSecrets(await store.listSecrets(machineId));
    } catch (e) {
      setLoadError(e);
    }
  }, [store, machineId]);

  useEffect(() => {
    setSecrets(null);
    if (online) void load();
  }, [load, online]);

  useEffect(() => {
    if (!preset) return;
    setAdding(preset);
    onPresetUsed();
    rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [preset, onPresetUsed]);

  const remove = useAction(async (s: SecretInfo) => {
    await store.deleteSecret({ machineId, agent: s.agent, name: s.name });
    await load();
  });

  return (
    <div ref={rootRef}>
      <SectionTitle
        actions={
          <Button size="sm" variant="ghost" icon="plus" disabled={!online || adding !== null} onClick={() => setAdding('claude')}>
            Add key
          </Button>
        }
      >
        API keys
      </SectionTitle>
      {adding ? (
        <AddSecretForm
          key={adding}
          initialAgent={adding}
          existing={secrets ?? []}
          onCancel={() => setAdding(null)}
          onSave={async (agent, name, value) => {
            await store.setSecret({ machineId, agent, name, value });
            setAdding(null);
            await load();
          }}
        />
      ) : null}
      <ErrorText error={loadError ?? remove.error} />
      <Card className="divide-y divide-border">
        {!online ? (
          <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted">
            <Icon name="wifiOff" size={15} /> API keys are stored on the machine and can be managed once it is back online.
          </div>
        ) : secrets === null ? (
          <div className="flex justify-center py-4 text-muted">{loadError ? null : <Spinner />}</div>
        ) : secrets.length === 0 ? (
          <div className="px-4 py-3 text-sm text-muted">No API keys. Agents use their own login unless a key is set here.</div>
        ) : (
          secrets.map((s) => (
            <div key={`${s.agent}:${s.name}`} className="flex items-center gap-3 px-4 py-2.5">
              <Icon name="key" size={15} className="shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[13px]">{s.name}</div>
                <div className="text-xs text-muted">set {formatRelative(s.setAt)}</div>
              </div>
              <Badge className="capitalize">{s.agent}</Badge>
              <span className="hidden font-mono text-xs tracking-widest text-muted sm:inline">••••••••</span>
              <Button
                size="sm"
                variant="ghost"
                icon="trash"
                busy={remove.busy}
                onClick={() => {
                  if (window.confirm(`Delete ${s.name} for ${s.agent}? The agent falls back to its own login.`)) void remove.run(s);
                }}
              >
                <span className="hidden sm:inline">Delete</span>
              </Button>
            </div>
          ))
        )}
      </Card>
      <p className="mt-2 text-xs text-muted">Keys stay in this machine's secret store; the hub never sees them.</p>
    </div>
  );
}

function AddSecretForm(props: {
  initialAgent: AgentKind;
  existing: readonly SecretInfo[];
  onCancel: () => void;
  onSave: (agent: AgentKind, name: string, value: string) => Promise<void>;
}): ReactNode {
  const listId = useId();
  const [agent, setAgent] = useState<AgentKind>(props.initialAgent);
  const taken = props.existing.filter((s) => s.agent === agent).map((s) => s.name);
  const suggestions = suggestedSecretNames(agent, taken);
  const [name, setName] = useState(suggestions[0] ?? '');
  const [value, setValue] = useState('');
  const save = useAction(() => props.onSave(agent, name.trim(), value));
  const nameOk = isValidSecretName(name.trim());
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (nameOk && value) void save.run();
  };
  return (
    <Card className="mb-3 p-4">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[140px_1fr]">
        <Field label="Agent">
          <Select
            value={agent}
            onChange={(e) => {
              const a = e.target.value as AgentKind;
              setAgent(a);
              setName(suggestedSecretNames(a, props.existing.filter((s) => s.agent === a).map((s) => s.name))[0] ?? '');
            }}
          >
            {AGENTS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Environment variable">
          <Input value={name} onChange={(e) => setName(e.target.value)} list={listId} className="font-mono" placeholder="ANTHROPIC_API_KEY" spellCheck={false} autoCapitalize="off" required />
          <datalist id={listId}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </Field>
        <Field label="Value" className="sm:col-span-2">
          <Input value={value} onChange={(e) => setValue(e.target.value)} type="password" autoComplete="new-password" placeholder="sk-…" spellCheck={false} required />
        </Field>
        {name && !nameOk ? <div className="text-xs text-err sm:col-span-2">Use letters, digits and underscores only.</div> : null}
        <div className="flex items-center justify-end gap-2 sm:col-span-2">
          <Button variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon="key" busy={save.busy} disabled={!nameOk || !value}>
            Save key
          </Button>
        </div>
        <div className="sm:col-span-2">
          <ErrorText error={save.error} />
        </div>
      </form>
    </Card>
  );
}
