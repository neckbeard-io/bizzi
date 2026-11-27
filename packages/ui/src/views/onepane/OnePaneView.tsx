// One-pane mode (spec §11.2): one composer, no navigation. You type; bizzi asks `route.suggest` where it
// should run, shows the target and why, and Enter starts a session there when the router is confident.
// Not confident: the top candidates and "other…" to pick from. A follow-up continues the open session
// (step 2) unless a token changes the target. Every routed send is recorded (`route.record`), overrides
// included, as the labeled set for choosing a classifier.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { selectMachineList } from '@bizzi/client';
import type { AgentKind, MachineInfo, RouteCandidate, RouteDecisionInput, RouteSuggestion, WorkspaceInfo } from '@bizzi/protocol';
import { openAddWorkspace } from '../../app/addWorkspace.ts';
import { useBizzi, useStore } from '../../app/context.tsx';
import { navigate, useAction, useIsWide } from '../../app/hooks.ts';
import { Icon } from '../../components/icons.tsx';
import { PageHeader } from '../../components/layout.tsx';
import { Button, ErrorText, Input, Kbd, Modal, Spinner, cx } from '../../components/ui.tsx';
import { useDraft } from '../../lib/drafts.ts';
import { errorInfo, isBusy } from '../../lib/format.ts';
import {
  ROUTABLE_AGENTS,
  applyCompletion,
  chooseAgent,
  completions,
  continues,
  decisionFor,
  otherTargets,
  parseTokens,
  planRoute,
  routeReason,
  titleFor,
  tokenAt,
} from '../../lib/onePane.ts';
import type { ActiveToken, Completion, RoutePlan } from '../../lib/onePane.ts';
import { AGENT_LABEL } from '../../lib/states.ts';
import { CompletionMenu } from '../../components/CompletionMenu.tsx';
import { builtinCommand, commandDetail, matchCommands, sessionCommands } from '../../lib/slash.ts';
import { AttachImageButton, AttachmentTray, useDraftAttachments } from '../session/Attachments.tsx';
import { Timeline } from '../session/Timeline.tsx';
import { RoutingRules } from './RoutingRules.tsx';

const SUGGEST_DELAY_MS = 500;
const EMPTY_WS: Readonly<Record<string, WorkspaceInfo>> = {};

const sameItems = <T,>(a: readonly T[], b: readonly T[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export function OnePaneView(props: { sessionId?: string }): ReactNode {
  const { sessionId } = props;
  const [ruleDraft, setRuleDraft] = useState<{ workspaceId: string } | null>(null);
  const title = useBizzi((s) => (sessionId ? (s.sessions[sessionId]?.title ?? null) : null));
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Ask"
        subtitle={sessionId ? (title ?? 'Session') : 'Type what you want; bizzi picks where it runs'}
        actions={
          sessionId ? (
            <>
              <Button size="sm" variant="ghost" icon="external" onClick={() => navigate({ name: 'session', sessionId, tab: 'chat' })}>
                <span className="hidden sm:inline">Open session</span>
              </Button>
              <Button size="sm" icon="plus" onClick={() => navigate({ name: 'ask' })}>
                New task
              </Button>
            </>
          ) : null
        }
      />
      <div className="min-h-0 flex-1">{sessionId ? <SessionPane key={sessionId} sessionId={sessionId} /> : <Intro />}</div>
      <RouteComposer {...(sessionId ? { sessionId } : {})} onMakeRule={(workspaceId) => setRuleDraft({ workspaceId })} />
      {ruleDraft ? (
        <Modal title="New routing rule" onClose={() => setRuleDraft(null)}>
          <RoutingRules draft={ruleDraft} onSaved={() => setRuleDraft(null)} />
        </Modal>
      ) : null}
    </div>
  );
}

function SessionPane(props: { sessionId: string }): ReactNode {
  const store = useStore();
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    store.openSession(props.sessionId).catch((e: unknown) => setError(e));
  }, [store, props.sessionId]);
  if (error) return <ErrorText error={error} className="m-4" />;
  return <Timeline sessionId={props.sessionId} />;
}

function Intro(): ReactNode {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-10 text-sm text-muted">
        <div className="flex items-center gap-2 text-fg">
          <Icon name="sparkle" size={18} />
          <span className="font-medium">One composer for every machine</span>
        </div>
        <p>
          Say what you want done. bizzi shows where it would run and why before sending; when it isn't sure, you pick. Name the place yourself with{' '}
          <code className="text-fg">@machine</code>, <code className="text-fg">#workspace</code> and <code className="text-fg">/agent</code>.
        </p>
        <p>Follow-ups stay in the session you're in until you change the target or start a new task.</p>
        <details className="rounded-lg border border-border bg-panel px-3 py-2">
          <summary className="cursor-pointer text-xs font-semibold tracking-wide uppercase">Routing rules and recorded routes</summary>
          <div className="pt-3">
            <RoutingRules />
          </div>
        </details>
      </div>
    </div>
  );
}

type Suggested = { text: string; s: RouteSuggestion } | null;

function RouteComposer(props: { sessionId?: string; onMakeRule: (workspaceId: string) => void }): ReactNode {
  const { sessionId } = props;
  const store = useStore();
  const wide = useIsWide();
  const machines = useBizzi(selectMachineList, sameItems);
  const workspaces = useBizzi((s) => s.workspaces) ?? EMPTY_WS;
  const agents = useBizzi((s) => s.agents);
  const sessions = useBizzi((s) => s.sessions);
  const onlineKey = useBizzi((s) => (s.connection.state !== 'open' ? '' : selectMachineList(s).filter((m) => (s.role === 'hub' ? m.online : m.id === s.machine?.id)).map((m) => m.id).join(',')));
  const online = useMemo(() => {
    const set = new Set(onlineKey.split(',').filter(Boolean));
    return (id: string) => set.has(id);
  }, [onlineKey]);
  const session = sessionId ? sessions[sessionId] : undefined;
  const caps = useBizzi((s) => (sessionId ? (s.capabilities[sessionId] ?? null) : null));
  const activeTurn = useBizzi((s) => (sessionId ? (s.timelines[sessionId]?.activeTurnId ?? null) : null));
  const advertised = useBizzi((s) => (sessionId ? s.timelines[sessionId]?.info.commands : undefined));

  // `#/ask?text=…` prefills the composer (launchers, share targets); nothing is sent until you press Enter.
  // Unsent text is kept per session (or for a new ask) across reloads and app restarts.
  const [text, setText] = useDraft(sessionId ?? 'ask', () => prefillFromHash(window.location.hash));
  const [caret, setCaret] = useState(() => text.length);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  const [suggested, setSuggested] = useState<Suggested>(null);
  const [suggestError, setSuggestError] = useState<unknown>(null);
  const [changing, setChanging] = useState(false);
  const [agentPick, setAgentPick] = useState<AgentKind | null>(null);
  const [override, setOverride] = useState<RouteDecisionInput | null>(null);
  const [nudge, setNudge] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const latest = useRef(text);
  latest.current = text;

  const wsList = useMemo(() => Object.values(workspaces), [workspaces]);
  const token: ActiveToken | null = tokenAt(text, caret);
  const items: Completion[] = useMemo(
    () => (token && !menuClosed ? completions(text, token, { machines, workspaces: wsList, agents, online }) : []),
    [text, token?.start, token?.sigil, caret, menuClosed, machines, wsList, agents, online],
  );
  const tokens = useMemo(() => parseTokens(text, machines, wsList), [text, machines, wsList]);
  const continuing = continues(session, tokens, session ? online(session.machineId) : false);
  const busy = continuing && (activeTurn !== null || isBusy(session?.status));
  const canSteer = busy && (caps?.steer ?? false);
  const images = continuing ? (caps?.images ?? true) : true;
  const draft = useDraftAttachments({ text, onChange: (v, pos) => onEdit(v, pos), textarea: ref, images });
  // Continuing a session, `/` at the start also offers its slash commands (before the agents).
  const commandItems: Completion[] = useMemo(() => {
    if (!continuing || menuClosed || token?.sigil !== '/' || token.start !== 0) return [];
    return matchCommands(sessionCommands(advertised), token.query).map((c) => {
      const detail = commandDetail(c);
      return { key: `cmd:${c.name}`, label: c.name, insert: `/${c.name}`, ...(detail ? { detail } : {}) };
    });
  }, [continuing, menuClosed, token?.sigil, token?.start, token?.query, advertised]);
  const menu = useMemo(() => [...commandItems, ...items].map((c) => ({ ...c, prefix: token?.sigil ?? '' })), [commandItems, items, token?.sigil]);
  const menuTitle = commandItems.length ? (items.length ? 'Commands and agents' : 'Commands') : token?.sigil === '@' ? 'Machines' : token?.sigil === '#' ? 'Workspaces' : 'Agents';

  // Ask the router once typing pauses (not while continuing: the target is the open session).
  useEffect(() => {
    if (continuing || !text.trim()) return;
    if (suggested?.text === text) return;
    const t = setTimeout(() => {
      store.suggestRoute(text).then(
        (s) => {
          if (latest.current === text) {
            setSuggested({ text, s });
            setSuggestError(null);
          }
        },
        (e: unknown) => {
          if (latest.current === text) setSuggestError(e);
        },
      );
    }, SUGGEST_DELAY_MS);
    return () => clearTimeout(t);
  }, [text, continuing, store]);

  const s = suggested?.s ?? null;
  const fresh = suggested?.text === text;
  const plan: RoutePlan | null = s ? planRoute(s, online) : null;
  const target = plan?.kind === 'send' ? plan.target : null;
  useEffect(() => setAgentPick(null), [target?.workspaceId]);

  const agentFor = (t: RouteCandidate, sug: RouteSuggestion): ReturnType<typeof chooseAgent> => {
    if (agentPick) return { agent: agentPick };
    const m = machines.find((x) => x.id === t.machineId);
    return chooseAgent({ explicit: sug.agent, agents: agents[t.machineId], sessions: Object.values(sessions), workspaceId: t.workspaceId, machineName: m?.name ?? t.label });
  };

  const start = useAction(async (t: RouteCandidate, sug: RouteSuggestion, typed: string) => {
    if (draft.pending > 0) throw new Error('Wait for the images to finish reading.');
    const input = draft.build(sug.text);
    if (input.length === 0) throw new Error('Say what you want done, not only where.');
    const prompt = draft.typed(sug.text) || (input.some((b) => b.type === 'image') ? 'Image' : '');
    if (store.getState().agents[t.machineId] === undefined) await store.loadAgents(t.machineId).catch(() => {});
    const m = machines.find((x) => x.id === t.machineId);
    const st = store.getState();
    const picked = agentPick
      ? { agent: agentPick }
      : chooseAgent({ explicit: sug.agent, agents: st.agents[t.machineId], sessions: Object.values(st.sessions), workspaceId: t.workspaceId, machineName: m?.name ?? t.label });
    if ('error' in picked) throw new Error(picked.error);
    const firstText = input.find((b) => b.type === 'text');
    const title = titleFor(prompt || (firstText?.type === 'text' ? firstText.text : ''));
    const created = await store.createSession({ workspaceId: t.workspaceId, agent: picked.agent, mode: 'structured', title });
    await store.send(created.id, input);
    const decision = decisionFor(typed, sug, t, picked.agent, created.id);
    // A server without route.record (older) still routes; the label is just not kept.
    store.recordRoute(decision).catch(() => {});
    setOverride(decision.overridden ? decision : null);
    setText('');
    draft.clear();
    setSuggested(null);
    setChanging(false);
    navigate({ name: 'ask', sessionId: created.id });
  });

  const followUp = useAction(async () => {
    if (!sessionId || draft.pending > 0) return;
    if (builtinCommand(text) === 'clear') {
      if (busy) throw new Error('The agent is working: wait for it or stop it before clearing.');
      await store.clearSession(sessionId);
      setText('');
      draft.clear();
      return;
    }
    const input = draft.build(text);
    if (input.length === 0) return;
    if (busy) await store.steer(sessionId, input);
    else await store.send(sessionId, input);
    setText('');
    draft.clear();
  });

  const route = useAction(async () => {
    const typed = text;
    if (!typed.trim()) return;
    if (builtinCommand(typed)) throw new Error('Open a session to clear it: there is no conversation here yet.');
    let sug = fresh ? s : null;
    if (!sug) {
      try {
        sug = await store.suggestRoute(typed);
        setSuggested({ text: typed, s: sug });
        setSuggestError(null);
      } catch (e) {
        setSuggestError(e);
        setChanging(true);
        return;
      }
    }
    const p = planRoute(sug, online);
    if (p.kind === 'send' && !changing) await start.run(p.target, sug, typed);
    else {
      setNudge(true);
      setTimeout(() => setNudge(false), 600);
    }
  });

  const submit = (): void => {
    if (continuing) {
      if (!busy || canSteer) void followUp.run();
    } else void route.run();
  };

  const pick = (c: Completion): void => {
    if (!token || c.disabled) return;
    const next = applyCompletion(text, token, c);
    pendingCaret.current = next.caret;
    setText(next.text);
    setCaret(next.caret);
    setMenuIndex(0);
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    if (pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [text]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (menu.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setMenuIndex((i) => (i + d + menu.length) % menu.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const c = menu[Math.min(menuIndex, menu.length - 1)];
        // Enter on a command that's already typed out runs it instead of re-inserting it.
        const typedOut = e.key === 'Enter' && c?.key.startsWith('cmd:') && token && text.slice(token.start, token.end) === c.insert;
        if (c && !c.disabled && !typedOut) {
          e.preventDefault();
          pick(c);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenuClosed(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && wide) {
      e.preventDefault();
      submit();
    }
  };

  const onEdit = (value: string, pos: number): void => {
    setText(value);
    setCaret(pos);
    setMenuClosed(false);
    setMenuIndex(0);
    if (!value.trim()) setChanging(false);
  };

  const sending = start.busy || route.busy || followUp.busy;
  const error = start.error ?? route.error ?? followUp.error;
  const placeholder = continuing ? (busy ? (canSteer ? 'Steer the agent while it works…' : 'The agent is working…') : 'Follow up, or @machine #workspace /agent to go elsewhere…') : 'What do you want done?';

  return (
    <div className="pb-safe shrink-0 border-t border-border bg-panel">
      <div className="mx-auto max-w-3xl px-3 pt-2 pb-3 md:px-5">
        <ErrorText error={error ?? draft.error} className="mb-2" />
        {override ? <OverrideHint decision={override} onMakeRule={() => props.onMakeRule(override.chosen.workspaceId)} onClose={() => setOverride(null)} /> : null}
        <div className="relative">
          {menu.length > 0 ? <CompletionMenu title={menuTitle} items={menu} index={Math.min(menuIndex, menu.length - 1)} onPick={pick} onHover={setMenuIndex} /> : null}
          <div className="rounded-xl border border-border bg-bg px-2 py-1.5 focus-within:border-accent" onDragOver={draft.onDragOver} onDrop={draft.onDrop}>
            <AttachmentTray draft={draft} />
            <div className="flex items-end gap-2">
              {images ? <AttachImageButton draft={draft} /> : null}
              <textarea
                ref={ref}
                rows={1}
                value={text}
                onChange={(e) => onEdit(e.target.value, e.target.selectionStart)}
                onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
                onKeyDown={onKey}
                onPaste={draft.onPaste}
                placeholder={placeholder}
                className="max-h-[200px] min-h-[36px] flex-1 resize-none bg-transparent px-1.5 py-1.5 text-[15px] leading-6 placeholder:text-muted/80 focus:outline-none md:text-sm"
                aria-label="Prompt"
                aria-autocomplete="list"
                aria-expanded={menu.length > 0}
              />
              <Button variant="primary" icon="send" busy={sending} disabled={!draft.hasContent(text) || draft.pending > 0 || (continuing && busy && !canSteer)} onClick={submit} title={continuing ? (busy ? 'Steer' : 'Send') : 'Route and send'}>
                <span className="hidden sm:inline">{continuing && busy ? 'Steer' : 'Send'}</span>
              </Button>
            </div>
          </div>
        </div>
        <div className={cx('mt-1.5 min-h-6 px-1 text-xs transition-transform', nudge && 'translate-x-1')}>
          {continuing && session ? (
            <ContinuationLine sessionTitle={session.title ?? 'this session'} label={labelOf(session.machineId, session.workspaceId, machines, workspaces)} agent={session.agent} />
          ) : !text.trim() ? (
            <span className="text-muted">
              {session ? 'This session has ended: the next prompt starts a new one. ' : ''}
              <Kbd>@</Kbd> machine · <Kbd>#</Kbd> workspace · <Kbd>/</Kbd> agent
            </span>
          ) : (
            <TargetLine
              s={s}
              fresh={fresh}
              error={suggestError}
              plan={plan}
              changing={changing}
              agent={target && s ? agentFor(target, s) : null}
              agents={target ? (agents[target.machineId] ?? null) : null}
              onAgent={setAgentPick}
              onChange={() => setChanging((c) => !c)}
              onPick={(c) => s && void start.run(c, s, text)}
              onPickOther={(c) => void start.run(c, s ?? fallbackSuggestion(text), text)}
              others={otherTargets(machines, wsList, online)}
              nudge={nudge}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function prefillFromHash(hash: string): string {
  const i = hash.indexOf('?');
  return i < 0 ? '' : (new URLSearchParams(hash.slice(i + 1)).get('text') ?? '').slice(0, 4000);
}

/** When the router can't answer (an older server, an error), the prompt still goes where the user picks. */
function fallbackSuggestion(text: string): RouteSuggestion {
  return { source: 'none', candidates: [], confidence: 0, confident: false, text, offered: 0, note: 'routing unavailable' };
}

function labelOf(machineId: string, workspaceId: string, machines: readonly MachineInfo[], workspaces: Readonly<Record<string, WorkspaceInfo>>): string {
  const m = machines.find((x) => x.id === machineId);
  return `${m?.name ?? machineId} · ${workspaces[workspaceId]?.name ?? workspaceId}`;
}

function ContinuationLine(props: { sessionTitle: string; label: string; agent: AgentKind }): ReactNode {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-muted">
      <span aria-hidden>↳</span>
      <span className="truncate">
        continuing <span className="text-fg">{props.sessionTitle}</span> · {props.label} · {AGENT_LABEL[props.agent]}
      </span>
      <button type="button" className="ml-auto shrink-0 underline-offset-2 hover:text-fg hover:underline" onClick={() => navigate({ name: 'ask' })}>
        new task
      </button>
    </span>
  );
}

function TargetLine(props: {
  s: RouteSuggestion | null;
  fresh: boolean;
  error: unknown;
  plan: RoutePlan | null;
  changing: boolean;
  agent: ReturnType<typeof chooseAgent> | null;
  agents: readonly { agent: AgentKind; installed: boolean }[] | null;
  onAgent: (a: AgentKind) => void;
  onChange: () => void;
  onPick: (c: RouteCandidate) => void;
  onPickOther: (c: RouteCandidate) => void;
  others: RouteCandidate[];
  nudge: boolean;
}): ReactNode {
  const { s, plan } = props;
  const [otherOpen, setOtherOpen] = useState(false);
  const pending = !props.fresh && !props.error;
  if (!s || !plan) {
    if (props.error) {
      const { code, message } = errorInfo(props.error);
      return (
        <div className="flex flex-col gap-1.5">
          <span className="text-warn">{code === 'unsupported' ? "This server can't route prompts yet: pick where this runs." : `Routing failed: ${message}`}</span>
          <OtherPicker others={props.others} onPick={props.onPickOther} />
        </div>
      );
    }
    return (
      <span className="flex items-center gap-1.5 text-muted">
        <Spinner size={12} /> finding where this runs…
      </span>
    );
  }

  const showChoices = plan.kind === 'ask' || props.changing;
  const choices = plan.kind === 'ask' ? plan.choices : s.candidates;
  return (
    <div className={cx('flex flex-col gap-1.5', pending && 'opacity-60')}>
      {plan.kind === 'send' && !props.changing ? (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate text-fg">
            → <span className="font-medium">{plan.target.label}</span>
          </span>
          <AgentChoice agent={props.agent} agents={props.agents} onAgent={props.onAgent} />
          <span className="truncate text-muted">{routeReason(s)}</span>
          {pending ? <Spinner size={11} /> : null}
          <button type="button" className="ml-auto shrink-0 text-muted underline-offset-2 hover:text-fg hover:underline" onClick={props.onChange}>
            change
          </button>
        </div>
      ) : (
        <div className={cx('flex min-w-0 items-center gap-2', props.nudge ? 'text-warn' : 'text-muted')}>
          <Icon name="question" size={13} className="shrink-0" />
          <span className="truncate">{plan.kind === 'ask' ? `Where should this run? ${plan.note}` : 'Pick another target'}</span>
          {pending ? <Spinner size={11} /> : null}
          {props.changing && plan.kind === 'send' ? (
            <button type="button" className="ml-auto shrink-0 underline-offset-2 hover:text-fg hover:underline" onClick={props.onChange}>
              keep {plan.target.label}
            </button>
          ) : null}
        </div>
      )}
      {showChoices ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {choices.map((c, i) => (
            <Button key={c.workspaceId} size="sm" variant={i === 0 ? 'primary' : 'secondary'} disabled={pending} onClick={() => props.onPick(c)} title={c.probability < 1 ? `${Math.round(c.probability * 100)}%` : undefined}>
              {c.label}
              {s.source === 'classifier' ? <span className="opacity-70">{Math.round(c.probability * 100)}%</span> : null}
            </Button>
          ))}
          <Button size="sm" variant="ghost" icon="search" onClick={() => setOtherOpen((o) => !o)} aria-expanded={otherOpen}>
            other…
          </Button>
        </div>
      ) : null}
      {showChoices && otherOpen ? <OtherPicker others={props.others.filter((o) => !choices.some((c) => c.workspaceId === o.workspaceId))} onPick={props.onPickOther} disabled={pending} /> : null}
    </div>
  );
}

function AgentChoice(props: { agent: ReturnType<typeof chooseAgent> | null; agents: readonly { agent: AgentKind; installed: boolean }[] | null; onAgent: (a: AgentKind) => void }): ReactNode {
  const a = props.agent;
  if (!a) return null;
  if ('error' in a) return <span className="text-warn">{a.error}</span>;
  const installed = (props.agents ?? []).filter((x) => x.installed && ROUTABLE_AGENTS.includes(x.agent)).map((x) => x.agent);
  if (installed.length < 2) return <span className="text-fg">· {AGENT_LABEL[a.agent]}</span>;
  return (
    <label className="relative inline-flex items-center gap-1 text-fg" title="Agent: change it here or with /agent">
      <span aria-hidden>·</span>
      <select
        aria-label="Agent"
        value={a.agent}
        onChange={(e) => props.onAgent(e.target.value as AgentKind)}
        className="cursor-pointer appearance-none rounded border border-transparent bg-transparent py-0 pr-4 pl-1 text-xs hover:border-border focus:border-accent focus:outline-none"
      >
        {installed.map((k) => (
          <option key={k} value={k}>
            {AGENT_LABEL[k]}
          </option>
        ))}
      </select>
      <Icon name="chevronDown" size={11} className="pointer-events-none absolute right-0.5 text-muted" />
    </label>
  );
}

function OtherPicker(props: { others: RouteCandidate[]; onPick: (c: RouteCandidate) => void; disabled?: boolean }): ReactNode {
  const [q, setQ] = useState('');
  const shown = props.others.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 30);
  return (
    <div className="rounded-lg border border-border bg-panel p-2">
      <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Any workspace on an online machine…" className="h-8" aria-label="Filter workspaces" />
      <div className="scrollbar-thin mt-1.5 max-h-48 overflow-y-auto">
        {shown.map((o) => (
          <button key={o.workspaceId} type="button" disabled={props.disabled} className="block w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-panel-2 disabled:opacity-50" onClick={() => props.onPick(o)}>
            {o.label}
          </button>
        ))}
        {shown.length === 0 ? <div className="px-2 py-1 text-sm text-muted">No workspace matches.</div> : null}
      </div>
      <button type="button" className="mt-1 flex items-center gap-1.5 px-2 py-1 text-sm text-accent-text hover:underline" onClick={() => openAddWorkspace(null)}>
        <Icon name="plus" size={14} /> New workspace…
      </button>
    </div>
  );
}

function OverrideHint(props: { decision: RouteDecisionInput; onMakeRule: () => void; onClose: () => void }): ReactNode {
  const from = props.decision.candidates[0]?.label;
  return (
    <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-panel-2 px-3 py-1.5 text-xs text-muted">
      <span className="min-w-0 flex-1 truncate">
        Sent to <span className="text-fg">{props.decision.chosen.label}</span>
        {from ? ` instead of ${from}` : ''}. Always send prompts like this there?
      </span>
      <button type="button" className="shrink-0 text-accent-text hover:underline" onClick={props.onMakeRule}>
        Make a rule…
      </button>
      <button type="button" aria-label="Dismiss" className="shrink-0 hover:text-fg" onClick={props.onClose}>
        <Icon name="x" size={13} />
      </button>
    </div>
  );
}
