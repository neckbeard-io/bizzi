// Samples are synthetic but modeled on each agent's documented login output (see README).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLoginPrompts, localhostCallbackPort, LoginPromptScanner, loginSpec, stripAnsi } from '../src/index.ts';

const ESC = '\u001b';
const BEL = '\u0007';

const CLAUDE_URL =
  'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code' +
  '&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference' +
  '&code_challenge=Zx3k9Q_abc-DEF&code_challenge_method=S256&state=s7Hq2Lr0';

function wrap(s: string, cols: number): string {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += cols) out.push(s.slice(i, i + cols));
  return out.join('\r\n');
}

test('claude auth login: colored, cursor-moved output with a paste-code prompt', () => {
  const out =
    `${ESC}[2K${ESC}[1G${ESC}[38;5;174m✻${ESC}[39m Opening browser to sign in…\r\n` +
    `${ESC}[2mBrowser didn't open? Use the url below to sign in (c to copy)${ESC}[22m\r\n\r\n` +
    `${ESC}[2m${CLAUDE_URL}${ESC}[22m\r\n\r\n` +
    `${ESC}[?25l Paste code here if prompted > ${ESC}[?25h`;
  const r = detectLoginPrompts(out);
  assert.equal(r.urls.length, 1);
  assert.equal(r.urls[0]?.url, CLAUDE_URL);
  assert.equal(r.urls[0]?.auth, true);
  assert.equal(r.urls[0]?.callbackPort, undefined, 'manual-code redirect is not localhost');
  assert.equal(r.awaitingCodeInput, true);
  assert.deepEqual(r.codes, [], 'code_challenge / state are not one-time codes');
  assert.doesNotMatch(r.text, /\u001b/);
});

test('claude: URL hard-wrapped at the terminal width is rejoined', () => {
  const out = `Browser didn't open? Use the url below to sign in (c to copy)\r\n\r\n${wrap(CLAUDE_URL, 80)}\r\n\r\nPaste code here if prompted > `;
  assert.equal(detectLoginPrompts(out).urls[0]?.url, CLAUDE_URL, 'without cols: heuristic join');
  assert.equal(detectLoginPrompts(out, { cols: 80 }).urls[0]?.url, CLAUDE_URL, 'with cols');
  // Ink box with indentation on continuation lines.
  const boxed = wrap(CLAUDE_URL, 60)
    .split('\r\n')
    .map((l, i) => (i === 0 ? l : `  ${l}`))
    .join('\n');
  assert.equal(detectLoginPrompts(boxed).urls[0]?.url, CLAUDE_URL);
});

test('a wrapped URL does not swallow the following sentence', () => {
  const out = 'Visit https://example.com/device\nThen come back here.\nWaiting';
  const r = detectLoginPrompts(out);
  assert.deepEqual(
    r.urls.map((u) => u.url),
    ['https://example.com/device'],
  );
});

test('codex login: localhost:1455 callback needs forwarding', () => {
  const url =
    'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann' +
    '&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid%20profile%20email%20offline_access' +
    '&code_challenge=q2w3e4&code_challenge_method=S256&id_token_add_organizations=true&state=Abc123';
  const out =
    'Starting local login server on http://localhost:1455.\n' +
    'If your browser did not open, navigate to this URL to authenticate:\n\n' +
    `${url}\n`;
  const r = detectLoginPrompts(out);
  assert.deepEqual(
    r.urls.map((u) => [u.url, u.callbackPort]),
    [
      ['http://localhost:1455', 1455],
      [url, 1455],
    ],
  );
  assert.equal(r.awaitingCodeInput, false);
});

test('codex login --device-auth: link plus one-time code on the next line', () => {
  const out =
    `\nWelcome to Codex [v${ESC}[90m0.167.0${ESC}[0m]\n${ESC}[90mOpenAI's command-line coding agent${ESC}[0m\n\n` +
    'Follow these steps to sign in with ChatGPT using device code authorization:\n\n' +
    `1. Open this link in your browser and sign in to your account\n   ${ESC}[94mhttps://auth.openai.com/codex/device${ESC}[0m\n\n` +
    `2. Enter this one-time code ${ESC}[90m(expires in 15 minutes)${ESC}[0m\n   ${ESC}[94mK7QD-4XWPM${ESC}[0m\n\n` +
    `${ESC}[90mDevice codes are a common phishing target. Never share this code.${ESC}[0m\n`;
  const r = detectLoginPrompts(out);
  assert.deepEqual(
    r.urls.map((u) => u.url),
    ['https://auth.openai.com/codex/device'],
  );
  assert.equal(r.urls[0]?.auth, true);
  assert.deepEqual(
    r.codes.map((c) => c.code),
    ['K7QD-4XWPM'],
  );
  assert.equal(r.codes[0]?.context, 'K7QD-4XWPM');
});

test('opencode auth login (GitHub Copilot): clack UI with device code', () => {
  const out =
    `${ESC}[90m┌${ESC}[39m  Add credential\n│\n${ESC}[32m◇${ESC}[39m  Select provider\n│  GitHub Copilot\n│\n` +
    `${ESC}[32m◇${ESC}[39m  Go to: https://github.com/login/device\n│\n` +
    `${ESC}[32m◇${ESC}[39m  Enter code: 8F3A-B21C\n│\n${ESC}[35m◒${ESC}[39m  Waiting for authorization...`;
  const r = detectLoginPrompts(out);
  assert.deepEqual(
    r.urls.map((u) => u.url),
    ['https://github.com/login/device'],
  );
  assert.deepEqual(
    r.codes.map((c) => c.code),
    ['8F3A-B21C'],
  );
});

test('opencode auth login (Anthropic OAuth): URL then paste the authorization code', () => {
  const out = `◇  Go to: ${CLAUDE_URL}\n│\n◆  Paste the authorization code here:\n│  _\n└`;
  const r = detectLoginPrompts(out);
  assert.equal(r.urls[0]?.url, CLAUDE_URL);
  assert.equal(r.awaitingCodeInput, true);
});

test('agy over SSH: OSC 8 hyperlink with a different label, then code prompt', () => {
  const url =
    'https://accounts.google.com/o/oauth2/v2/auth?client_id=1234-abc.apps.googleusercontent.com' +
    '&redirect_uri=https%3A%2F%2Fantigravity.google%2Fauth%2Fcli&response_type=code&scope=openid%20email&state=xyz';
  const out =
    'Remote session detected. Open this link on a machine with a browser:\n' +
    `${ESC}]8;id=login;${url}${BEL}${ESC}[4mSign in with Google${ESC}[24m${ESC}]8;;${BEL}\n` +
    'Enter the authorization code: ';
  const r = detectLoginPrompts(out);
  assert.equal(r.urls.length, 1);
  assert.deepEqual(
    [r.urls[0]?.url, r.urls[0]?.hyperlink, r.urls[0]?.label, r.urls[0]?.auth],
    [url, true, 'Sign in with Google', true],
  );
  assert.equal(r.awaitingCodeInput, true);
  assert.equal(stripAnsi(out).includes('Sign in with Google'), true);
  assert.equal(stripAnsi(out).includes(']8;'), false);
});

test('OSC 8 with ST terminator and the URL also printed as text is reported once', () => {
  const url = 'https://example.com/login/device?user_code=WXYZ-1234';
  const out = `${ESC}]8;;${url}${ESC}\\${url}${ESC}]8;;${ESC}\\\n`;
  const r = detectLoginPrompts(out);
  assert.equal(r.urls.length, 1);
  assert.equal(r.urls[0]?.hyperlink, true);
  assert.deepEqual(r.codes, [{ code: 'WXYZ-1234', context: url, source: 'url' }]);
});

test('trailing punctuation and brackets are trimmed; carriage-return redraws are handled', () => {
  const r = detectLoginPrompts('Open (https://example.com/auth/start?x=1). Then https://example.com/a_(b).\rspinner ⠋\rspinner ⠙');
  assert.deepEqual(
    r.urls.map((u) => u.url),
    ['https://example.com/auth/start?x=1', 'https://example.com/a_(b)'],
  );
});

test('no false codes from versions, dates or exit codes', () => {
  const r = detectLoginPrompts('claude 2.1.311 (Claude Code)\nexit code: 1\nreleased 2026-11-05\nSee docs code-of-conduct\n');
  assert.deepEqual(r.codes, []);
  assert.deepEqual(r.urls, []);
});

test('localhostCallbackPort', () => {
  assert.equal(localhostCallbackPort('https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback'), 1455);
  assert.equal(localhostCallbackPort('https://accounts.google.com/o/oauth2/auth?redirect_uri=http://127.0.0.1:54321/oauth2callback'), 54321);
  assert.equal(localhostCallbackPort('https://x.example/authorize?redirect_url=http%3A%2F%2F%5B%3A%3A1%5D%3A8085%2Fcb'), 8085);
  assert.equal(localhostCallbackPort('http://localhost:8080/callback?code=abc'), 8080);
  assert.equal(localhostCallbackPort('http://localhost/callback'), 80);
  assert.equal(localhostCallbackPort(CLAUDE_URL), undefined);
  assert.equal(localhostCallbackPort('https://github.com/login/device'), undefined);
  assert.equal(localhostCallbackPort('not a url'), undefined);
  assert.equal(localhostCallbackPort('https://x.example/?redirect_uri=not-a-url'), undefined);
});

test('LoginPromptScanner: URL split across chunks is reported once, complete', () => {
  const s = new LoginPromptScanner({ cols: 80 });
  const half = Math.floor(CLAUDE_URL.length / 2);
  const first = s.push(`Use the url below to sign in\r\n${CLAUDE_URL.slice(0, half)}`);
  assert.deepEqual(first.urls, [], 'incomplete URL at the end of the buffer is held back');
  const second = s.push(`${CLAUDE_URL.slice(half)}\r\n`);
  assert.deepEqual(
    second.urls.map((u) => u.url),
    [CLAUDE_URL],
  );
  const third = s.push('Paste code here if prompted > ');
  assert.deepEqual(third.urls, []);
  assert.equal(third.awaitingCodeInput, true);
  assert.equal(s.push('x').awaitingCodeInput, false, 'reported once');
});

test('loginSpec exposes recipe login options', () => {
  assert.deepEqual(loginSpec('claude')?.interactive.argv, ['claude', 'auth', 'login']);
  assert.equal(loginSpec('codex')?.interactive.callbackPort, 1455);
  assert.ok(loginSpec('codex')?.headless.some((h) => h.kind === 'device-code'));
  assert.ok(loginSpec('agy')?.headless.some((h) => h.kind === 'config' && h.env === 'GEMINI_API_KEY'));
  assert.equal(loginSpec('shell'), undefined);
});
