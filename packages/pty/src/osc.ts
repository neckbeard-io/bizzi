// Streaming OSC scanner: pulls the few OSC sequences bizzi cares about (7501 program status, 133
// shell-integration prompt marks) out of decoded terminal output. It keeps state between chunks,
// so a sequence split across PTY reads is still seen whole. It never changes the output: the raw
// bytes still go to clients, and `stripAnsi` still removes the sequences from heuristic text.
//
// Grammar handled: ESC ] <body> (BEL | ESC \). An ESC followed by anything else, CAN or SUB inside
// the body aborts the sequence (as in a VT parser). The 8-bit C1 forms (0x9d / 0x9c) are not
// recognised: in UTF-8 output those bytes only appear inside multi-byte characters.

export type OscEvent =
  /** OSC 7501 body after `7501;`. `overflow` = the body exceeded the size cap and was cut. */
  | { type: 'osc7501'; payload: string; overflow: boolean }
  /** OSC 133 ; A: the shell (or TUI) is drawing a new prompt. */
  | { type: 'prompt-start' };

/** Longest OSC 7501 body kept (characters after `7501;`). Longer reports are flagged as overflow. */
export const MAX_OSC7501_LENGTH = 4096;

const ESC = '\x1b';
const BEL = '\x07';
const CAN = '\x18';
const SUB = '\x1a';

const S_GROUND = 0;
const S_ESC = 1;
const S_BODY = 2;
const S_BODY_ESC = 3;

/** Prefixes worth buffering; any other OSC (titles, OSC 8 links, OSC 52 clipboard) is skipped unbuffered. */
const WANTED = ['7501;', '133;'];

function couldBeWanted(prefix: string): boolean {
  return WANTED.some((w) => (prefix.length <= w.length ? w.startsWith(prefix) : prefix.startsWith(w)));
}

export interface OscScannerOptions {
  maxReportLength?: number;
}

export class OscScanner {
  #state = S_GROUND;
  /** Buffered body of the current OSC (only while it may be one we want). */
  #body = '';
  /** The current OSC is not one we want: consume to the terminator without buffering. */
  #skip = false;
  #overflow = false;
  readonly #max: number;

  constructor(opts: OscScannerOptions = {}) {
    this.#max = opts.maxReportLength ?? MAX_OSC7501_LENGTH;
  }

  /** Feed decoded output; returns the complete sequences found, in order. */
  push(text: string): OscEvent[] {
    const out: OscEvent[] = [];
    let i = 0;
    const n = text.length;
    while (i < n) {
      switch (this.#state) {
        case S_GROUND: {
          const e = text.indexOf(ESC, i);
          if (e < 0) return out;
          this.#state = S_ESC;
          i = e + 1;
          break;
        }
        case S_ESC: {
          const c = text[i]!;
          if (c === ']') {
            this.#state = S_BODY;
            this.#body = '';
            this.#skip = false;
            this.#overflow = false;
            i++;
          } else if (c === ESC) {
            i++; // ESC ESC: stay in ESC
          } else {
            this.#state = S_GROUND;
            i++;
          }
          break;
        }
        case S_BODY: {
          // Find the next byte that can end or abort the body.
          let j = i;
          while (j < n) {
            const c = text[j]!;
            if (c === BEL || c === ESC || c === CAN || c === SUB) break;
            j++;
          }
          if (j > i) this.#collect(text, i, j);
          if (j >= n) return out;
          const c = text[j]!;
          if (c === BEL) {
            this.#finish(out);
            this.#state = S_GROUND;
          } else if (c === ESC) {
            this.#state = S_BODY_ESC;
          } else {
            this.#abort();
            this.#state = S_GROUND;
          }
          i = j + 1;
          break;
        }
        case S_BODY_ESC: {
          const c = text[i]!;
          if (c === '\\') {
            this.#finish(out);
            this.#state = S_GROUND;
            i++;
          } else {
            // ESC inside an OSC starts a new escape; the OSC is abandoned. Re-read c in ESC state.
            this.#abort();
            this.#state = S_ESC;
          }
          break;
        }
      }
    }
    return out;
  }

  /** Forget any partial sequence (e.g. after a terminal reset or process restart). */
  reset(): void {
    this.#state = S_GROUND;
    this.#abort();
  }

  #collect(text: string, from: number, to: number): void {
    if (this.#skip) return;
    const room = this.#max + 5 /* '7501;' */ - this.#body.length;
    if (to - from > room) {
      this.#body += text.slice(from, from + Math.max(room, 0));
      this.#overflow = true;
    } else {
      this.#body += text.slice(from, to);
    }
    if (!couldBeWanted(this.#body.slice(0, 5))) {
      this.#skip = true;
      this.#body = '';
    }
  }

  #finish(out: OscEvent[]): void {
    const body = this.#body;
    const skip = this.#skip;
    const overflow = this.#overflow;
    this.#abort();
    if (skip) return;
    if (body.startsWith('7501;')) {
      out.push({ type: 'osc7501', payload: body.slice(5), overflow });
    } else if (body === '133;A' || body.startsWith('133;A;')) {
      out.push({ type: 'prompt-start' });
    }
  }

  #abort(): void {
    this.#body = '';
    this.#skip = false;
    this.#overflow = false;
  }
}
