// Short titles from a message (spec §4.1), shared by the node (sessions nobody named) and clients
// (the mock server): the gist of the first line, not the whole of it. Request preambles ("I'd like",
// "can you", "please") go, only the first sentence counts, and asides after a clause ("instead of…",
// "because…", "; …") are cut, then the rest is kept to a few words.

/** Longest automatic title, in characters (a title cut short ends with "…"). */
export const AUTO_TITLE_MAX = 50;

/** Most words in an automatic title. */
export const AUTO_TITLE_WORDS = 8;

const APOS = "['’]";

/** Openings that say nothing about the task, removed from the start (repeatedly). */
const PREAMBLES: readonly RegExp[] = [
  /^(?:hi|hey|hello|ok(?:ay)?|so|alright|um+|uh+|also|and|now|then|thanks|thank you)\b[,.!:;]*\s+/i,
  /^please\s+/i,
  /^(?:can|could|would|will) (?:you|we|u)(?: please)?\s+/i,
  new RegExp(`^(?:i${APOS}?d|i would|we${APOS}?d|we would) (?:like|love|want)(?: (?:you|us|it|for you))?(?: to)?\\s+`, 'i'),
  /^(?:i|we) (?:want|need|wanna)(?: (?:you|us))?(?: to)?\s+/i,
  new RegExp(`^(?:i${APOS}m|we${APOS}re|i am|we are) (?:trying|looking|hoping|wanting) to\\s+`, 'i'),
  new RegExp(`^let${APOS}?s\\s+`, 'i'),
  /^help me(?: to)?\s+/i,
  /^go ahead and\s+/i,
  /^(?:i think )?(?:we|you) (?:should|need to|have to|must)\s+/i,
  /^is (?:it possible|there a way) to\s+/i,
  /^how (?:do|can|could|would|should) (?:i|we|you)\s+/i,
];

/** Where an aside starts: the title ends before it, if at least `min` words come first. */
const CLAUSES: readonly { re: RegExp; min: number }[] = [
  { re: /\s+(?:instead of|rather than|because|since|so that|so (?:we|i|it|you|they)|but|which|and then|in order to|e\.g\.|i\.e\.|for example|for instance|such as)\s/i, min: 2 },
  { re: /\s*[;:]\s+/, min: 2 },
  { re: /\s+[-–—]+\s+/, min: 2 },
  { re: /\s*\(/, min: 2 },
  { re: /,\s+/, min: 3 },
];

/** Words a cut title shouldn't end on. */
const DANGLING = new Set(
  'a an the of for to and or with in on at by from into about that this these those my our your its is are be was were where when which who if so but just really also very'.split(' '),
);

/** Abbreviations whose period doesn't end a sentence. */
const ABBREV = /\b(?:e\.g|i\.e|etc|vs|cf|approx|incl|v\d+(?:\.\d+)*)$/i;

/**
 * A short title from a message: the first line with words in it (markdown markers stripped), cut to
 * its gist. Undefined when no line has letters or digits in it.
 */
export function titleFromText(text: string): string | undefined {
  for (const raw of text.split('\n')) {
    const line = raw
      .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, '')
      .replace(/`{3,}.*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!hasWords(line)) continue;
    const gist = gistOf(line);
    return hasWords(gist) ? gist : clipTitle(line, AUTO_TITLE_MAX);
  }
  return undefined;
}

/** Cut at a word boundary to `max` characters, ending with "…" when cut. */
export function clipTitle(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return (space >= max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, '') + '…';
}

function gistOf(line: string): string {
  let s = line;
  const stripped = stripPreambles(s);
  let asked = stripped !== s;
  s = firstSentence(stripped);
  const again = stripPreambles(s);
  if (again !== s) asked = true;
  s = again;
  let cut = false;
  for (const { re, min } of CLAUSES) {
    const m = re.exec(s);
    if (m && wordCount(s.slice(0, m.index)) >= min) {
      s = s.slice(0, m.index);
      cut = true;
    }
  }
  let words = s.split(' ').filter(Boolean);
  const long = words.length > AUTO_TITLE_WORDS;
  if (long) words = words.slice(0, AUTO_TITLE_WORDS);
  if (long || cut) {
    while (words.length > 1 && DANGLING.has(bare(words[words.length - 1]!))) words.pop();
  }
  s = words.join(' ').replace(asked ? /[\s,;:.!?\-–—]+$/ : /[\s,;:.!\-–—]+$/, '');
  return clipTitle(long ? `${s}…` : s, AUTO_TITLE_MAX);
}

function stripPreambles(s: string): string {
  for (let changed = true; changed; ) {
    changed = false;
    for (const re of PREAMBLES) {
      const next = s.replace(re, '');
      if (next !== s && hasWords(next)) {
        s = next;
        changed = true;
      }
    }
  }
  return s;
}

/** Up to the first sentence end ("." "!" "?" before a space or the end), abbreviations aside. */
function firstSentence(s: string): string {
  const re = /[.!?]+(?=\s|$)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const before = s.slice(0, m.index);
    if (m[0] === '.' && ABBREV.test(before)) continue;
    if (!hasWords(before)) continue;
    return s.slice(0, m.index + m[0].length);
  }
  return s;
}

function bare(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}'’]/gu, '');
}

function wordCount(s: string): number {
  return s.split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

function hasWords(s: string): boolean {
  return /[\p{L}\p{N}]/u.test(s);
}
