// Simulates a bizzi node: starts a supervised terminal session, prints its ref once the first
// output has been delivered, then waits to be killed (SIGKILL, no cleanup).
// Usage: node supervised-child.ts <runtimeDir> <bash script>

import { TerminalAdapter, shellSpec } from '../../src/index.ts';
import { EventLog, ctx, startOpts } from '../helpers.ts';

const [runtimeDir, script] = process.argv.slice(2) as [string, string];
const adapter = new TerminalAdapter(shellSpec({ command: 'bash', args: ['--norc', '--noprofile', '-c', script] }), {
  supervisor: { runtimeDir },
});
const log = new EventLog();
const session = await adapter.start(startOpts(), log.emit, ctx);
await log.waitForOutput('hi');
process.stdout.write(JSON.stringify({ ref: session.agentSessionRef(), output: log.output() }) + '\n');
setInterval(() => {}, 1000);
