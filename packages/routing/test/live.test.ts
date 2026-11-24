// Live check against a real classifier: BIZZI_LIVE=1 plus BIZZI_ROUTER_URL / BIZZI_ROUTER_MODEL (and the
// other BIZZI_ROUTER_* variables). For the H200 Qwen through Bifrost:
//   BIZZI_ROUTER_URL=https://englab-12918-2.lab.ppops.net/v1 BIZZI_ROUTER_MODEL=vllm/qwen3.8-27b
//   BIZZI_ROUTER_BODY='{"chat_template_kwargs":{"enable_thinking":false}}' BIZZI_ROUTER_API_KEY=…

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MachineInfo, SessionInfo, WorkspaceInfo } from '@bizzi/protocol';
import { Router, routerOptionsFromEnv } from '../src/index.ts';

const live = process.env.BIZZI_LIVE === '1' && !!process.env.BIZZI_ROUTER_URL;

const m = (id: string, name: string, over: Partial<MachineInfo>): MachineInfo => ({
  id,
  name,
  hostname: name,
  os: 'darwin',
  arch: 'arm64',
  headful: false,
  alwaysOn: false,
  tags: [],
  online: true,
  roles: ['node'],
  bizziVersion: '0',
  ...over,
});
const w = (id: string, machineId: string, name: string, path: string): WorkspaceInfo => ({ id, machineId, name, path, kind: 'git', createdAt: '2026-11-01T00:00:00Z' });

const MACHINES = [
  m('m_laptop', 'laptop', { tags: ['prod-access'], description: 'Work laptop: VPN, kube contexts, prod logs.' }),
  m('m_mini', 'mac-mini', { tags: ['gui'], headful: true, description: 'Xcode, iOS simulator, headed browsers. No production access.' }),
  m('m_vps', 'vps', { os: 'linux', alwaysOn: true, description: 'Hetzner box for infra work and long jobs.' }),
];
const WORKSPACES = [
  w('w_shop_l', 'm_laptop', 'acme-shop', '~/src/acme-shop'),
  w('w_shop_m', 'm_mini', 'acme-shop', '~/src/acme-shop'),
  w('w_infra', 'm_vps', 'infra', '~/infra'),
  w('w_notes', 'm_laptop', 'research-notes', '~/notes'),
  w('w_bizzi', 'm_laptop', 'bizzi', '~/repo/bizzi'),
  w('w_scratch', 'm_vps', 'scratch', '~/scratch'),
];
const titled = (workspaceId: string, title: string, day: number): SessionInfo => ({
  id: `s_${workspaceId}_${day}`,
  machineId: '',
  workspaceId,
  agent: 'claude',
  mode: 'structured',
  status: 'idle',
  title,
  createdAt: `2026-11-${String(day).padStart(2, '0')}T00:00:00Z`,
  updatedAt: `2026-11-${String(day).padStart(2, '0')}T00:00:00Z`,
  lastSeq: 0,
});
const SESSIONS = [
  titled('w_shop_l', 'Checkout service: retry payment timeouts', 10),
  titled('w_shop_l', 'Investigate 5xx spike on checkout in prod', 12),
  titled('w_shop_m', 'Cart layout on iPhone SE', 11),
  titled('w_shop_m', 'Simulator screenshots for the cart PR', 13),
  titled('w_infra', 'Terraform: Route53 records for staging', 9),
  titled('w_bizzi', 'Sidebar tree and machine tiles', 14),
];
const sets = [
  ['machine facts and folders only', { machines: MACHINES, workspaces: WORKSPACES }],
  ['plus recent session titles', { machines: MACHINES, workspaces: WORKSPACES, sessions: SESSIONS }],
] as const;

const CLEAR: [string, string][] = [
  ['why are checkout 502s up since 14:00 in prod?', 'w_shop_l'],
  ['cart page broken on iPhone Safari, screenshot in simulator', 'w_shop_m'],
  ['terraform module for the new S3 bucket + CI', 'w_infra'],
  ["tidy up my notes from yesterday's meeting", 'w_notes'],
  ['bizzi sidebar resize handle jitters', 'w_bizzi'],
];

test('live: the configured classifier routes the clear prompts', { skip: !live }, async () => {
  const router = new Router(routerOptionsFromEnv());
  for (const [name, input] of sets) {
    console.log(`\n${name}`);
    for (const [text, want] of CLEAR) {
      const s = await router.suggest(text, input);
      const top = s.candidates.map((c) => `${c.label} ${c.probability}`).join(' / ');
      console.log(`${text} → ${top} | confidence ${s.confidence} | ${s.classifier?.ms} ms | letter mass ${s.classifier?.letterMass}`);
      assert.equal(s.source, 'classifier', s.note ?? '');
      assert.equal(s.candidates[0]?.workspaceId, want, text);
    }
    const s = await router.suggest('fix the flaky checkout unit test', input);
    console.log(`ambiguous → ${s.candidates.map((c) => `${c.label} ${c.probability}`).join(' / ')} | confidence ${s.confidence} | confident ${s.confident}`);
  }
});
