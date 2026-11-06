// Stand-in for `bizzi serve` implementing just the CLI <-> desktop contract:
//   stub-core.ts serve --host 127.0.0.1 --port 0 --data-dir <dir>
// prints one ServeReady JSON line on stdout, writes <dir>/serve.json (removed on exit), answers
// GET /healthz, logs to stderr, and exits 0 on SIGTERM.
//
// Knobs (env): STUB_READY_DELAY_MS, STUB_CRASH_AFTER_MS (exit 1 without cleanup, like a crash),
// STUB_NO_READY=1 (never print the ready line), STUB_NOISE=1 (a junk stdout line first),
// STUB_DRAIN_MS (delay between SIGTERM and exit).

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '0' },
    'data-dir': { type: 'string' },
  },
});
if (positionals[0] !== 'serve' || !values['data-dir']) {
  process.stderr.write('usage: stub-core.ts serve --host H --port P --data-dir DIR\n');
  process.exit(2);
}
const dataDir = values['data-dir'];
const serveFile = join(dataDir, 'serve.json');
const env = (k: string) => Number(process.env[k] ?? 0);
const log = (msg: string, fields: Record<string, unknown> = {}) =>
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg, proc: 'stub-core', pid: process.pid, ...fields }) + '\n');

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    // CORS: the desktop renderer's origin is app://bizzi (or the Vite dev origin).
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end('{"ok":true}');
    return;
  }
  res.writeHead(404).end();
});

server.listen(Number(values.port), values.host, () => {
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  const ready = {
    event: 'ready',
    url: `ws://${values.host}:${addr.port}/ws`,
    token: randomBytes(16).toString('hex'),
    machineId: 'stub-machine',
    pid: process.pid,
  };
  setTimeout(() => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(serveFile, JSON.stringify(ready) + '\n');
    if (process.env['STUB_NOISE']) process.stdout.write('stub: warming up\n');
    if (!process.env['STUB_NO_READY']) process.stdout.write(JSON.stringify(ready) + '\n');
    log('listening', { url: ready.url });
  }, env('STUB_READY_DELAY_MS'));

  if (env('STUB_CRASH_AFTER_MS')) {
    setTimeout(() => {
      log('crashing on purpose');
      process.exit(1);
    }, env('STUB_CRASH_AFTER_MS'));
  }
});

process.on('SIGTERM', () => {
  log('SIGTERM: draining');
  setTimeout(() => {
    rmSync(serveFile, { force: true });
    server.close();
    log('stopped');
    process.exit(0);
  }, env('STUB_DRAIN_MS'));
});
