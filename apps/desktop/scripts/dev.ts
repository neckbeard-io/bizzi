// `npm run dev -w @bizzi/desktop`: bundle main/preload, then launch Electron on this package.
// Env passes through: BIZZI_UI_URL (Vite dev server), BIZZI_NODE, BIZZI_DATA_DIR, BIZZI_CORE_ENTRY, ...

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildDesktop } from './build.ts';

const appDir = fileURLToPath(new URL('..', import.meta.url));
await buildDesktop();

// The `electron` package's main export is the path of the downloaded binary.
const electronPath = createRequire(import.meta.url)('electron') as string;
const child = spawn(electronPath, [appDir, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => child.kill(sig));
}
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
