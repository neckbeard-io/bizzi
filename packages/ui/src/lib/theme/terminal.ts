// Resolved terminal palette → xterm.js ITheme (theming.md §8). Used by terminal-mode sessions and login PTYs.
import type { ITheme } from '@xterm/xterm';
import type { ResolvedTerminal } from './types.ts';

const NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;
const BRIGHT = ['brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const;

export function xtermTheme(t: ResolvedTerminal): ITheme {
  const theme: ITheme = {
    background: t.background,
    foreground: t.foreground,
    cursor: t.cursor,
    cursorAccent: t.cursorAccent,
    selectionBackground: t.selection,
    selectionInactiveBackground: t.selection,
  };
  NAMES.forEach((n, i) => (theme[n] = t.ansi[i]));
  BRIGHT.forEach((n, i) => (theme[n] = t.ansi[i + 8]));
  return theme;
}
