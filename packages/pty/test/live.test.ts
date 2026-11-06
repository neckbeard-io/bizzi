// Live checks against installed agent TUIs. Opt-in: BIZZI_LIVE=1 npm test -w @bizzi/pty
// Starts each installed TUI in a PTY, waits for it to settle, and stops it. Sends no prompts.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAdapters, stripAnsi } from '../src/index.ts';
import { EventLog, ctx, startOpts } from './helpers.ts';

const live = process.env.BIZZI_LIVE === '1';

describe('live terminal agents', { skip: !live && 'set BIZZI_LIVE=1' }, () => {
  for (const adapter of createAdapters({ supervisor: false, idleMs: 3000 })) {
    if (adapter.agent === 'shell') continue;
    it(`${adapter.agent}: starts its TUI and settles to waiting_input`, async (t) => {
      const probe = await adapter.probe();
      if (!probe.installed) {
        t.skip(`${adapter.agent} not installed`);
        return;
      }
      const log = new EventLog();
      const session = await adapter.start(startOpts({ cwd: process.cwd(), cols: 120, rows: 40 }), log.emit, ctx);
      try {
        await log.waitFor(
          () => log.ofType('session.status').some((e) => e.data.status === 'waiting_input'),
          'waiting_input',
          30_000,
        );
        const status = log.ofType('session.status').find((e) => e.data.status === 'waiting_input')!;
        t.diagnostic(`version ${probe.version}; reason ${status.data.reason}`);
        t.diagnostic(`screen tail: ${JSON.stringify(stripAnsi(log.output()).slice(-600))}`);
        assert.ok(log.output().length > 0);
      } finally {
        await session.stop();
      }
    });
  }
});
