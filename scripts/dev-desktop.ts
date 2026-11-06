// `npm run dev:desktop`: run the Electron shell against the built UI (packages/ui/dist) and the real
// core, with the repo-local data dir that `npm run serve` also uses (.bizzi-dev/data). If a
// `npm run serve` is already running there, the desktop attaches to it; otherwise it spawns its own
// core. Set BIZZI_DATA_DIR to use another data dir (e.g. ~/.bizzi). Extra args go to Electron.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const repo = fileURLToPath(new URL('..', import.meta.url));
const env = { ...process.env, BIZZI_DATA_DIR: process.env['BIZZI_DATA_DIR'] || join(repo, '.bizzi-dev', 'data') };
process.stderr.write(`dev:desktop: data dir ${env.BIZZI_DATA_DIR}\n`);

const child = spawn(process.execPath, [join(repo, 'apps', 'desktop', 'scripts', 'dev.ts'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => child.kill(sig));
}
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
