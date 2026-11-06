import { useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { shallowEqual } from '@bizzi/client';
import type { AgentKind, KnowledgeItemInfo, KnowledgeScope, KnowledgeScopeLevel } from '@bizzi/protocol';
import { useBizzi, useStore } from '../../app/context.tsx';
import { useAction } from '../../app/hooks.ts';
import { useTargetMachineId } from '../../app/machine.ts';
import { Button, Checkbox, ErrorText, Field, Input, Modal, Segmented, Select, Textarea } from '../../components/ui.tsx';
import { KNOWLEDGE_AGENTS, MEMORY_KINDS, SCOPE_HELP, SCOPE_LEVELS, parseTags, projectOptions, scopeComplete } from '../../lib/knowledge.ts';
import type { ScopeContext } from '../../lib/knowledge.ts';

export type EditorTarget = { mode: 'new'; type: 'rule' | 'memory' } | { mode: 'edit'; item: KnowledgeItemInfo };

/** The store slices scope pickers and labels need. */
export function useScopeContext(): ScopeContext {
  return useBizzi((s) => ({ machines: s.machines, workspaces: s.workspaces, sessions: s.sessions }), shallowEqual);
}

/** Create or edit a rule / memory. `knowledge.update` cannot change type or kind, so those are fixed when editing. */
export function KnowledgeEditor(props: { target: EditorTarget; onClose: () => void }): ReactNode {
  const store = useStore();
  const ctx = useScopeContext();
  const machineId = useTargetMachineId();
  const editing = props.target.mode === 'edit' ? props.target.item : null;
  const [type, setType] = useState<'rule' | 'memory'>(editing?.type ?? (props.target.mode === 'new' ? props.target.type : 'rule'));
  const [title, setTitle] = useState(editing?.title ?? '');
  const [body, setBody] = useState(editing?.body ?? '');
  const [level, setLevel] = useState<KnowledgeScopeLevel>(editing?.scope.level ?? 'global');
  const [scopeMachine, setScopeMachine] = useState(editing?.scope.machineId ?? machineId ?? '');
  const firstWs = Object.values(ctx.workspaces ?? {}).find((w) => w.machineId === machineId)?.id ?? '';
  const [scopeWorkspace, setScopeWorkspace] = useState(editing?.scope.workspaceId ?? firstWs);
  const projects = useMemo(() => projectOptions(ctx, [editing?.scope.projectId]), [ctx, editing]);
  const [scopeProject, setScopeProject] = useState(editing?.scope.projectId ?? projects[0]?.projectId ?? '');
  const [appliesTo, setAppliesTo] = useState<AgentKind[]>(editing?.appliesTo ?? []);
  const [kind, setKind] = useState(editing?.kind ?? (type === 'memory' ? 'fact' : ''));
  const [tags, setTags] = useState((editing?.tags ?? []).join(', '));

  const workspaces = useMemo(() => Object.values(ctx.workspaces ?? {}).sort((a, b) => a.name.localeCompare(b.name)), [ctx.workspaces]);
  const machines = useMemo(() => Object.values(ctx.machines).sort((a, b) => a.name.localeCompare(b.name)), [ctx.machines]);
  const levels = editing && !SCOPE_LEVELS.includes(editing.scope.level) ? [...SCOPE_LEVELS, editing.scope.level] : SCOPE_LEVELS;

  const scope: KnowledgeScope =
    level === 'machine'
      ? { level, machineId: scopeMachine }
      : level === 'workspace'
        ? { level, workspaceId: scopeWorkspace }
        : level === 'project'
          ? { level, projectId: scopeProject.trim() }
          : editing && editing.scope.level === level
            ? editing.scope
            : { level };
  const valid = title.trim().length > 0 && scopeComplete(scope);

  const save = useAction(async () => {
    const common = { title: title.trim(), body, scope, appliesTo, tags: parseTags(tags) };
    if (editing) await store.updateKnowledge({ id: editing.id, ...common });
    else {
      const params: Parameters<typeof store.addKnowledge>[0] = { type, ...common };
      if (type === 'memory' && kind) params.kind = kind;
      await store.addKnowledge(params);
    }
    props.onClose();
  });

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (valid) void save.run();
  };

  const toggleAgent = (a: AgentKind, on: boolean): void => setAppliesTo((cur) => (on ? [...cur.filter((x) => x !== a), a] : cur.filter((x) => x !== a)));

  return (
    <Modal
      wide
      title={editing ? `Edit ${editing.type}` : `New ${type}`}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="knowledge-form" busy={save.busy} disabled={!valid}>
            {editing ? 'Save' : 'Add'}
          </Button>
        </>
      }
    >
      <form id="knowledge-form" onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <Segmented<'rule' | 'memory'>
            value={type}
            onChange={(t) => {
              setType(t);
              if (t === 'memory' && !kind) setKind('fact');
            }}
            items={[
              { value: 'rule', label: 'Rule' },
              { value: 'memory', label: 'Memory' },
            ]}
            className={editing ? 'pointer-events-none opacity-60' : undefined}
          />
          <span className="text-xs text-muted">{type === 'rule' ? 'Always injected in full into matching sessions.' : 'Retrieved by relevance: digest at start, search on demand.'}</span>
        </div>
        <Field label="Title" className="sm:col-span-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={type === 'rule' ? 'Always use pnpm' : 'The staging DB is on server-a:5433'} autoFocus required />
        </Field>
        <Field label="Details" className="sm:col-span-2">
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} placeholder="Markdown welcome" />
        </Field>
        <Field label="Scope" hint={SCOPE_HELP[level]}>
          <Select value={level} onChange={(e) => setLevel(e.target.value as KnowledgeScopeLevel)}>
            {levels.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        {level === 'machine' ? (
          <Field label="Machine">
            <Select value={scopeMachine} onChange={(e) => setScopeMachine(e.target.value)}>
              {!scopeMachine ? <option value="">Choose a machine</option> : null}
              {machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
              {scopeMachine && !ctx.machines[scopeMachine] ? <option value={scopeMachine}>{scopeMachine}</option> : null}
            </Select>
          </Field>
        ) : level === 'workspace' ? (
          <Field label="Workspace">
            <Select value={scopeWorkspace} onChange={(e) => setScopeWorkspace(e.target.value)}>
              {!scopeWorkspace ? <option value="">Choose a workspace</option> : null}
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} · {ctx.machines[w.machineId]?.name ?? w.machineId}
                </option>
              ))}
              {scopeWorkspace && !ctx.workspaces?.[scopeWorkspace] ? <option value={scopeWorkspace}>{scopeWorkspace}</option> : null}
            </Select>
          </Field>
        ) : level === 'project' ? (
          <Field label="Project" hint={projects.length ? undefined : 'No workspace is linked to a project yet; enter a project id.'}>
            {projects.length ? (
              <Select value={scopeProject} onChange={(e) => setScopeProject(e.target.value)}>
                {projects.map((p) => (
                  <option key={p.projectId} value={p.projectId}>
                    {p.label}
                  </option>
                ))}
              </Select>
            ) : (
              <Input value={scopeProject} onChange={(e) => setScopeProject(e.target.value)} placeholder="p_…" spellCheck={false} autoCapitalize="off" />
            )}
          </Field>
        ) : (
          <div className="hidden sm:block" />
        )}
        <div className="sm:col-span-2">
          <div className="mb-1 text-xs font-medium text-muted">Applies to</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {KNOWLEDGE_AGENTS.map((a) => (
              <Checkbox key={a} checked={appliesTo.includes(a)} onChange={(on) => toggleAgent(a, on)} label={a} />
            ))}
          </div>
          <div className="mt-1 text-xs text-muted">{appliesTo.length ? `Only ${appliesTo.join(', ')}.` : 'None checked: every agent.'}</div>
        </div>
        {type === 'memory' ? (
          <Field label="Kind" hint={editing ? 'The kind is fixed once saved.' : undefined}>
            <Select value={kind} onChange={(e) => setKind(e.target.value)} disabled={!!editing}>
              <option value="">none</option>
              {MEMORY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
              {kind && !MEMORY_KINDS.includes(kind) ? <option value={kind}>{kind}</option> : null}
            </Select>
          </Field>
        ) : null}
        <Field label="Tags" hint="Comma separated" className={type === 'memory' ? undefined : 'sm:col-span-2'}>
          <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="db, infra" autoCapitalize="off" />
        </Field>
        <div className="sm:col-span-2">
          <ErrorText error={save.error} />
        </div>
      </form>
    </Modal>
  );
}
