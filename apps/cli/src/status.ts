// `bizzi status`: connect to a running node and print machine, workspaces and sessions.

import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { MachineInfo, SessionInfo, WorkspaceInfo } from '@bizzi/protocol';
import { ProtocolClient } from './client.ts';
import { readReady } from './serve.ts';
import { defaultDataDir, resolveDir, UsageError } from './util.ts';

export const STATUS_HELP = `Usage: bizzi status [options]

  --url <ws-url>     node URL (default: from <data-dir>/serve.json)
  --token <token>    client token (default: $BIZZI_TOKEN or serve.json)
  --data-dir <dir>   data directory holding serve.json (default ~/.bizzi)
  --json             print JSON instead of text`;

export interface StatusReport {
  machine: MachineInfo;
  workspaces: WorkspaceInfo[];
  sessions: SessionInfo[];
}

export async function status(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string' },
      token: { type: 'string' },
      'data-dir': { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(STATUS_HELP + '\n');
    return;
  }
  let url = values.url || undefined;
  let token = values.token || process.env.BIZZI_TOKEN || undefined;
  if (!url || !token) {
    const file = join(resolveDir(values['data-dir'] ?? defaultDataDir()), 'serve.json');
    const ready = readReady(file);
    if (!ready) throw new UsageError(`no running node found (${file} missing); pass --url and --token`);
    url ??= ready.url;
    token ??= ready.token;
  }

  const client = await ProtocolClient.connect(url, token).catch((err: unknown) => {
    throw new UsageError(`cannot connect to ${url}: ${(err as Error).message}`);
  });
  try {
    const [machines, workspaces, sessions] = await Promise.all([
      client.call('machines.list', {}),
      client.call('workspaces.list', {}),
      client.call('sessions.list', {}),
    ]);
    const report: StatusReport = {
      machine: machines.machines[0]!,
      workspaces: workspaces.workspaces,
      sessions: sessions.sessions,
    };
    process.stdout.write(values.json ? JSON.stringify(report, null, 2) + '\n' : formatStatus(report, url));
  } finally {
    client.close();
  }
}

export function formatStatus(r: StatusReport, url: string): string {
  const m = r.machine;
  const lines = [
    `machine  ${m.name} (${m.id})`,
    `         ${m.os}/${m.arch} host=${m.hostname} headful=${m.headful} bizzi=${m.bizziVersion}`,
    `         ${url}`,
  ];
  const k = m.keepAwake;
  if (k) {
    const setting = `${k.settings.mode}${k.settings.mode === 'off' ? '' : k.settings.onBattery ? ', also on battery' : ', on power adapter only'}`;
    const now = !k.supported
      ? 'unavailable on this OS'
      : k.active
        ? `holding (turns=${k.turns} background=${k.background}${k.lingerUntil ? `, lingering until ${k.lingerUntil}` : ''})`
        : k.pausedOnBattery
          ? 'paused on battery'
          : 'not holding';
    lines.push(`         keep awake: ${setting}; ${now}`);
  }
  lines.push('', `workspaces (${r.workspaces.length})`);
  for (const w of r.workspaces) lines.push(`  ${w.id}  ${w.name.padEnd(20)} ${w.kind.padEnd(4)} ${w.path}`);
  lines.push('', `sessions (${r.sessions.length})`);
  const wsName = new Map(r.workspaces.map((w) => [w.id, w.name]));
  for (const s of r.sessions) {
    const title = s.title ? `  "${s.title}"` : '';
    lines.push(
      `  ${s.id}  ${s.status.padEnd(16)} ${s.agent}/${s.mode.padEnd(10)} ${wsName.get(s.workspaceId) ?? s.workspaceId}${title}`,
    );
  }
  return lines.join('\n') + '\n';
}
