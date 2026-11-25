// Restart policy `ask` inbox items and the fallback divider (updates.md §6, §5).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentListing, RestartPolicy, SessionEvent, SessionEventBody, SessionInfo } from '@bizzi/protocol';
import { emptyTimeline, reduceTimeline, restartPromptsEqual, selectRestartPrompts, type BizziState, type RestartItem } from '../src/index.ts';

const T = (min: number): string => new Date(Date.parse('2026-11-25T10:00:00Z') + min * 60_000).toISOString();

function sess(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return { id, machineId: 'm1', workspaceId: 'w1', agent: 'claude', mode: 'structured', status: 'idle', createdAt: T(0), updatedAt: T(0), lastSeq: 1, ...over };
}

function listing(restartPolicy: RestartPolicy, version = '2.1.322', over: Partial<AgentListing> = {}): AgentListing {
  return { agent: 'claude', installed: true, auth: 'ok', version, restartPolicy, ...over };
}

/** Only the fields the selector reads. */
function state(sessions: SessionInfo[], agents: Record<string, AgentListing[]>): BizziState {
  return { sessions: Object.fromEntries(sessions.map((s) => [s.id, s])), agents, timelines: {} } as unknown as BizziState;
}

test('selectRestartPrompts: live sessions on an older version where the policy is ask', () => {
  const sessions = [
    sess('stale', { agentVersion: '2.1.311', updatedAt: T(1) }),
    sess('newer', { agentVersion: '2.1.311', updatedAt: T(5) }),
    sess('current', { agentVersion: '2.1.322' }),
    sess('never', {}),
    sess('ended', { agentVersion: '2.1.311', status: 'ended' }),
    sess('failed', { agentVersion: '2.1.311', status: 'failed' }),
    sess('codex', { agent: 'codex', agentVersion: '0.98.0' }),
    sess('other-machine', { machineId: 'm2', agentVersion: '2.1.311' }),
  ];
  const agents = {
    m1: [listing('ask'), { agent: 'codex' as const, installed: true, auth: 'ok' as const, version: '0.99.0', restartPolicy: 'when-idle' as const }],
    m2: [listing('manual')],
  };
  const prompts = selectRestartPrompts(state(sessions, agents));
  assert.deepEqual(
    prompts.map((p) => [p.session.id, p.running, p.installed]),
    [
      ['newer', '2.1.311', '2.1.322'],
      ['stale', '2.1.311', '2.1.322'],
    ],
  );
  assert.ok(restartPromptsEqual(prompts, selectRestartPrompts(state(sessions, agents))));
  // Uninstalled or unknown version: nothing to restart onto.
  assert.deepEqual(selectRestartPrompts(state(sessions, { m1: [listing('ask', '2.1.322', { installed: false })] })), []);
  assert.deepEqual(selectRestartPrompts(state(sessions, { m1: [listing('ask', '')] })), []);
});

test('timeline: a restart that fell back shows the version it resumed on', () => {
  const bodies: SessionEventBody[] = [
    { type: 'session.restarting', data: { fromVersion: '2.1.311', toVersion: '2.1.322', reason: 'update detected' } },
    { type: 'session.restarted', data: { fromVersion: '2.1.311', toVersion: '2.1.322', ok: false, error: 'could not start claude 2.1.322: boom', fallbackVersion: '2.1.311' } },
  ];
  const evs = bodies.map((b, i) => ({ ...b, ch: 'session:s1', seq: i + 1, ts: T(i) }) as SessionEvent);
  const tl = reduceTimeline(emptyTimeline('s1'), evs);
  const item = Object.values(tl.items).find((i): i is RestartItem => i.kind === 'restart');
  assert.equal(item?.state, 'failed');
  assert.equal(item?.fallbackVersion, '2.1.311');
  assert.equal(tl.agentVersion, '2.1.311');
  assert.equal(tl.restartItemId, null);
});
