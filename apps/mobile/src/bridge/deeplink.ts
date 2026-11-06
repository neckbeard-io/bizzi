// Pairing links: the app's deep link `bizzi://pair?hub=<hub URL>&code=<pairing code>`, and the hub's own
// pairing URL `https://<hub>/#/pair?code=<pairing code>` (what the desktop's "Pair new device" QR encodes).
//
// Pure logic (no Capacitor imports) so it can be unit-tested under Node.

export const DEEP_LINK_SCHEME = 'bizzi';

/** Name of the window event the bridge dispatches when a pairing link arrives. */
export const PAIR_EVENT = 'bizzi:pair';

export interface PairLink {
  /** The link exactly as received. */
  url: string;
  /** Hub base URL (http, https, ws or wss), as given in `hub=`. */
  hub: string;
  /** Pairing code as given in `code=` (trimmed; normalize with `normalizePairingCode` before use). */
  code: string;
}

const HUB_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);
const MAX_LINK_LENGTH = 4096;
const MAX_CODE_LENGTH = 128;

/**
 * Parse a pairing deep link. Returns null for anything that isn't a well-formed
 * `bizzi://pair?hub=…&code=…` link (other bizzi:// routes, other schemes, a hub URL that isn't
 * http(s)/ws(s), a missing or oversized code).
 *
 * Accepted spellings: `bizzi://pair?…`, `bizzi:///pair?…`, `bizzi:pair?…`, `bizzi://pair/?…`;
 * the scheme and the `pair` route are case-insensitive.
 */
export function parsePairLink(input: string): PairLink | null {
  if (typeof input !== 'string') return null;
  const url = input.trim();
  if (!url || url.length > MAX_LINK_LENGTH) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parseHubPairUrl(url, parsed);
  if (parsed.protocol.toLowerCase() !== `${DEEP_LINK_SCHEME}:`) return null;

  // Non-special schemes: `bizzi://pair?x` → host "pair", pathname "";
  // `bizzi:///pair?x` → host "", pathname "/pair"; `bizzi:pair?x` → pathname "pair".
  const route = (parsed.host + parsed.pathname).replace(/^\/+|\/+$/g, '').toLowerCase();
  if (route !== 'pair') return null;

  const hub = parseHubUrl(parsed.searchParams.get('hub'));
  if (!hub) return null;

  const code = (parsed.searchParams.get('code') ?? '').trim();
  if (!code || code.length > MAX_CODE_LENGTH || !/^[\w\s-]+$/.test(code)) return null;

  return { url, hub, code };
}

/**
 * The hub's own pairing URL (`pairing.create` → `pairUrl`, also shown as a QR code on the desktop):
 * `https://bizzi.example.com[/base]/#/pair?code=XXXX-XXXX`. The hub is the URL's origin + path.
 */
function parseHubPairUrl(url: string, parsed: URL): PairLink | null {
  const hash = parsed.hash.replace(/^#\/?/, '');
  const q = hash.indexOf('?');
  const route = (q === -1 ? hash : hash.slice(0, q)).replace(/\/+$/, '').toLowerCase();
  if (route !== 'pair' || q === -1) return null;
  if (parsed.username || parsed.password) return null;
  const code = (new URLSearchParams(hash.slice(q + 1)).get('code') ?? '').trim();
  if (!code || code.length > MAX_CODE_LENGTH || !/^[\w\s-]+$/.test(code)) return null;
  const path = parsed.pathname.replace(/\/index\.html$/, '').replace(/\/+$/, '');
  return { url, hub: `${parsed.origin}${path}`, code };
}

function parseHubUrl(raw: string | null): string | null {
  if (!raw) return null;
  const value = raw.trim();
  let hub: URL;
  try {
    hub = new URL(value);
  } catch {
    return null;
  }
  if (!HUB_PROTOCOLS.has(hub.protocol) || !hub.hostname) return null;
  if (hub.username || hub.password) return null;
  return value;
}

/**
 * Holds the most recent pairing link until the UI takes it, and drops duplicates (on a cold start
 * iOS and Android can report the same URL both as the launch URL and as an `appUrlOpen` event).
 */
export class PairLinkInbox {
  #pending: PairLink | null = null;
  #lastUrl = '';
  #lastAt = Number.NEGATIVE_INFINITY;
  readonly #dedupeMs: number;

  constructor(opts: { dedupeMs?: number } = {}) {
    this.#dedupeMs = opts.dedupeMs ?? 5000;
  }

  /** Offer a URL. Returns the parsed link if it is a new pairing link, else null. */
  offer(url: string, now: number): PairLink | null {
    const link = parsePairLink(url);
    if (!link) return null;
    if (link.url === this.#lastUrl && now - this.#lastAt < this.#dedupeMs) return null;
    this.#lastUrl = link.url;
    this.#lastAt = now;
    this.#pending = link;
    return link;
  }

  /** Mark the pending link as handled (the UI cancelled the `bizzi:pair` event). */
  consume(link: PairLink): void {
    if (this.#pending === link) this.#pending = null;
  }

  /** Return and clear the pending link, if any. */
  take(): PairLink | null {
    const link = this.#pending;
    this.#pending = null;
    return link;
  }
}
