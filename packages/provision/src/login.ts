// Login helpers: find URLs and one-time codes in a login PTY's output so clients can show
// "Open link" / "Copy code" buttons, and spot OAuth flows that call back to localhost on the
// (possibly remote) machine and therefore need a forwarded port.

import type { AgentKind } from '@bizzi/protocol';
import { defaultRecipes, type RecipeSet } from './recipes.ts';
import type { LoginSpec } from './types.ts';

export interface DetectedUrl {
  url: string;
  /** From an OSC 8 hyperlink (the visible text may differ). */
  hyperlink: boolean;
  /** Visible label for OSC 8 links. */
  label?: string;
  /** Looks like an auth/login/device URL. */
  auth: boolean;
  /** localhost OAuth callback port that needs forwarding, if any. */
  callbackPort?: number;
}

export interface DetectedCode {
  code: string;
  /** The line it was found on (escape codes stripped). */
  context: string;
  source: 'text' | 'url';
}

export interface LoginPrompts {
  urls: DetectedUrl[];
  codes: DetectedCode[];
  /** The CLI waits for the user to paste a code back (browser shows it after sign-in). */
  awaitingCodeInput: boolean;
  /** Output with escape sequences removed. */
  text: string;
}

export interface DetectOptions {
  /** Terminal width: lines exactly this long are treated as soft-wrapped. */
  cols?: number;
}

// OSC: ESC ] ... (BEL | ESC \). CSI: ESC [ params final. Other 2-char ESC sequences. C1 CSI (0x9b).
const OSC_RE = /\u001b\](?:[^\u0007\u001b]|\u001b(?!\\))*(?:\u0007|\u001b\\)/g;
const OSC8_RE = /\u001b\]8;[^;\u0007\u001b]*;((?:[^\u0007\u001b]|\u001b(?!\\))*)(?:\u0007|\u001b\\)((?:(?!\u001b\]8;).)*?)\u001b\]8;[^;\u0007\u001b]*;(?:\u0007|\u001b\\)/gs;
const CSI_RE = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
const ESC_RE = /\u001b[@-Z\\-_]|\u001b[()#][0-9A-Za-z]|\u001b[=>78]/g;
const CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Remove ANSI/VT escape sequences (CSI, OSC incl. OSC 8, charset selects) and stray controls. */
export function stripAnsi(s: string): string {
  return s.replace(OSC_RE, '').replace(CSI_RE, '').replace(ESC_RE, '').replace(/\r(?!\n)/g, '\n').replace(CTRL_RE, '');
}

const URL_CHARS = "A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%";
const URL_RE = new RegExp(`https?://[${URL_CHARS}]+`, 'g');
const URL_ONLY_LINE = new RegExp(`^[${URL_CHARS}]+$`);
const AUTH_HINT = /oauth|authorize|auth|login|signin|sign-in|device|activate|token|consent|accounts\.google|callback/i;
const CODE_PARAMS = ['user_code', 'userCode', 'otc'];

/**
 * Find login URLs and one-time codes in a chunk of terminal output. Handles ANSI colors/cursor
 * movement, OSC 8 hyperlinks, `\r` redraws and URLs soft-wrapped across lines.
 */
export function detectLoginPrompts(chunk: string, opts: DetectOptions = {}): LoginPrompts {
  const urls: DetectedUrl[] = [];
  const seen = new Set<string>();
  const addUrl = (raw: string, hyperlink: boolean, label?: string) => {
    const url = trimUrl(raw);
    if (!/^https?:\/\/[^/\s]/.test(url) || seen.has(url)) return;
    seen.add(url);
    const port = localhostCallbackPort(url);
    urls.push({
      url,
      hyperlink,
      ...(label && label !== url ? { label } : {}),
      auth: AUTH_HINT.test(url) || port !== undefined,
      ...(port !== undefined ? { callbackPort: port } : {}),
    });
  };

  for (const m of chunk.matchAll(OSC8_RE)) {
    const target = m[1] ?? '';
    if (target) addUrl(target, true, stripAnsi(m[2] ?? '').trim() || undefined);
  }

  const text = stripAnsi(chunk);
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''));
  const joined = unwrapUrls(lines, opts.cols);
  for (const m of joined.matchAll(URL_RE)) addUrl(m[0], false);

  const codes = findCodes(lines, urls);
  return { urls, codes, awaitingCodeInput: PASTE_PROMPT.test(text), text };
}

/** Rejoin URLs that the terminal wrapped onto following lines. */
function unwrapUrls(lines: string[], cols: number | undefined): string {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? '';
    for (;;) {
      const next = lines[i + 1];
      if (next === undefined) break;
      const urlAtEnd = new RegExp(`https?://[${URL_CHARS}]*$`).test(line);
      if (!urlAtEnd) break;
      const cont = next.trim();
      if (!cont || !URL_ONLY_LINE.test(cont)) break;
      const wrappedByWidth = cols !== undefined && (line.length >= cols || stripBoxIndent(line).length >= cols - 4);
      const looksLikeUrlTail = /[=&%/?#]/.test(cont) || cont.length >= 16;
      if (cols !== undefined ? !(wrappedByWidth || looksLikeUrlTail) : !looksLikeUrlTail) break;
      line += cont;
      i++;
    }
    out.push(line);
  }
  return out.join('\n');
}

function stripBoxIndent(s: string): string {
  return s.replace(/^[\s│|]+/, '');
}

function trimUrl(u: string): string {
  let url = u.replace(/[.,;:!?'"]+$/, '');
  // Drop unbalanced closing brackets (e.g. "(see https://x/y)").
  for (const [open, close] of [
    ['(', ')'],
    ['[', ']'],
  ] as const) {
    while (url.endsWith(close) && count(url, open) < count(url, close)) url = url.slice(0, -1);
  }
  return url;
}

function count(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

const PASTE_PROMPT = /paste (?:the |your )?(?:authori[sz]ation |auth |login )?code|enter (?:the |your )?(?:authori[sz]ation |auth )code|code here if prompted|authorization code:/i;
const CODE_KEYWORD = /\b(?:code|one-time|otp|verification|enter)\b/i;
// XXXX-XXXX style (device / one-time codes), 2–3 groups of 3–8 uppercase alphanumerics.
const DASHED_CODE = /\b([A-Z0-9]{3,8}(?:-[A-Z0-9]{3,8}){1,2})\b/g;
// Single token after "code:" (e.g. "Your code: 8F3KQ2").
const KEYWORD_CODE = /\bcode\b[^:\n]{0,30}:\s*([A-Za-z0-9]{4,12})(?![-A-Za-z0-9])/gi;

function findCodes(lines: string[], urls: DetectedUrl[]): DetectedCode[] {
  const codes: DetectedCode[] = [];
  const seen = new Set<string>();
  const add = (code: string, context: string, source: DetectedCode['source']) => {
    if (seen.has(code)) return;
    seen.add(code);
    codes.push({ code, context, source });
  };

  for (const u of urls) {
    try {
      const parsed = new URL(u.url);
      for (const p of CODE_PARAMS) {
        const v = parsed.searchParams.get(p);
        if (v) add(v, u.url, 'url');
      }
    } catch {
      /* not a URL */
    }
  }

  lines.forEach((raw, i) => {
    const line = raw.replace(URL_RE, ' ');
    const prev = (lines[i - 1] ?? '').replace(URL_RE, ' ');
    const nearKeyword = CODE_KEYWORD.test(line) || CODE_KEYWORD.test(prev);
    if (!nearKeyword) return;
    for (const m of line.matchAll(DASHED_CODE)) {
      const c = m[1] as string;
      if (/[A-Z]/.test(c) || /\d/.test(c)) {
        if (/^\d+(-\d+)+$/.test(c) && c.length > 12) continue; // dates/phone numbers
        add(c, raw.trim(), 'text');
      }
    }
    for (const m of line.matchAll(KEYWORD_CODE)) {
      const c = m[1] as string;
      if (/\d/.test(c) && /^[A-Z0-9]+$/.test(c)) add(c, raw.trim(), 'text');
    }
  });
  return codes;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);
const REDIRECT_PARAMS = ['redirect_uri', 'redirect_url', 'redirectUri', 'redirect', 'callback', 'callback_url', 'return_to'];

/**
 * The localhost port an OAuth flow will call back to, which must be forwarded when the CLI runs
 * on another machine: either the URL itself is on localhost, or its redirect_uri points there.
 */
export function localhostCallbackPort(url: string): number | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const own = localPort(parsed);
  if (own !== undefined) return own;
  for (const p of REDIRECT_PARAMS) {
    const v = parsed.searchParams.get(p);
    if (!v) continue;
    try {
      const port = localPort(new URL(v));
      if (port !== undefined) return port;
    } catch {
      /* not a URL */
    }
  }
  return undefined;
}

function localPort(u: URL): number | undefined {
  if (!LOCAL_HOSTS.has(u.hostname)) return undefined;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  if (u.port) return Number(u.port);
  return u.protocol === 'https:' ? 443 : 80;
}

/**
 * Stateful scanner for a streaming login PTY: buffers recent output so URLs split across chunks
 * are found, and reports each URL/code once.
 */
export class LoginPromptScanner {
  #buffer = '';
  readonly #seenUrls = new Set<string>();
  readonly #seenCodes = new Set<string>();
  readonly #opts: DetectOptions;
  readonly #maxBuffer: number;
  #awaiting = false;

  constructor(opts: DetectOptions & { maxBuffer?: number } = {}) {
    this.#opts = opts.cols !== undefined ? { cols: opts.cols } : {};
    this.#maxBuffer = opts.maxBuffer ?? 16 * 1024;
  }

  set cols(cols: number) {
    this.#opts.cols = cols;
  }

  /** Feed a chunk; returns only what is new since the last call. */
  push(chunk: string): LoginPrompts {
    this.#buffer = (this.#buffer + chunk).slice(-this.#maxBuffer);
    const all = detectLoginPrompts(this.#buffer, this.#opts);
    // A URL still being written (no trailing newline yet) may grow; hold it back until complete.
    const tailOpen = !/[\n\r]\s*$/.test(this.#buffer);
    const lastLine = all.text.split('\n').at(-1) ?? '';
    const urls = all.urls.filter((u) => {
      if (this.#seenUrls.has(u.url)) return false;
      if (tailOpen && !u.hyperlink && lastLine.trimEnd().endsWith(u.url)) return false;
      // A longer URL supersedes a prefix seen earlier (wrapped line completed later).
      this.#seenUrls.add(u.url);
      return true;
    });
    const codes = all.codes.filter((c) => !this.#seenCodes.has(c.code) && this.#seenCodes.add(c.code));
    const awaiting = all.awaitingCodeInput && !this.#awaiting;
    if (all.awaitingCodeInput) this.#awaiting = true;
    return { urls, codes, awaitingCodeInput: awaiting, text: stripAnsi(chunk) };
  }
}

/** The recipe's login options (interactive command + headless alternatives). */
export function loginSpec(agent: AgentKind, recipes: RecipeSet = defaultRecipes()): LoginSpec | undefined {
  return recipes.get(agent)?.login;
}
