// App-wide keyboard shortcuts (Settings › Hotkeys): what each one does, how it reads on this platform,
// and which keydown matches it. Pure; the listener and the per-device on/off switches are app/hotkeys.ts.

export type HotkeyId = 'newWorkspace' | 'newSession' | 'closeSession';

export interface HotkeyDef {
  id: HotkeyId;
  /** The letter pressed with ⌘ (macOS) or Ctrl (Windows, Linux). */
  key: string;
  label: string;
  description: string;
}

export const HOTKEYS: readonly HotkeyDef[] = [
  { id: 'newWorkspace', key: 'n', label: 'New workspace', description: 'Add a workspace on the machine you are on (the open page’s machine, else the selected one).' },
  { id: 'newSession', key: 't', label: 'New session', description: 'Start a session in the open workspace with the agent’s default profile (★), and open it.' },
  { id: 'closeSession', key: 'w', label: 'Close session', description: 'End the open session and go to the next one: the agent and its helpers stop, the history is kept, and it moves to Ended in the sidebar, where you can reopen it. Elsewhere in the desktop app it closes the window.' },
];

export type HotkeyPrefs = Record<HotkeyId, boolean>;

/** Every hotkey is on until switched off on this device. */
export function readHotkeyPrefs(raw: unknown): HotkeyPrefs {
  const out = Object.fromEntries(HOTKEYS.map((h) => [h.id, true])) as HotkeyPrefs;
  if (!raw || typeof raw !== 'object') return out;
  for (const h of HOTKEYS) {
    const v = (raw as Record<string, unknown>)[h.id];
    if (typeof v === 'boolean') out[h.id] = v;
  }
  return out;
}

/** macOS (and iPadOS with a keyboard) use ⌘; everything else Ctrl. */
export function isMacPlatform(platform: string | undefined): boolean {
  return /^(darwin|mac|iphone|ipad|ios)/i.test(platform ?? '');
}

/** `⌘N` on macOS, `Ctrl+N` elsewhere. */
export function hotkeyLabel(def: Pick<HotkeyDef, 'key'>, mac: boolean): string {
  const k = def.key.toUpperCase();
  return mac ? `⌘${k}` : `Ctrl+${k}`;
}

export interface KeyLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
}

/**
 * The hotkey a keydown triggers, or null. Exactly the platform modifier and the letter: ⇧, ⌥ and the other
 * modifier must be up (⌘⇧N is not ⌘N). Matches by physical key too, so non-Latin layouts work. On Windows
 * and Linux, Ctrl+letter inside a terminal belongs to the shell (Ctrl+T, Ctrl+N, Ctrl+W), so it is left alone there.
 */
export function matchHotkey(e: KeyLike, opts: { mac: boolean; prefs: HotkeyPrefs; inTerminal?: boolean }): HotkeyId | null {
  if (e.repeat || e.altKey || e.shiftKey) return null;
  if (opts.mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return null;
  if (!opts.mac && opts.inTerminal) return null;
  const key = e.key.toLowerCase();
  for (const h of HOTKEYS) {
    if (!opts.prefs[h.id]) continue;
    if (key === h.key || e.code === `Key${h.key.toUpperCase()}`) return h.id;
  }
  return null;
}

/** Commands the desktop app's menu sends (preload → `bizzi:command` window event). */
export const MENU_COMMANDS: Readonly<Record<string, HotkeyId>> = { 'new-workspace': 'newWorkspace', 'new-session': 'newSession', 'close-session': 'closeSession' };
