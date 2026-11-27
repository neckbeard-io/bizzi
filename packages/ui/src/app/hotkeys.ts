// App-wide hotkeys (Settings › Hotkeys): the per-device on/off switches, the window keydown listener the
// shell installs, and the actions. The desktop menu shows the same shortcuts without registering them,
// so the keys land here; clicking the menu item arrives as a `bizzi:command` window event (preload).
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { selectMachineOnline, selectTargetMachineId } from '@bizzi/client';
import type { BizziStore } from '@bizzi/client';
import { preferredProfile } from '@bizzi/protocol';
import { MENU_COMMANDS, isMacPlatform, matchHotkey, readHotkeyPrefs } from '../lib/hotkeys.ts';
import type { HotkeyId, HotkeyPrefs } from '../lib/hotkeys.ts';
import { defaultAgent, profileSessionParams } from '../lib/newSession.ts';
import type { Route } from '../lib/router.ts';
import { loadJson, saveJson } from '../lib/storage.ts';
import { openAddWorkspace } from './addWorkspace.ts';
import { showToast } from './contextMenu.ts';
import { navigate } from './hooks.ts';
import { deleteSessionFlow } from './sessionActions.ts';

const KEY = 'bizzi.hotkeys';

let prefs: HotkeyPrefs = readHotkeyPrefs(loadJson(KEY));
const listeners = new Set<() => void>();

export const hotkeyStore = {
  get: (): HotkeyPrefs => prefs,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  setEnabled(id: HotkeyId, on: boolean): void {
    if (prefs[id] === on) return;
    prefs = { ...prefs, [id]: on };
    saveJson(KEY, prefs);
    for (const l of listeners) l();
  },
  reset(): void {
    prefs = readHotkeyPrefs(null);
    saveJson(KEY, prefs);
    for (const l of listeners) l();
  },
};

export function useHotkeyPrefs(): HotkeyPrefs {
  return useSyncExternalStore(hotkeyStore.subscribe, hotkeyStore.get, hotkeyStore.get);
}

/** ⌘ on macOS and iPadOS, Ctrl elsewhere: the desktop app says which OS; browsers are asked. */
export function isMac(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return isMacPlatform(window.bizzi?.platform ?? nav.userAgentData?.platform ?? navigator.platform);
}

/** Where the open page is: its workspace (workspace page, or a session's) and machine. */
export function routeContext(store: BizziStore, route: Route): { workspaceId: string | null; machineId: string | null } {
  const s = store.getState();
  const workspaceId = route.name === 'workspace' ? route.workspaceId : route.name === 'session' ? (s.sessions[route.sessionId]?.workspaceId ?? null) : null;
  const ws = workspaceId ? s.workspaces?.[workspaceId] : undefined;
  const machineId = route.name === 'machine' && route.machineId ? route.machineId : (ws?.machineId ?? (route.name === 'session' ? s.sessions[route.sessionId]?.machineId : undefined) ?? selectTargetMachineId(s));
  return { workspaceId: ws ? ws.id : null, machineId: machineId ?? null };
}

function machineName(store: BizziStore, machineId: string): string {
  const s = store.getState();
  return s.machines[machineId]?.name ?? (s.machine?.id === machineId ? s.machine.name : 'That machine');
}

/** ⌘N: the add-workspace dialog for the machine you are on. */
export function newWorkspaceHere(store: BizziStore, route: Route): void {
  const { machineId } = routeContext(store, route);
  if (!machineId) {
    showToast('No machine to add a workspace to yet', 'err');
    return;
  }
  if (!selectMachineOnline(store.getState(), machineId)) {
    showToast(`${machineName(store, machineId)} is offline`, 'err');
    return;
  }
  store.selectMachine(machineId);
  openAddWorkspace(machineId);
}

let starting = false;

/** ⌘T (and the sidebar's +): a session in this workspace with the default agent's default profile, opened. */
export async function startDefaultSession(store: BizziStore, workspaceId: string): Promise<void> {
  if (starting) return;
  const ws = store.getState().workspaces?.[workspaceId];
  if (!ws) return;
  if (!selectMachineOnline(store.getState(), ws.machineId)) {
    showToast(`${machineName(store, ws.machineId)} is offline`, 'err');
    return;
  }
  starting = true;
  try {
    if (!store.getState().agents[ws.machineId]) await store.loadAgents(ws.machineId);
    const s = store.getState();
    const listing = defaultAgent(s.agents[ws.machineId]);
    if (!listing) {
      showToast(`No agents are installed on ${machineName(store, ws.machineId)}`, 'err');
      navigate({ name: 'machine', machineId: ws.machineId });
      return;
    }
    const profile = preferredProfile(s.prefs ?? undefined, listing.agent);
    const session = await store.createSession(profileSessionParams(ws.id, listing, profile));
    navigate({ name: 'session', sessionId: session.id, tab: 'chat' });
  } catch (err) {
    showToast(`Could not start a session: ${err instanceof Error ? err.message : String(err)}`, 'err');
  } finally {
    starting = false;
  }
}

/** ⌘T where there is no workspace open: say how to get one. */
export function newSessionHere(store: BizziStore, route: Route): void {
  const { workspaceId } = routeContext(store, route);
  if (!workspaceId) {
    showToast('Open a workspace (or one of its sessions) first', 'err');
    return;
  }
  void startDefaultSession(store, workspaceId);
}

/** The desktop app (its preload sets `window.bizzi`); in a browser tab the browser owns ⌘W. */
function inDesktop(): boolean {
  return typeof window !== 'undefined' && window.bizzi !== undefined;
}

let closing = false;

/** ⌘W: delete the open session after you confirm; on any other page of the desktop app, close the window. */
export async function closeSessionHere(store: BizziStore, route: Route): Promise<void> {
  if (route.name !== 'session') {
    if (inDesktop()) window.close();
    return;
  }
  const session = store.getState().sessions[route.sessionId];
  if (!session || closing) return;
  if (!selectMachineOnline(store.getState(), session.machineId)) {
    showToast(`${machineName(store, session.machineId)} is offline`, 'err');
    return;
  }
  closing = true;
  try {
    await deleteSessionFlow(store, session);
  } catch (err) {
    showToast(`Could not delete the session: ${err instanceof Error ? err.message : String(err)}`, 'err');
  } finally {
    closing = false;
  }
}

function run(id: HotkeyId, store: BizziStore, route: Route): void {
  if (id === 'newWorkspace') newWorkspaceHere(store, route);
  else if (id === 'newSession') newSessionHere(store, route);
  else void closeSessionHere(store, route);
}

/**
 * The shell's listener: hotkeys switched on in Settings › Hotkeys, and desktop menu commands (always).
 * Capture phase, so editors and terminals that handle keys themselves don't swallow ⌘N / ⌘T / ⌘W first.
 */
export function useGlobalHotkeys(store: BizziStore, route: Route): void {
  const routeRef = useRef(route);
  routeRef.current = route;
  useEffect(() => {
    const mac = isMac();
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target instanceof Element ? e.target : null;
      const id = matchHotkey(e, { mac, prefs: hotkeyStore.get(), inTerminal: target?.closest('.xterm') !== null && target !== null });
      if (!id) return;
      // ⌘W off a session page in a browser tab: the browser's (close tab), not ours.
      if (id === 'closeSession' && routeRef.current.name !== 'session' && !inDesktop()) return;
      // A dialog is open: leave it alone rather than stack another one on top.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      e.stopPropagation();
      run(id, store, routeRef.current);
    };
    const onCommand = (e: Event): void => {
      const id = MENU_COMMANDS[String((e as CustomEvent<unknown>).detail)];
      if (id) run(id, store, routeRef.current);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener('bizzi:command', onCommand);
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      window.removeEventListener('bizzi:command', onCommand);
    };
  }, [store]);
}

