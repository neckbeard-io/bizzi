// Detached PTY supervisor: `node supervisor.ts <spec.json>`.
//
// Owns one PTY child and keeps it (and its scrollback) alive across restarts of the bizzi node.
// Listens on `<runtimeDir>/<id>.sock`; one client at a time (a new attach replaces the old one).
// On attach it sends `hello`, replays the scrollback ring, then streams live output. After the
// child exits it lingers until a client has collected the exit status (or `lingerMs` passes),
// then removes its socket. Never writes to stdout/stderr after printing "ready".

import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { LocalPtyBackend, type ExitInfo } from './backend.ts';
import { ScrollbackBuffer } from './ring-buffer.ts';
import {
  lineParser,
  metaPath,
  sendMessage,
  socketPath,
  type ClientMessage,
  type SupervisorMeta,
  type SupervisorSpec,
} from './supervisor-protocol.ts';

const REPLAY_CHUNK = 32 * 1024;

function main(): void {
  // The parent closes our stdout/stderr pipes after "ready"; never crash on EPIPE.
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});

  const specFile = process.argv[2];
  if (!specFile) {
    process.stderr.write('usage: supervisor.ts <spec.json>\n');
    process.exit(2);
  }
  const spec = JSON.parse(readFileSync(specFile, 'utf8')) as SupervisorSpec;
  rmSync(specFile, { force: true });

  const dir = dirname(specFile);
  const sock = socketPath(dir, spec.id);
  const metaFile = metaPath(dir, spec.id);

  const scrollback = new ScrollbackBuffer(spec.scrollbackBytes);
  let acked = 0;
  let cols = spec.cols;
  let rows = spec.rows;
  let exit: ExitInfo | undefined;
  let client: Socket | undefined;
  let clientLive = false;
  let exitDelivered = false;
  let killTimer: NodeJS.Timeout | undefined;
  let lingerTimer: NodeJS.Timeout | undefined;
  let orphanTimer: NodeJS.Timeout | undefined;

  const pty = new LocalPtyBackend({
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    env: spec.env,
    cols,
    rows,
  });

  const meta: SupervisorMeta = {
    id: spec.id,
    supervisorPid: process.pid,
    pid: pty.pid,
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    startedAt: new Date().toISOString(),
    labels: spec.labels,
  };
  const writeMeta = (): void => {
    const tmp = `${metaFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600 });
    renameSync(tmp, metaFile);
  };

  const shutdown = (keepMeta: boolean): void => {
    server.close();
    rmSync(sock, { force: true });
    if (!keepMeta) rmSync(metaFile, { force: true });
    // Give pending socket writes a moment, then go.
    setTimeout(() => process.exit(0), 50).unref();
  };

  const armOrphanTimer = (): void => {
    if (spec.orphanTimeoutMs > 0 && !exit && !orphanTimer) {
      orphanTimer = setTimeout(() => killChild('SIGHUP'), spec.orphanTimeoutMs);
    }
  };

  const killChild = (signal: string): void => {
    if (exit) return;
    pty.kill(signal);
    if (!killTimer && signal !== 'SIGKILL') {
      killTimer = setTimeout(() => {
        if (!exit) pty.kill('SIGKILL');
      }, spec.killTimeoutMs);
    }
  };

  pty.onData((data) => {
    scrollback.write(data);
    if (client && clientLive) sendMessage(client, { t: 'data', b64: data.toString('base64') });
  });

  pty.onExit((info) => {
    exit = info;
    if (killTimer) clearTimeout(killTimer);
    if (orphanTimer) clearTimeout(orphanTimer);
    meta.exit = info;
    meta.exitedAt = new Date().toISOString();
    writeMeta();
    if (client && clientLive) {
      sendMessage(client, { t: 'exit', ...info });
      exitDelivered = true;
    }
    // Wait for a client to collect the exit; the meta file keeps it if nobody comes.
    lingerTimer = setTimeout(() => shutdown(!exitDelivered), spec.lingerMs);
  });

  const handleClient = (socket: Socket): void => {
    if (client && client !== socket) client.destroy();
    client = socket;
    clientLive = false;
    if (orphanTimer) {
      clearTimeout(orphanTimer);
      orphanTimer = undefined;
    }
    socket.on(
      'data',
      lineParser<ClientMessage>((msg) => {
        if (client !== socket) return;
        switch (msg.t) {
          case 'attach': {
            sendMessage(socket, {
              t: 'hello',
              id: spec.id,
              pid: pty.pid,
              supervisorPid: process.pid,
              cols,
              rows,
              start: scrollback.start,
              end: scrollback.end,
              acked,
              exit,
            });
            const all = scrollback.read();
            for (let i = 0; i < all.length; i += REPLAY_CHUNK) {
              sendMessage(socket, { t: 'replay', b64: all.subarray(i, i + REPLAY_CHUNK).toString('base64') });
            }
            sendMessage(socket, { t: 'replayed' });
            clientLive = true;
            if (exit) {
              sendMessage(socket, { t: 'exit', ...exit });
              exitDelivered = true;
            }
            break;
          }
          case 'input':
            if (!exit) pty.write(Buffer.from(msg.b64, 'base64'));
            break;
          case 'resize':
            cols = msg.cols;
            rows = msg.rows;
            pty.resize(cols, rows);
            break;
          case 'kill':
            killChild(msg.signal ?? 'SIGHUP');
            break;
          case 'ack':
            if (typeof msg.offset === 'number' && msg.offset > acked) acked = Math.min(msg.offset, scrollback.end);
            break;
        }
      }),
    );
    const onGone = (): void => {
      if (client !== socket) return;
      client = undefined;
      clientLive = false;
      if (exit && exitDelivered) {
        // The client saw the exit: nothing left to hand over.
        if (lingerTimer) clearTimeout(lingerTimer);
        shutdown(false);
      } else {
        armOrphanTimer();
      }
    };
    socket.on('close', onGone);
    socket.on('error', () => socket.destroy());
  };

  const server = createServer(handleClient);
  server.on('error', (err) => {
    meta.error = String(err);
    try {
      writeMeta();
    } catch {}
    killChild('SIGHUP');
    process.exit(1);
  });

  process.on('SIGTERM', () => {
    killChild('SIGHUP');
    setTimeout(() => process.exit(0), spec.killTimeoutMs + 500).unref();
  });
  process.on('SIGHUP', () => {});
  process.on('uncaughtException', (err) => {
    meta.error = String(err?.stack ?? err);
    try {
      writeMeta();
    } catch {}
  });

  rmSync(sock, { force: true });
  server.listen(sock, () => {
    chmodSync(sock, 0o600);
    writeMeta();
    armOrphanTimer();
    process.stdout.write('ready\n');
    process.stdout.end();
  });
}

main();
