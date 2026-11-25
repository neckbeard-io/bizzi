// End to end through the core: createNode({ extensions }) dispatching to the services, the core
// calling the env provider, and `command` reaching the terminal adapter. Skipped until the core's
// NodeExtension API is in this tree (it is being added in parallel).

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createNode, type NodeOptions } from '@bizzi/core';
import { FakeAdapter } from '@bizzi/core/testing';
import { KnowledgeStore } from '@bizzi/knowledge';
import { GLOBAL_CHANNEL, sessionChannel, type ChannelEvent } from '@bizzi/protocol';
import { TerminalAdapter, claudeSpec } from '@bizzi/pty';
import { createServices, MemorySecretBackend } from '../src/index.ts';
import { FAKE_LOGIN_URL, fakeClaude } from './fake-claude.ts';
import { coreSupportsExtensions, logger, tempDir, waitFor } from './helpers.ts';

const supported = await coreSupportsExtensions();

describe('services inside createNode({ extensions })', { skip: supported ? false : 'core has no NodeExtension API yet' }, () => {
  it('secrets reach the agent env, logins run, knowledge methods dispatch', async () => {
    const dir = tempDir('bizzi-services-int-');
    const home = join(dir, 'home');
    const { recipes } = fakeClaude(dir, `echo "Sign in: ${FAKE_LOGIN_URL}"\necho "Enter code: WXYZ-1234"\ntouch $STATE\nexit 0`);
    const store = new KnowledgeStore({ path: ':memory:', machineId: 'm_pending' });
    const services = await createServices({
      dataDir: join(dir, 'data'),
      secretBackend: new MemorySecretBackend(),
      widgets: { dir: join(dir, 'widgets'), watch: false },
      recipes,
      knowledge: () => store,
      claudeHome: join(dir, '.claude'),
      login: { env: { PATH: '/usr/bin:/bin', HOME: home }, probeOptions: { home, npmPrefix: null }, workspacePath: dir },
    });
    const structured = new FakeAdapter({ agent: 'claude' });
    const terminal = new TerminalAdapter(claudeSpec(), { supervisor: false, path: '/nonexistent', extraDirs: [] });
    const node = await createNode({
      dataDir: join(dir, 'node'),
      adapters: [structured, terminal],
      logger,
      version: '0.0.0-test',
      extensions: services.extensions,
    } as NodeOptions);
    after(() => node.close());
    const global: ChannelEvent[] = [];
    node.subscribe(GLOBAL_CHANNEL, 0, (e) => global.push(e));

    await node.call('agent.setSecret', { agent: 'claude', name: 'ANTHROPIC_API_KEY', value: 'sk-int' });
    assert.deepEqual((await node.call('agent.secrets', {})).secrets.map((s) => s.name), ['ANTHROPIC_API_KEY']);
    assert.deepEqual((await node.call('widgets.list', {})).widgets, []);
    assert.ok(existsSync(join(dir, 'widgets', 'AGENTS.md')), 'widgets dir initialised');
    const { workspace } = await node.call('workspace.create', { path: tempDir() });
    await node.call('session.create', { workspaceId: workspace.id, agent: 'claude', mode: 'structured' });
    await waitFor(() => structured.starts.length === 1, 'structured start');
    assert.equal(structured.starts[0]!.env?.ANTHROPIC_API_KEY, 'sk-int');

    const { session } = await node.call('agent.login', { agent: 'claude' });
    const events: ChannelEvent[] = [];
    node.subscribe(sessionChannel(session.id), 0, (e) => events.push(e));
    await waitFor(() => events.some((e) => e.type === 'login.completed'), 'login.completed');
    const prompt = events.filter((e) => e.type === 'login.prompt').at(-1)!;
    assert.deepEqual((prompt.data as { urls: string[] }).urls, [FAKE_LOGIN_URL]);
    assert.deepEqual(events.find((e) => e.type === 'login.completed')!.data, { ok: true, account: 'me@example.com', message: 'logged in' });

    const { item } = await node.call('knowledge.add', { type: 'rule', title: 'r', body: 'b', scope: { level: 'global' } });
    await waitFor(() => global.some((e) => e.type === 'knowledge.changed'), 'knowledge.changed');
    assert.deepEqual((await node.call('knowledge.list', {})).items.map((i) => i.id), [item.id]);
  });
});
