import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PairLinkInbox, parsePairLink } from '../src/bridge/deeplink.ts';

const HUB = 'https://bizzi.example.com';
const link = (q: string): string => `bizzi://pair?${q}`;

test('parses the canonical pairing link', () => {
  const url = link(`hub=${encodeURIComponent(HUB)}&code=AB12-CD34`);
  assert.deepEqual(parsePairLink(url), { url, hub: HUB, code: 'AB12-CD34' });
});

test('accepts unencoded hub URLs, ws(s) and http hubs with ports and paths', () => {
  assert.equal(parsePairLink(link('hub=https://h.example:8443/bizzi&code=X1'))?.hub, 'https://h.example:8443/bizzi');
  assert.equal(parsePairLink(link(`hub=${encodeURIComponent('wss://h.example/ws')}&code=X1`))?.hub, 'wss://h.example/ws');
  assert.equal(parsePairLink(link(`hub=${encodeURIComponent('http://192.168.1.20:7777')}&code=X1`))?.hub, 'http://192.168.1.20:7777');
});

test('accepts alternative spellings of the route and scheme case', () => {
  const q = `hub=${encodeURIComponent(HUB)}&code=K`;
  for (const url of [`bizzi:///pair?${q}`, `bizzi:pair?${q}`, `bizzi://pair/?${q}`, `BIZZI://PAIR?${q}`]) {
    assert.equal(parsePairLink(url)?.code, 'K', url);
  }
});

test('trims whitespace around the link and the code', () => {
  const r = parsePairLink(`  ${link(`hub=${encodeURIComponent(HUB)}&code=%20ab12%20`)}\n`);
  assert.equal(r?.code, 'ab12');
});

test('rejects other schemes, routes and malformed input', () => {
  const q = `hub=${encodeURIComponent(HUB)}&code=K`;
  for (const url of [
    '',
    'not a url',
    `https://bizzi.example.com/pair?${q}`,
    `bizzi://session?${q}`,
    `bizzi://pair/extra?${q}`,
    `otherapp://pair?${q}`,
  ]) {
    assert.equal(parsePairLink(url), null, url);
  }
  assert.equal(parsePairLink(undefined as unknown as string), null);
});

test('rejects missing or unsafe hub URLs', () => {
  for (const hub of ['', 'bizzi.example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'ftp://h.example', 'https://user:pw@h.example']) {
    assert.equal(parsePairLink(link(`hub=${encodeURIComponent(hub)}&code=K`)), null, hub);
  }
  assert.equal(parsePairLink(link('code=K')), null);
});

test('rejects missing, oversized or odd codes', () => {
  const h = `hub=${encodeURIComponent(HUB)}`;
  assert.equal(parsePairLink(link(h)), null);
  assert.equal(parsePairLink(link(`${h}&code=`)), null);
  assert.equal(parsePairLink(link(`${h}&code=${'A'.repeat(129)}`)), null);
  assert.equal(parsePairLink(link(`${h}&code=${encodeURIComponent('<script>')}`)), null);
  assert.equal(parsePairLink(`bizzi://pair?${h}&code=${'A'.repeat(5000)}`), null);
});

test('inbox: keeps the latest link until taken', () => {
  const inbox = new PairLinkInbox();
  assert.equal(inbox.take(), null);
  const a = inbox.offer(link(`hub=${encodeURIComponent(HUB)}&code=A`), 0);
  assert.equal(a?.code, 'A');
  assert.equal(inbox.offer('https://not-a-pair-link', 1), null);
  assert.equal(inbox.take(), a);
  assert.equal(inbox.take(), null);
});

test('inbox: drops the same URL reported twice in quick succession (cold start)', () => {
  const inbox = new PairLinkInbox({ dedupeMs: 1000 });
  const url = link(`hub=${encodeURIComponent(HUB)}&code=A`);
  assert.ok(inbox.offer(url, 0));
  assert.equal(inbox.offer(url, 500), null);
  assert.ok(inbox.offer(url, 2000), 'the same link later counts again');
  assert.ok(inbox.offer(link(`hub=${encodeURIComponent(HUB)}&code=B`), 2001), 'a different link is never deduped');
});

test('inbox: consume clears only the link that was handled', () => {
  const inbox = new PairLinkInbox();
  const a = inbox.offer(link(`hub=${encodeURIComponent(HUB)}&code=A`), 0)!;
  const b = inbox.offer(link(`hub=${encodeURIComponent(HUB)}&code=B`), 1)!;
  inbox.consume(a);
  assert.equal(inbox.take(), b);
  inbox.offer(link(`hub=${encodeURIComponent(HUB)}&code=C`), 2);
  const c = inbox.take();
  assert.equal(c?.code, 'C');
  inbox.consume(c!);
  assert.equal(inbox.take(), null);
});
