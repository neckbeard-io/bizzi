type FromBase64 = (s: string) => Uint8Array;
type ToBase64 = (this: Uint8Array) => string;

const U8 = Uint8Array as unknown as { fromBase64?: FromBase64; prototype: { toBase64?: ToBase64 } };

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof U8.fromBase64 === 'function') return U8.fromBase64(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const native = U8.prototype.toBase64;
  if (typeof native === 'function') return native.call(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

const encoder = new TextEncoder();

export function stringToBase64(s: string): string {
  return bytesToBase64(encoder.encode(s));
}

/** RFC 4648 §5 base64url without padding (JWK members, signatures). */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return base64ToBytes(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}
