import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCACertificates } from 'node:tls';
import { trustSystemCertificates } from '../src/tls.ts';

test('BIZZI_SYSTEM_CA=0 leaves the default store alone', () => {
  const before = getCACertificates('default').length;
  assert.deepEqual(trustSystemCertificates({ BIZZI_SYSTEM_CA: '0' }), { added: 0, skipped: 'disabled' });
  assert.equal(getCACertificates('default').length, before);
});

test('system certificates end up in the default store, once', () => {
  const first = trustSystemCertificates({});
  const after = getCACertificates('default').map((p) => p.replace(/\s+/g, ''));
  for (const pem of getCACertificates('system')) assert.ok(after.includes(pem.replace(/\s+/g, '')));
  assert.equal(trustSystemCertificates({}).added, 0, `second call adds nothing (first added ${first.added})`);
});
