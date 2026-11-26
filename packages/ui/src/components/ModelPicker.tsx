// The model dropdown: the agent's own list (`agents.models`, loaded once per machine and agent),
// with "Agent default" first and "Other…" for an id the list doesn't have.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { modelsKey } from '@bizzi/client';
import type { AgentKind, ModelOption } from '@bizzi/protocol';
import { useBizzi, useStore } from '../app/context.tsx';
import { IconButton, Input, Select, Spinner, cx } from './ui.tsx';

const OTHER = '\u0000other';

/** The agent's models on a machine; loads them on first use. `undefined` while loading. */
export function useAgentModels(machineId: string | null | undefined, agent: AgentKind | '' | undefined): {
  models: readonly ModelOption[] | undefined;
  loading: boolean;
  refresh: () => void;
} {
  const store = useStore();
  const key = agent ? modelsKey(machineId, agent) : '';
  const models = useBizzi((s) => (key ? s.models[key] : undefined));
  const [loading, setLoading] = useState(false);
  const load = (refresh: boolean): void => {
    if (!agent) return;
    setLoading(true);
    void store.loadModels(machineId, agent, refresh).finally(() => setLoading(false));
  };
  useEffect(() => {
    if (key && models === undefined && !loading) load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { models, loading: loading || (!!key && models === undefined), refresh: () => load(true) };
}

/** The agent's own default row ("default" in Claude Code, `isDefault` elsewhere), for the first option's label. */
export function defaultModelHint(models: readonly ModelOption[] | undefined): string | undefined {
  const d = models?.find((m) => m.isDefault);
  if (!d) return undefined;
  if (d.id === 'default') return d.description;
  return d.label ?? d.id;
}

/** Models to list as choices: the agent's alias for "no model" is the first option already. */
function choices(models: readonly ModelOption[]): readonly ModelOption[] {
  return models.filter((m) => m.id !== 'default');
}

export function modelLabel(m: ModelOption): string {
  return m.label && m.label !== m.id ? `${m.label} (${m.id})` : m.id;
}

export function ModelPicker(props: {
  machineId: string | null | undefined;
  agent: AgentKind;
  value: string;
  onChange: (model: string) => void;
  /**
   * When set, the choice is applied here (mid-session): at once for a picked option, on blur or Enter
   * for typed text. `onChange` then only tracks the draft.
   */
  onCommit?: (model: string) => void;
  /** The capability's fixed list, used when the agent can't list its models. */
  fixed?: readonly string[];
  size?: 'sm' | 'md';
  /** Text of the "no model" option. */
  defaultLabel?: string;
  className?: string;
}): ReactNode {
  const { models: listed, loading, refresh } = useAgentModels(props.machineId, props.agent);
  const models: readonly ModelOption[] = listed && listed.length > 0 ? listed : (props.fixed ?? []).map((id) => ({ id }));
  const list = choices(models);
  const known = props.value === '' || list.some((m) => m.id === props.value);
  const [typing, setTyping] = useState(false);
  const free = typing || (!loading && list.length === 0);
  const sm = props.size === 'sm';
  const hint = defaultModelHint(listed);
  const defaultText = `${props.defaultLabel ?? 'Agent default'}${hint ? ` · ${hint}` : ''}`;

  const refreshButton = (
    <IconButton
      icon="refresh"
      label="Reload the model list"
      size={sm ? 13 : 15}
      className={sm ? 'h-7 w-7' : 'h-9 w-9'}
      disabled={loading}
      onClick={() => refresh()}
    />
  );

  if (free) {
    return (
      <div className={cx('flex items-center gap-1', props.className)}>
        <Input
          className={sm ? 'h-7 text-xs' : undefined}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          onBlur={(e) => props.onCommit?.(e.target.value.trim())}
          onKeyDown={(e) => {
            if (props.onCommit && e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder={loading ? 'Loading models…' : defaultText}
          spellCheck={false}
          autoCapitalize="off"
          list={list.length > 0 ? `models-${props.agent}` : undefined}
          autoFocus={typing}
        />
        {list.length > 0 ? (
          <>
            <datalist id={`models-${props.agent}`}>
              {list.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label ?? m.id}
                </option>
              ))}
            </datalist>
            <IconButton
              icon="x"
              label="Pick from the list"
              size={sm ? 13 : 15}
              className={sm ? 'h-7 w-7' : 'h-9 w-9'}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setTyping(false);
                if (!list.some((m) => m.id === props.value)) {
                  props.onChange('');
                  props.onCommit?.('');
                }
              }}
            />
          </>
        ) : loading ? (
          <Spinner size={sm ? 12 : 14} className="text-muted" />
        ) : (
          refreshButton
        )}
      </div>
    );
  }

  return (
    <div className={cx('flex items-center gap-1', props.className)}>
      <Select
        className={sm ? 'h-7 py-0 text-xs' : undefined}
        value={props.value}
        onChange={(e) => {
          if (e.target.value === OTHER) return setTyping(true);
          props.onChange(e.target.value);
          props.onCommit?.(e.target.value);
        }}
      >
        <option value="">{defaultText}</option>
        {!known ? <option value={props.value}>{props.value}</option> : null}
        {list.map((m) => (
          <option key={m.id} value={m.id} title={m.description}>
            {modelLabel(m)}
          </option>
        ))}
        <option value={OTHER}>Other…</option>
      </Select>
      {loading ? <Spinner size={sm ? 12 : 14} className="text-muted" /> : refreshButton}
    </div>
  );
}

/** Effort levels to offer for a model: the model's own when the agent says, else the agent's. */
export function effortsFor(models: readonly ModelOption[] | undefined, model: string, agentEfforts: readonly string[] | undefined): readonly string[] {
  const id = model || models?.find((m) => m.isDefault)?.id;
  const m = id ? models?.find((x) => x.id === id) : undefined;
  return m?.efforts?.length ? m.efforts : (agentEfforts ?? []);
}
