import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BizziError } from '@bizzi/protocol';
import type { QuestionItem } from '@bizzi/protocol';
import type { HubCredentials } from '@bizzi/client';
import { defaultDeviceName, defaultHubUrl, hubTarget, resolveInitialTarget } from '../src/lib/connection.ts';
import { errorInfo, formatCountdown, machinePresence } from '../src/lib/format.ts';
import { formatPairingCode, qrMatrix, qrPath } from '../src/lib/qr.ts';
import { EMPTY_DRAFT, answerText, buildAnswers, isQuickPick, missingAnswers, setText, toggleOption } from '../src/lib/questions.ts';
import { pairCodeFromLocation, parseHash, routeHref } from '../src/lib/router.ts';
import type { Route } from '../src/lib/router.ts';

const SPECS: QuestionItem[] = [
  { id: 'provider', text: 'Which IdP?', options: [{ label: 'Auth0' }, { label: 'Keycloak' }] },
  { id: 'flows', text: 'Which flows?', multiSelect: true, allowText: true, options: [{ label: 'Web' }, { label: 'API' }] },
  { id: 'notes', text: 'Anything else?', allowText: true },
];

test('question drafts: single select replaces, multi select toggles, free text, required answers', () => {
  let d = EMPTY_DRAFT;
  assert.deepEqual(missingAnswers(SPECS, d), ['provider', 'flows']);
  d = toggleOption(d, SPECS[0] as QuestionItem, 'Auth0');
  d = toggleOption(d, SPECS[0] as QuestionItem, 'Keycloak');
  assert.deepEqual(d.selected.provider, ['Keycloak']);
  d = toggleOption(d, SPECS[1] as QuestionItem, 'Web');
  d = toggleOption(d, SPECS[1] as QuestionItem, 'API');
  d = toggleOption(d, SPECS[1] as QuestionItem, 'Web');
  d = setText(d, 'flows', ' Admin SSO ');
  assert.deepEqual(missingAnswers(SPECS, d), []);
  assert.deepEqual(buildAnswers(SPECS, d), { provider: 'Keycloak', flows: ['API', 'Admin SSO'] });
  d = setText(d, 'notes', 'log everyone out');
  assert.equal(buildAnswers(SPECS, d).notes, 'log everyone out');
  // Clicking the selected single option again clears it.
  d = toggleOption(d, SPECS[0] as QuestionItem, 'Keycloak');
  assert.deepEqual(missingAnswers(SPECS, d), ['provider']);
  // Free text answers a single-select question when no option is picked.
  d = setText(d, 'provider', 'Okta');
  assert.equal(buildAnswers(SPECS, d).provider, 'Okta');
  assert.equal(answerText(['a', 'b']), 'a, b');
  assert.equal(answerText(undefined), '');
});

test('quick pick: one single-select question without free text submits on click', () => {
  assert.equal(isQuickPick([SPECS[0] as QuestionItem]), true);
  assert.equal(isQuickPick(SPECS), false);
  assert.equal(isQuickPick([SPECS[1] as QuestionItem]), false);
  assert.equal(isQuickPick([{ id: 'x', text: 'y', allowText: true, options: [{ label: 'a' }] }]), false);
});

test('QR: matrix has finder patterns and a quiet zone; the path covers exactly the dark modules', () => {
  const m = qrMatrix('https://hub.example.com/#/pair?code=K7Q2M9XD');
  assert.equal(m.length, m[0]?.length);
  assert.ok(m.length >= 25);
  assert.equal(m[0]?.some(Boolean), false, 'quiet zone row');
  assert.equal(m[2]?.[2], true, 'top-left finder corner');
  const dark = m.flat().filter(Boolean).length;
  const path = qrPath(m);
  let area = 0;
  for (const run of path.matchAll(/h(\d+)v1/g)) area += Number(run[1]);
  assert.equal(area, dark);
  assert.equal(qrPath([[false, true, true, false]]), 'M1 0h2v1h-2z');
  assert.equal(formatPairingCode('k7q2m9xd'), 'K7Q2-M9XD');
  assert.equal(formatPairingCode('AB12-CD34'), 'AB12-CD34');
  assert.equal(formatCountdown(125_000), '2:05');
});

test('routes round-trip, including v1.1 screens', () => {
  const routes: Route[] = [
    { name: 'machines' },
    { name: 'machine' },
    { name: 'machine', machineId: 'm_server' },
    { name: 'login', sessionId: 's_login' },
    { name: 'knowledge' },
    { name: 'settings', section: 'general' },
    { name: 'settings', section: 'devices' },
    { name: 'settings', section: 'knowledge' },
  ];
  for (const r of routes) assert.deepEqual(parseHash(routeHref(r)), r);
  assert.deepEqual(parseHash('#/settings/bogus'), { name: 'settings', section: 'general' });
});

test('pairing links the app is opened with', () => {
  assert.equal(pairCodeFromLocation({ search: '', hash: '#/pair?code=K7Q2M9XD' }), 'K7Q2M9XD');
  assert.equal(pairCodeFromLocation({ search: '', hash: '#/pair/AB12CD34' }), 'AB12CD34');
  assert.equal(pairCodeFromLocation({ search: '?pair=XY99', hash: '' }), 'XY99');
  assert.equal(pairCodeFromLocation({ search: '', hash: '#/workspaces' }), null);
});

const HUB: HubCredentials = { hubUrl: 'https://hub.example.com', deviceId: 'd_1', keyId: 'https://hub.example.com#k', clientUrl: 'wss://hub.example.com/ws', name: 'phone', owner: false, pairedAt: 'x' };

test('startup target: mock, remembered hub vs local desktop node, manual node', () => {
  const bridge = { connection: { url: 'ws://127.0.0.1:7777/ws', token: 't' } };
  assert.deepEqual(resolveInitialTarget({ search: '?mock=1&demo=install,login' }), { url: 'mock://local', source: 'mock', mock: { role: 'hub', demo: ['install', 'login'] } });
  assert.equal(resolveInitialTarget({ search: '?mock=node' })?.mock?.role, 'node');
  // Desktop app: local by default, the hub when that was the last choice.
  assert.equal(resolveInitialTarget({ search: '', bridge, savedHub: HUB })?.source, 'electron');
  assert.deepEqual(resolveInitialTarget({ search: '', bridge, savedHub: HUB, mode: 'hub' }), { url: 'wss://hub.example.com/ws', source: 'hub', hub: HUB });
  // Browser / phone: a remembered hub pairing.
  assert.equal(resolveInitialTarget({ search: '', savedHub: HUB })?.source, 'hub');
  assert.equal(resolveInitialTarget({ search: '', savedHub: HUB, savedManual: { url: 'ws://x/ws' }, mode: 'manual' })?.source, 'saved');
  assert.equal(resolveInitialTarget({ search: '' }), null);
  assert.equal(hubTarget({ ...HUB, hubUrl: 'mock://hub', clientUrl: 'mock://hub/ws' }).mock?.role, 'hub');
});

test('connection helpers: hub URL suggestion and device names', () => {
  assert.equal(defaultHubUrl({ protocol: 'https:', host: 'bizzi.example.com', pathname: '/' }), 'https://bizzi.example.com');
  assert.equal(defaultHubUrl({ protocol: 'https:', host: 'example.com', pathname: '/bizzi/index.html' }), 'https://example.com/bizzi');
  assert.equal(defaultHubUrl({ protocol: 'file:', host: '', pathname: '/x/index.html' }), '');
  assert.equal(defaultHubUrl({ protocol: 'http:', host: 'localhost:5173', pathname: '/' }), '');
  assert.equal(defaultDeviceName('', 'ios'), 'iPhone');
  assert.equal(defaultDeviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_1) AppleWebKit/605.1.15 Version/18.1 Safari/605.1.15'), 'Safari on macOS');
  assert.equal(defaultDeviceName('Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36'), 'Chrome on Linux');
  assert.equal(defaultDeviceName('Mozilla/5.0 (Macintosh) Chrome/140 Electron/39.0 Safari/537.36'), 'bizzi desktop on macOS');
});

test('errors and presence', () => {
  assert.deepEqual(errorInfo(new BizziError('machine_offline', 'server-a is offline')), { message: 'server-a is offline', code: 'machine_offline', offline: true });
  assert.equal(errorInfo(new Error('boom')).offline, false);
  assert.equal(errorInfo('plain').message, 'plain');
  const now = Date.parse('2026-11-06T12:00:00Z');
  assert.equal(machinePresence({ online: true }, now), 'online');
  assert.equal(machinePresence({ online: false, lastSeenAt: '2026-11-06T09:30:00Z' }, now), 'last seen 2 h ago');
  assert.equal(machinePresence({ online: false }, now), 'offline');
});
