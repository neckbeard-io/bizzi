import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { STATE_SECTIONS, selectMachineList, selectMachineOnline, selectSessionsByState, stateSectionsEqual } from '@bizzi/client';
import type { StateSection, StateSessionLine } from '@bizzi/client';
import { useBizzi } from '../../app/context.tsx';
import { isMac } from '../../app/hotkeys.ts';
import { Icon } from '../../components/icons.tsx';
import { WorkspaceTile } from '../../components/labels.tsx';
import { StateSymbol } from '../../components/marks.tsx';
import { cx } from '../../components/ui.tsx';
import { HOTKEYS, hotkeyLabel } from '../../lib/hotkeys.ts';
import { readSectionFolds, sectionFolded } from '../../lib/sidebarTree.ts';
import { loadJson, saveJson } from '../../lib/storage.ts';
import { SessionLeaf } from './MachineTree.tsx';

const SECTION_FOLDS_KEY = 'bizzi.sidebar.stateFolded';

const noFold = (): void => {};

/**
 * The sidebar's "By state" view (spec §11.1): every live session on every machine in one list, under counted
 * headers in urgency order (Needs you, Failed, Working, Done, Idle), empty ones left out. Rows are the tree's
 * session rows with where the session lives in front of its name: the workspace tile and name (and the machine,
 * with more than one), or, for a helper, the session that started it. Helpers are rows under their own state
 * (a helper waiting on you is in Needs you), not nested. Each header folds, remembered per device; a long
 * Idle starts folded, and a section holding the open session stays open. Rows count toward the sidebar's
 * auto width here (they're what the view is for), so it opens up to its auto maximum.
 */
export function StateList(props: { activeSessionId: string | null }): ReactNode {
  const sections = useBizzi(selectSessionsByState, stateSectionsEqual);
  const multiMachine = useBizzi((s) => selectMachineList(s).length > 1);
  const [folds, setFolds] = useState<Record<string, boolean>>(() => readSectionFolds(loadJson(SECTION_FOLDS_KEY)));
  const toggle = useCallback((key: string, folded: boolean) => {
    setFolds((c) => {
      const next = { ...c, [key]: !folded };
      saveJson(SECTION_FOLDS_KEY, next);
      return next;
    });
  }, []);
  if (sections.length === 0) {
    const hk = HOTKEYS.find((h) => h.id === 'groupByState')!;
    return (
      <div className="px-2 py-1 text-xs text-muted">
        No live sessions. Start one from a workspace: switch to Workspaces ({hotkeyLabel(hk, isMac())}).
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {sections.map((sec) => {
        const holdsActive = sec.lines.some((l) => l.line.sessionId === props.activeSessionId);
        const folded = sectionFolded(sec.key, sec.lines.length, folds, holdsActive);
        return <Section key={sec.key} section={sec} folded={folded} onToggle={() => toggle(sec.key, folded)} multiMachine={multiMachine} activeSessionId={props.activeSessionId} />;
      })}
    </div>
  );
}

function Section(props: { section: StateSection; folded: boolean; onToggle: () => void; multiMachine: boolean; activeSessionId: string | null }): ReactNode {
  const { section: sec, folded } = props;
  const state = STATE_SECTIONS.find((x) => x.key === sec.key)!.states[0]!;
  return (
    <section>
      <button
        type="button"
        onClick={props.onToggle}
        className="flex h-7 w-full items-center gap-1.5 rounded-md pr-2 pl-0.5 text-left text-xs font-semibold hover:bg-sidebar-accent/70"
        aria-expanded={!folded}
        title={`${folded ? 'Show' : 'Hide'} ${sec.label.toLowerCase()} (${sec.lines.length})`}
      >
        <span className="flex w-[18px] shrink-0 justify-center text-muted">
          <Icon name={folded ? 'chevronRight' : 'chevronDown'} size={12} />
        </span>
        <StateSymbol state={state} size={12} className="shrink-0" />
        <span className="min-w-0 truncate">{sec.label}</span>
        <span className="shrink-0 font-normal text-muted tabular-nums">{sec.lines.length}</span>
      </button>
      {folded ? null : (
        // Unlike the tree, rows count toward the auto width (capped as always): here they are the whole view.
        <div className="ml-[9px] flex flex-col border-l border-sidebar-border pl-0.5">
          {sec.lines.map((l) => (
            <StateRow key={l.line.sessionId} item={l} multiMachine={props.multiMachine} active={props.activeSessionId === l.line.sessionId} />
          ))}
        </div>
      )}
    </section>
  );
}

/** A session row of the tree, flat (no nesting), with where it lives in front of its name. */
function StateRow(props: { item: StateSessionLine; multiMachine: boolean; active: boolean }): ReactNode {
  const { item } = props;
  const online = useBizzi((s) => selectMachineOnline(s, item.machineId));
  return (
    <div className={online ? undefined : 'opacity-60'}>
      <SessionLeaf
        line={item.line}
        indent={0}
        expandable={false}
        folded={false}
        onFold={noFold}
        phone={false}
        online={online}
        active={props.active}
        lead={<Where item={item} multiMachine={props.multiMachine} />}
      />
    </div>
  );
}

/** "▣ website" (or "▣ website · laptop" with more than one machine); for a helper "▣ ↳ Parent title". */
function Where(props: { item: StateSessionLine; multiMachine: boolean }): ReactNode {
  const { item } = props;
  const ws = useBizzi((s) => s.workspaces?.[item.workspaceId]);
  const machine = useBizzi((s) => (props.multiMachine ? (s.machines[item.machineId]?.name ?? (s.machine?.id === item.machineId ? s.machine.name : null)) : null));
  const wsName = ws ? (ws.kind === 'worktree' && ws.branch ? ws.branch : ws.name) : null;
  const place = [wsName, machine].filter(Boolean).join(' · ');
  const parent = item.parentTitle;
  const title = `${parent ? `Helper of “${parent}”` : 'In'}${place ? `${parent ? ' in ' : ' '}${place}` : ''}`;
  return (
    <span className="flex max-w-[30%] min-w-0 shrink-[4] items-center gap-1 text-[11px] font-normal text-muted" title={title}>
      {ws ? <WorkspaceTile workspace={ws} /> : null}
      <span className="min-w-0 truncate">
        {parent ? `↳ ${parent}` : place || 'unknown workspace'}
      </span>
    </span>
  );
}
