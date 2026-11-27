import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { BizziError } from '@bizzi/protocol';
import {
  EncryptedFileBackend,
  KeychainSecretBackend,
  LibsecretBackend,
  MemorySecretBackend,
  SecretStore,
  createDefaultSecretBackend,
  securityQuote,
  type CommandRunner,
  type CommandRunResult,
} from '../src/index.ts';
import { capturingLogger, tempDir } from './helpers.ts';

const VALUE = 'sk-test-0123456789abcdef';
const isBad = (code: string) => (e: unknown) => e instanceof BizziError && e.code === code;

/** Records calls; answers from a script. Never runs anything. */
function fakeRunner(answer: (file: string, args: string[], input?: string) => Partial<CommandRunResult>) {
  const calls: { file: string; args: string[]; input?: string }[] = [];
  const run: CommandRunner = async (file, args, opts = {}) => {
    calls.push({ file, args, ...(opts.input !== undefined ? { input: opts.input } : {}) });
    return { code: 0, stdout: '', stderr: '', ...answer(file, args, opts.input) };
  };
  return { run, calls };
}

describe('SecretStore', () => {
  it('sets, lists, injects and deletes secrets without exposing values', async () => {
    const backend = new MemorySecretBackend();
    const log = capturingLogger();
    const dir = tempDir();
    const indexPath = join(dir, 'secrets.json');
    const store = new SecretStore({ backend, indexPath, logger: log, now: () => new Date('2026-11-06T10:00:00Z') });

    const info = await store.set('claude', 'ANTHROPIC_API_KEY', VALUE);
    assert.deepEqual(info, { agent: 'claude', name: 'ANTHROPIC_API_KEY', setAt: '2026-11-06T10:00:00.000Z' });
    await store.set('codex', 'OPENAI_API_KEY', 'other-value');
    assert.equal(backend.values.get('claude:ANTHROPIC_API_KEY'), VALUE);

    assert.deepEqual(
      store.list().map((s) => `${s.agent}:${s.name}`),
      ['claude:ANTHROPIC_API_KEY', 'codex:OPENAI_API_KEY'],
    );
    assert.deepEqual(store.list('codex').map((s) => s.name), ['OPENAI_API_KEY']);
    assert.deepEqual(await store.env('claude'), { ANTHROPIC_API_KEY: VALUE });
    assert.deepEqual(await store.env('agy'), {});

    // The index holds metadata only, with private permissions.
    const index = readFileSync(indexPath, 'utf8');
    assert.ok(!index.includes(VALUE));
    assert.equal(statSync(indexPath).mode & 0o777, 0o600);
    // A new store (node restart) reads the index back.
    const reopened = new SecretStore({ backend, indexPath });
    assert.equal(reopened.list().length, 2);
    assert.deepEqual(await reopened.env('claude'), { ANTHROPIC_API_KEY: VALUE });

    // Overwrite, then delete (idempotent).
    await store.set('claude', 'ANTHROPIC_API_KEY', 'rotated');
    assert.deepEqual(await store.env('claude'), { ANTHROPIC_API_KEY: 'rotated' });
    assert.equal(store.list('claude').length, 1);
    assert.equal(await store.delete('claude', 'ANTHROPIC_API_KEY'), true);
    assert.equal(await store.delete('claude', 'ANTHROPIC_API_KEY'), false);
    assert.deepEqual(await store.env('claude'), {});
    assert.equal(backend.values.has('claude:ANTHROPIC_API_KEY'), false);

    assert.ok(log.lines.length > 0);
    assert.ok(!JSON.stringify(log.lines).includes(VALUE), 'values never reach the log');
    assert.ok(!JSON.stringify(log.lines).includes('rotated'));
  });

  it('validates names and values', async () => {
    const store = new SecretStore({ backend: new MemorySecretBackend() });
    for (const name of ['', '1ABC', 'A-B', 'PATH', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'BIZZI_TOKEN']) {
      await assert.rejects(store.set('claude', name, 'v'), isBad('bad_request'), name);
    }
    await assert.rejects(store.set('claude', 'K', ''), isBad('bad_request'));
    await assert.rejects(store.set('claude', 'K', 'a\nb'), isBad('bad_request'));
    await assert.rejects(store.set('claude', 'K', 'x'.repeat(5000)), isBad('bad_request'));
    // Error messages never echo the value.
    await assert.rejects(store.set('claude', 'K', `secret-in-error\n`), (e: Error) => !e.message.includes('secret-in-error'));
    assert.equal(store.list().length, 0);
  });

  it('skips listed secrets whose value disappeared from the backend', async () => {
    const backend = new MemorySecretBackend();
    const indexPath = join(tempDir(), 'secrets.json');
    const store = new SecretStore({ backend, indexPath });
    await store.set('claude', 'A_KEY', 'a');
    await store.set('claude', 'B_KEY', 'b');
    backend.values.delete('claude:B_KEY'); // e.g. removed in Keychain Access
    const log = capturingLogger();
    const restarted = new SecretStore({ backend, indexPath, logger: log });
    assert.deepEqual(await restarted.env('claude'), { A_KEY: 'a' });
    assert.ok(log.lines.some((l) => l.msg === 'listed secret has no value in the backend'));
  });
});

describe('EncryptedFileBackend', () => {
  it('round-trips values with AES-256-GCM, 0600 files and no plaintext on disk', async () => {
    const dir = join(tempDir(), 'secrets');
    const b = new EncryptedFileBackend(dir);
    assert.equal(await b.get('claude:X'), undefined);
    await b.set('claude:X', VALUE);
    await b.set('codex:Y', 'ünïcødé value');
    assert.equal(await b.get('claude:X'), VALUE);
    assert.equal(await b.get('codex:Y'), 'ünïcødé value');
    assert.equal(statSync(b.keyPath).mode & 0o777, 0o600);
    assert.equal(statSync(b.dataPath).mode & 0o777, 0o600);
    assert.equal(readFileSync(b.keyPath).length, 32);
    const raw = readFileSync(b.dataPath, 'utf8');
    assert.ok(!raw.includes(VALUE) && !raw.includes('value'));

    // A second instance (restart) reads the same key and data.
    assert.equal(await new EncryptedFileBackend(dir).get('claude:X'), VALUE);

    // The account is bound as AAD: moving a ciphertext to another account fails to decrypt.
    const data = JSON.parse(raw);
    data.entries['claude:Z'] = data.entries['claude:X'];
    const { writeFileSync } = await import('node:fs');
    writeFileSync(b.dataPath, JSON.stringify(data));
    await assert.rejects(new EncryptedFileBackend(dir).get('claude:Z'), isBad('internal'));

    assert.equal(await b.delete('claude:X'), true);
    assert.equal(await b.delete('claude:X'), false);
    assert.equal(await b.get('claude:X'), undefined);
  });
});

describe('KeychainSecretBackend (fake runner, no real keychain)', () => {
  it('passes the value on stdin to `security -i`, never on argv', async () => {
    const { run, calls } = fakeRunner(() => ({}));
    const b = new KeychainSecretBackend({ run, securityPath: '/usr/bin/security' });
    const tricky = 'ab"c\\d e$f';
    await b.set('claude:ANTHROPIC_API_KEY', tricky);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.args, ['-i']);
    assert.ok(!calls[0]!.args.join(' ').includes(tricky));
    assert.equal(
      calls[0]!.input,
      `add-generic-password -U -s "bizzi" -a "claude:ANTHROPIC_API_KEY" -l "bizzi claude:ANTHROPIC_API_KEY" -w ${securityQuote(tricky)}\n`,
    );
    assert.equal(securityQuote(tricky), '"ab\\"c\\\\d e$f"');
  });

  it('reads, reports missing items (exit 44) and deletes', async () => {
    const { run, calls } = fakeRunner((_f, args) => {
      if (args[0] === 'find-generic-password') return args.includes('claude:HAVE') ? { stdout: `${VALUE}\n` } : { code: 44 };
      if (args[0] === 'delete-generic-password') return args.includes('claude:HAVE') ? {} : { code: 44 };
      return { code: 1, stderr: 'boom' };
    });
    const b = new KeychainSecretBackend({ run });
    assert.equal(await b.get('claude:HAVE'), VALUE);
    assert.deepEqual(calls[0]!.args, ['find-generic-password', '-s', 'bizzi', '-a', 'claude:HAVE', '-w']);
    assert.equal(await b.get('claude:NONE'), undefined);
    assert.equal(await b.delete('claude:HAVE'), true);
    assert.equal(await b.delete('claude:NONE'), false);
    await assert.rejects(b.set('claude:X', 'v'), (e: BizziError) => e.code === 'internal' && e.message.includes('boom'));
  });

  it('refuses values the line-based `security -i` cannot carry', async () => {
    const { run, calls } = fakeRunner(() => ({}));
    const b = new KeychainSecretBackend({ run });
    await assert.rejects(b.set('claude:X', 'x'.repeat(4000)), isBad('bad_request'));
    await assert.rejects(b.set('claude:X', 'naïve'), isBad('bad_request'));
    assert.equal(calls.length, 0);
  });
});

describe('LibsecretBackend (fake runner)', () => {
  it('stores via stdin and looks values up by service/account attributes', async () => {
    const stored = new Map<string, string>();
    const { run, calls } = fakeRunner((_f, args, input) => {
      const account = args[args.indexOf('account') + 1]!;
      if (args[0] === 'store') {
        stored.set(account, input ?? '');
        return {};
      }
      if (args[0] === 'lookup') return stored.has(account) ? { stdout: stored.get(account)! } : { code: 1 };
      if (args[0] === 'clear') {
        stored.delete(account);
        return {};
      }
      return { code: 2 };
    });
    const b = new LibsecretBackend({ run });
    await b.set('codex:OPENAI_API_KEY', VALUE);
    assert.deepEqual(calls[0]!.args, ['store', '--label', 'bizzi codex:OPENAI_API_KEY', 'service', 'bizzi', 'account', 'codex:OPENAI_API_KEY']);
    assert.equal(calls[0]!.input, VALUE);
    assert.equal(await b.get('codex:OPENAI_API_KEY'), VALUE);
    assert.equal(await b.get('codex:NOPE'), undefined);
    assert.equal(await b.delete('codex:OPENAI_API_KEY'), true);
    assert.equal(await b.delete('codex:OPENAI_API_KEY'), false);
  });

  it('is unavailable when the Secret Service does not answer', async () => {
    const down = fakeRunner(() => ({ code: 1, stderr: 'Cannot autolaunch D-Bus without X11 $DISPLAY' }));
    assert.equal(await LibsecretBackend.available({ run: down.run }), false);
    const up = fakeRunner(() => ({ code: 1 }));
    assert.equal(await LibsecretBackend.available({ run: up.run }), true);
  });
});

describe('createDefaultSecretBackend', () => {
  it('picks keychain on macOS, the encrypted file on headless Linux, and honors an override', async () => {
    const dataDir = tempDir();
    const never: CommandRunner = async () => ({ code: 1, stdout: '', stderr: 'no dbus' });
    const linux = await createDefaultSecretBackend({ dataDir, platform: 'linux', run: never, env: { PATH: '' } });
    assert.equal(linux.name, 'file');
    assert.equal((linux as EncryptedFileBackend).dir, join(dataDir, 'secrets'));
    const forced = await createDefaultSecretBackend({ dataDir, platform: 'darwin', prefer: 'file', env: {} });
    assert.equal(forced.name, 'file');
    const viaEnv = await createDefaultSecretBackend({ dataDir, platform: 'darwin', env: { BIZZI_SECRETS_BACKEND: 'file' } });
    assert.equal(viaEnv.name, 'file');
    if (process.platform === 'darwin') {
      // Constructing it runs nothing; only set/get/delete call `security`.
      const mac = await createDefaultSecretBackend({ dataDir, platform: 'darwin', run: never, env: {} });
      assert.equal(mac.name, 'keychain');
    }
    await assert.rejects(createDefaultSecretBackend({ dataDir, env: { BIZZI_SECRETS_BACKEND: 'vault' } }), isBad('bad_request'));
  });
});

it('secretService: BIZZI_SECRET_SERVICE keeps test builds out of the real secrets', async () => {
  const { secretService, SECRET_SERVICE } = await import('../src/index.ts');
  assert.equal(secretService({}), SECRET_SERVICE);
  assert.equal(secretService({ BIZZI_SECRET_SERVICE: 'bizzi-dev' }), 'bizzi-dev');
});
