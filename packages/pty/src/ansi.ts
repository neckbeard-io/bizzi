// Cheap ANSI/VT escape stripping for heuristics (prompt detection). Not a terminal emulator:
// cursor moves become whitespace so words drawn with cursor positioning stay separated.

// CSI: ESC [ params intermediates final  (also the 8-bit CSI 0x9b is ignored; TUIs use 7-bit)
const CSI = /\x1b\[([0-?]*)[ -/]*([@-~])/g;
// OSC: ESC ] ... BEL | ESC \ ; DCS/SOS/PM/APC: ESC P|X|^|_ ... ESC \
const STRINGS = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?/g;
// Remaining two-byte escapes (ESC 7, ESC =, ESC ( B, …)
const SHORT = /\x1b[()*+][0-~]|\x1b[ -~]/g;
// C0 controls except \n and \t
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g;

export function stripAnsi(text: string): string {
  return text
    .replace(STRINGS, '')
    .replace(CSI, (_m, _params: string, final: string) => {
      // Same-line moves (forward, column-absolute: Claude's Ink renderer uses CSI n G between
      // words) become a space; vertical/absolute positioning becomes a newline.
      if (final === 'C' || final === 'G') return ' ';
      if ('HfABEFd'.includes(final)) return '\n';
      return '';
    })
    .replace(SHORT, '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROLS, '');
}

/** Bracketed-paste mode toggles (DECSET/DECRST 2004). Returns the last state seen, if any. */
export function lastBracketedPasteState(text: string): boolean | undefined {
  const on = text.lastIndexOf('\x1b[?2004h');
  const off = text.lastIndexOf('\x1b[?2004l');
  if (on < 0 && off < 0) return undefined;
  return on > off;
}
