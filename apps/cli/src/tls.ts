// Trust the OS certificate store for outgoing TLS (hub links, widgets, model gateways).
//
// Node verifies against its bundled Mozilla roots plus NODE_EXTRA_CA_CERTS. Private CAs pushed
// by IT (macOS keychain, Windows store, /etc/ssl/certs after update-ca-certificates) aren't in
// that bundle, so a hub or gateway behind a company CA fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY,
// even though browsers and curl trust it. A Homebrew Node often works only because Homebrew's
// ca-certificates package copies the keychain into its bundle; a packaged or Electron Node doesn't.
//
// BIZZI_SYSTEM_CA=0 turns this off.

import { getCACertificates, setDefaultCACertificates } from 'node:tls';

export interface SystemCaResult {
  /** System certificates added to the default store (0 when off or already present). */
  added: number;
  skipped?: 'disabled' | 'unavailable';
}

export function trustSystemCertificates(env: NodeJS.ProcessEnv = process.env): SystemCaResult {
  if (env['BIZZI_SYSTEM_CA'] === '0') return { added: 0, skipped: 'disabled' };
  let current: string[];
  let system: string[];
  try {
    current = getCACertificates('default');
    system = getCACertificates('system');
  } catch {
    return { added: 0, skipped: 'unavailable' };
  }
  const have = new Set(current.map(normalize));
  const extra = system.filter((pem) => !have.has(normalize(pem)));
  if (extra.length) setDefaultCACertificates([...current, ...extra]);
  return { added: extra.length };
}

function normalize(pem: string): string {
  return pem.replace(/\s+/g, '');
}
