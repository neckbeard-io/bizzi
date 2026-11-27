// Keeping the machine awake while agents work (spec §8.1): the KeepAwake service against a fake
// backend, the settings parser, `pmset -g ps` parsing, and the node wiring (machine.set, MachineInfo).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BizziError, GLOBAL_CHANNEL, type KeepAwakeSettings, type KeepAwakeState, type PowerSource } from '@bizzi/protocol';
import { DEFAULT_KEEP_AWAKE, KeepAwake, createNode, nullLogger, parseKeepAwakeSettings, parsePmsetPs, readKeepAwakeSettings, type PowerBackend } from '../src/index.ts';
import { FakeAdapter } from '../src/testing/index.ts';
import { record, tempDir, waitFor } from './helpers.ts';

class FakePower implements PowerBackend {
  readonly name = 'fake';
  source: PowerSource = 'ac';
  holds = 0;
  releases = 0;
  checks = 0;
  #lost: ((err: Error) => void) | undefined;
  get held(): boolean {
    return this.holds > this.releases + this.lostCount;
  }
  lostCount = 0;
  hold(onLost: (err: Error) => void) {
    this.holds++;
    this.#lost = onLost;
    let done = false;
    return {
      release: () => {
        if (done) return;
        done = true;
        this.releases++;
      },
    };
  }
  /** The child died on its own. */
  lose(): void {
    this.lostCount++;
    this.#lost?.(new Error('killed'));
  }
  async powerSource(): Promise<PowerSource> {
    this.checks++;
    return this.source;
  }
}

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function make(settings: Partial<KeepAwakeSettings> = {}, opts: { backend?: PowerBackend | null; lingerMs?: number; powerPollMs?: number; retryMs?: number } = {}) {
  const power = new FakePower();
  const states: KeepAwakeState[] = [];
  const ka = new KeepAwake({
    ...(opts.backend === null ? {} : { backend: opts.backend ?? power }),
    settings: { ...DEFAULT_KEEP_AWAKE, ...settings },
    logger: nullLogger,
    onChange: (s) => states.push(s),
    lingerMs: opts.lingerMs ?? 40,
    powerPollMs: opts.powerPollMs ?? 30,
    powerFreshMs: 0,
    retryMs: opts.retryMs ?? 30,
  });
  return { ka, power, states };
}

test('defaults: active turns only, on a power adapter only', () => {
  assert.deepEqual(DEFAULT_KEEP_AWAKE, { mode: 'turns', onBattery: false });
  assert.deepEqual(readKeepAwakeSettings(undefined), DEFAULT_KEEP_AWAKE);
  assert.deepEqual(readKeepAwakeSettings('not json'), DEFAULT_KEEP_AWAKE);
  assert.deepEqual(readKeepAwakeSettings('{"mode":"bogus"}'), DEFAULT_KEEP_AWAKE);
  assert.deepEqual(readKeepAwakeSettings('{"mode":"off","onBattery":true}'), { mode: 'off', onBattery: true });
});

test('parseKeepAwakeSettings merges a partial object and rejects bad values', () => {
  assert.deepEqual(parseKeepAwakeSettings({ mode: 'turns_and_background' }, DEFAULT_KEEP_AWAKE), { mode: 'turns_and_background', onBattery: false });
  assert.deepEqual(parseKeepAwakeSettings({ onBattery: true }, DEFAULT_KEEP_AWAKE), { mode: 'turns', onBattery: true });
  for (const bad of [null, 'off', [], { mode: 'always' }, { onBattery: 'yes' }]) {
    assert.throws(() => parseKeepAwakeSettings(bad, DEFAULT_KEEP_AWAKE), (e: unknown) => e instanceof BizziError && e.code === 'bad_request', JSON.stringify(bad));
  }
});

test('parsePmsetPs reads the power source', () => {
  assert.equal(parsePmsetPs("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n"), 'ac');
  assert.equal(parsePmsetPs("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t87%; discharging; 5:12 remaining present: true\n"), 'battery');
  assert.equal(parsePmsetPs("Now drawing from 'UPS Power'\n"), 'ac');
  assert.equal(parsePmsetPs(''), 'unknown');
});

test('holds while a turn runs, lingers after the last one ends, then releases', async () => {
  const { ka, power, states } = make();
  assert.equal(ka.state().active, false);
  assert.equal(ka.state().supported, true);
  ka.update({ turns: 1, background: 0 });
  await tick(); // the power source is read first
  assert.equal(power.holds, 1);
  const held = ka.state();
  assert.equal(held.active, true);
  assert.equal(held.turns, 1);
  assert.equal(held.power, 'ac');
  assert.ok(held.since);
  // A second turn doesn't take a second hold.
  ka.update({ turns: 2, background: 0 });
  await tick();
  assert.equal(power.holds, 1);
  ka.update({ turns: 0, background: 0 });
  assert.equal(ka.state().active, true, 'still held while lingering');
  assert.ok(ka.state().lingerUntil);
  // New work during the linger keeps the same hold.
  ka.update({ turns: 1, background: 0 });
  assert.equal(ka.state().lingerUntil, undefined);
  ka.update({ turns: 0, background: 0 });
  await waitFor(() => !ka.state().active, 2000, 'release after linger');
  assert.equal(power.holds, 1);
  assert.equal(power.releases, 1);
  assert.equal(ka.state().since, undefined);
  assert.ok(states.some((s) => s.active) && !states.at(-1)!.active);
  ka.close();
});

test("mode 'turns' ignores background work; 'turns_and_background' holds for it", async () => {
  const { ka, power } = make({ mode: 'turns' });
  ka.update({ turns: 0, background: 2 });
  await tick();
  assert.equal(power.holds, 0);
  assert.equal(ka.state().background, 0, 'background work that does not count is not reported');
  ka.setSettings({ mode: 'turns_and_background', onBattery: false });
  await tick();
  assert.equal(power.holds, 1);
  assert.equal(ka.state().background, 2);
  // Narrowing the setting releases at once, without the linger.
  ka.setSettings({ mode: 'turns', onBattery: false });
  assert.equal(ka.state().active, false);
  assert.equal(power.releases, 1);
  ka.close();
});

test("mode 'off' never holds, and switching to it releases at once", async () => {
  const { ka, power } = make({ mode: 'off' });
  ka.update({ turns: 3, background: 1 });
  await tick();
  assert.equal(power.holds, 0);
  assert.equal(power.checks, 0, 'no power polling while off');
  ka.setSettings({ mode: 'turns', onBattery: false });
  await tick();
  assert.equal(power.holds, 1);
  ka.setSettings({ mode: 'off', onBattery: false });
  assert.equal(ka.state().active, false);
  assert.equal(ka.state().lingerUntil, undefined);
  ka.close();
});

test('on battery: paused unless onBattery, and the hold follows the power source', async () => {
  const { ka, power } = make({}, { powerPollMs: 20 });
  power.source = 'battery';
  ka.update({ turns: 1, background: 0 });
  await tick();
  assert.equal(power.holds, 0);
  assert.equal(ka.state().pausedOnBattery, true);
  assert.equal(ka.state().power, 'battery');
  // Plugged in: the poll notices and takes the hold.
  power.source = 'ac';
  await waitFor(() => ka.state().active, 2000, 'hold on AC');
  assert.equal(ka.state().pausedOnBattery, undefined);
  // Unplugged while held: released without lingering.
  power.source = 'battery';
  await waitFor(() => !ka.state().active, 2000, 'release on battery');
  assert.equal(ka.state().pausedOnBattery, true);
  // Also on battery: held again.
  ka.setSettings({ mode: 'turns', onBattery: true });
  assert.equal(ka.state().active, true);
  assert.equal(ka.state().pausedOnBattery, undefined);
  const checks = power.checks;
  await sleep(60);
  assert.equal(power.checks, checks, 'no power polling when battery does not matter');
  ka.close();
});

test('no backend on this OS: supported false, nothing is held', async () => {
  const { ka } = make({}, { backend: null });
  ka.update({ turns: 1, background: 0 });
  await tick();
  const s = ka.state();
  assert.equal(s.supported, false);
  assert.equal(s.active, false);
  assert.equal(s.power, undefined);
  ka.close();
});

test('a lost hold is taken again after a while', async () => {
  const { ka, power } = make({}, { retryMs: 30 });
  ka.update({ turns: 1, background: 0 });
  await tick();
  assert.equal(power.holds, 1);
  power.lose();
  assert.equal(ka.state().active, false);
  await waitFor(() => ka.state().active, 2000, 'hold again');
  assert.equal(power.holds, 2);
  ka.close();
});

test('close releases the hold and stops the timers', async () => {
  const { ka, power } = make();
  ka.update({ turns: 1, background: 0 });
  await tick();
  ka.close();
  assert.equal(power.releases, 1);
  const checks = power.checks;
  await sleep(80);
  assert.equal(power.checks, checks);
  ka.update({ turns: 2, background: 0 });
  assert.equal(power.holds, 1);
});

test('node: a running turn holds the machine awake; machine.set keepAwake changes and persists the setting', async (t) => {
  const dir = tempDir();
  t.after(() => dir.cleanup());
  const power = new FakePower();
  const open = () => createNode({ dataDir: dir.path, adapters: [new FakeAdapter()], version: '0.0.0-test', machineName: 'test-machine', power, keepAwakeLingerMs: 30 });
  const node = await open();
  try {
    assert.deepEqual(node.machine.keepAwake, { supported: true, settings: DEFAULT_KEEP_AWAKE, active: false, turns: 0, background: 0 });
    const log = record(node, GLOBAL_CHANNEL);
    const { workspace } = await node.call('workspace.create', { path: dir.path + '/ws', create: true });
    const { session } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
    await waitFor(() => node.sessions.get(session.id).session.status === 'idle', 5000, 'idle');
    await node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: '/slow 400' }] });
    await log.waitFor('machine.updated', (e) => e.data.machine.keepAwake?.active === true && e.data.machine.keepAwake.turns === 1);
    assert.equal(power.holds, 1);
    assert.equal((await node.call('machines.list', {})).machines[0]?.keepAwake?.active, true);
    await waitFor(() => node.machine.keepAwake?.active === false, 3000, 'release after the turn');
    assert.equal(power.releases, 1);
    assert.ok(log.events.some((e) => e.type === 'machine.updated' && e.data.machine.keepAwake?.lingerUntil), 'the linger is published');

    // Background work counts only under 'turns_and_background'.
    const { machine } = await node.call('machine.set', { keepAwake: { mode: 'turns_and_background' } });
    assert.deepEqual(machine.keepAwake?.settings, { mode: 'turns_and_background', onBattery: false });
    await log.waitFor('machine.updated', (e) => e.data.machine.keepAwake?.settings.mode === 'turns_and_background');
    const fake = node.registry.adapters[0] as FakeAdapter;
    fake.sessions[0]!.emitEvent({ type: 'background.updated', data: { tasks: [{ id: 't1', kind: 'shell', description: 'Wait for CI' }] } });
    await waitFor(() => node.machine.keepAwake?.active && node.machine.keepAwake.background === 1, 2000, 'background hold');
    fake.sessions[0]!.emitEvent({ type: 'background.updated', data: { tasks: [] } });
    await waitFor(() => node.machine.keepAwake?.active === false, 2000, 'released after background work');

    await assert.rejects(node.call('machine.set', { keepAwake: { mode: 'always' as never } }), (e: unknown) => e instanceof BizziError && e.code === 'bad_request');
    await node.call('machine.set', { keepAwake: { onBattery: true } });
    log.stop();
  } finally {
    await node.close();
  }
  const again = await open();
  try {
    assert.deepEqual(again.machine.keepAwake?.settings, { mode: 'turns_and_background', onBattery: true });
  } finally {
    await again.close();
  }
});

test('node without a power backend reports keep-awake as unsupported', async (t) => {
  const dir = tempDir();
  t.after(() => dir.cleanup());
  const node = await createNode({ dataDir: dir.path, adapters: [new FakeAdapter()], version: '0.0.0-test' });
  try {
    assert.equal(node.machine.keepAwake?.supported, false);
  } finally {
    await node.close();
  }
});
