// `bizzi pair <hub-url> <code>`: pair this machine's node with a hub and save <data-dir>/hub-credential.json.

import { mkdirSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { loadCredential, pairWithHub, saveCredential, type HubCredential } from '@bizzi/hub';
import { newId } from '@bizzi/protocol';
import { defaultDataDir, resolveDir, UsageError } from './util.ts';

export const PAIR_HELP = `Usage: bizzi pair <hub-url> <code> [options]

  <hub-url>          the hub, e.g. https://bizzi.example.com or ws://hub:7777/ws/node
  <code>             one-time node pairing code (from a paired device, or "bizzi hub code" on the hub)
  --data-dir <dir>   node data directory (default ~/.bizzi)
  --name <name>      machine name shown on the hub (default: $BIZZI_MACHINE_NAME or hostname)
  --force            replace an existing hub credential

Then run "bizzi serve" (it connects with the saved credential) or "bizzi serve --connect <url>".`;

/**
 * The node's machine id, created exactly as the core does (meta.machineId in node.db, `newId('m')`) if this
 * data dir has never run a node. Safe while a node is running (SQLite WAL + busy timeout).
 */
export function readOrCreateMachineId(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'node.db'));
  try {
    db.exec('PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('machineId', ?)").run(newId('m'));
    const row = db.prepare("SELECT value FROM meta WHERE key = 'machineId'").get() as { value: string };
    return row.value;
  } finally {
    db.close();
  }
}

export async function pairNode(o: { dataDir: string; hubUrl: string; code: string; name: string; machineId: string }): Promise<{ credential: HubCredential; file: string }> {
  const { credential } = await pairWithHub({ hubUrl: o.hubUrl, code: o.code, kind: 'node', name: o.name, machineId: o.machineId });
  const file = saveCredential(o.dataDir, credential);
  return { credential, file };
}

export async function pair(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      'data-dir': { type: 'string' },
      name: { type: 'string' },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
    strict: true,
  });
  if (values.help) {
    process.stdout.write(PAIR_HELP + '\n');
    return;
  }
  const [hubUrl, code] = positionals;
  if (!hubUrl || !code || positionals.length > 2) throw new UsageError(PAIR_HELP);
  const dataDir = resolveDir(values['data-dir'] ?? defaultDataDir());
  const existing = loadCredential(dataDir);
  if (existing && !values.force) {
    throw new UsageError(`already paired with ${existing.hubUrl} as ${existing.deviceId}; use --force to replace the credential`);
  }
  const machineId = readOrCreateMachineId(dataDir);
  const name = values.name?.trim() || process.env.BIZZI_MACHINE_NAME || os.hostname();
  const { credential, file } = await pairNode({ dataDir, hubUrl, code, name, machineId }).catch((err: unknown) => {
    throw new UsageError(`pairing failed: ${(err as Error).message}`);
  });
  process.stdout.write(
    `paired machine ${machineId} ("${name}") as ${credential.deviceId}\n` +
      `credential saved to ${file}\n` +
      `node link: ${credential.hubUrl}\n` +
      `next: bizzi serve   (or: bizzi serve --connect ${credential.hubUrl})\n`,
  );
}
