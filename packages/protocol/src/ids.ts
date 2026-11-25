// ULID-style identifiers: 48-bit millisecond timestamp + 80 random bits, Crockford base32.
// Sortable by creation time and safe to generate offline on any machine.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type IdPrefix =
  | 'm' // machine
  | 'w' // workspace
  | 'p' // project
  | 's' // session
  | 't' // turn
  | 'msg' // message
  | 'tc' // tool call
  | 'ap' // approval
  | 'q' // question
  | 'd' // device
  | 'k' // knowledge item
  | 'pl' // pipeline
  | 'r'; // request

export function ulid(now: number = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let rand = '';
  for (const b of bytes) rand += ALPHABET[b % 32];
  return time + rand;
}

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}
