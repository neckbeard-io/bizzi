#!/usr/bin/env node
// `bizzi` command-line entry point.

import { readFileSync } from 'node:fs';
import { hub, HUB_HELP } from './hub.ts';
import { pair, PAIR_HELP } from './pair.ts';
import { serve, SERVE_HELP } from './serve.ts';
import { status, STATUS_HELP } from './status.ts';
import { trustSystemCertificates } from './tls.ts';
import { UsageError } from './util.ts';

const HELP = `Usage: bizzi <command> [options]

Commands:
  serve    run the node (sessions, workspaces, client-protocol server)
  status   show a running node's machine, workspaces and sessions
  pair     pair this machine's node with a hub
  hub      run a hub (bizzi hub serve) or mint pairing codes (bizzi hub code)
  version  print the bizzi version

Run "bizzi <command> --help" for command options.`;

export function cliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(argv: string[]): Promise<void> {
  trustSystemCertificates();
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'serve':
      return serve(rest, cliVersion());
    case 'status':
      return status(rest);
    case 'pair':
      return pair(rest);
    case 'hub':
      return hub(rest, cliVersion());
    case 'version':
    case '--version':
    case '-v':
      process.stdout.write(cliVersion() + '\n');
      return;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(`${HELP}\n\n${SERVE_HELP}\n\n${STATUS_HELP}\n\n${PAIR_HELP}\n\n${HUB_HELP}\n`);
      return;
    default:
      throw new UsageError(`unknown command: ${cmd}\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  const usage = err instanceof UsageError || (err as NodeJS.ErrnoException)?.code?.startsWith?.('ERR_PARSE_ARGS');
  process.stderr.write(`bizzi: ${usage ? (err as Error).message : ((err as Error)?.stack ?? String(err))}\n`);
  process.exit(usage ? 2 : 1);
});
