// The routing methods on a node.
//   route.suggest: routes among this machine's own workspaces (local mode, or a client talking to the
//     node directly). Through a hub the hub answers instead, across every machine.
//   route.score: one readout through this node's classifier, for a hub that has none of its own. The
//     node advertises it as `MachineInfo.routing`; the model only has to be reachable from here.
//   route.record / route.decisions / route.rules.*: one-pane state for local mode (the hub keeps its own),
//     in `dbPath`. Without one they answer `unsupported` and route.suggest runs without rules.

import { DatabaseSync } from 'node:sqlite';
import type { NodeExtension } from '@bizzi/core';
import { BizziError } from '@bizzi/protocol';
import { optionLimit, scoreOptions } from './logprobs.ts';
import { Router, type RouterOptions } from './router.ts';
import { RouteStore } from './store.ts';

/** Longest option or prompt text `route.score` accepts, in characters. */
const MAX_SCORE_TEXT = 4000;

export interface RoutingExtensionOptions {
  /** SQLite file for rules and recorded decisions (e.g. `<data dir>/routing.db`). */
  dbPath?: string;
}

export function createRoutingExtension(opts: RouterOptions | Router = {}, ext: RoutingExtensionOptions = {}): NodeExtension & { router: Router } {
  const router = opts instanceof Router ? opts : new Router(opts);
  const backend = router.backend;
  let db: DatabaseSync | undefined;
  let store: RouteStore | undefined;
  const routes = (): RouteStore => {
    if (store) return store;
    throw new BizziError('unsupported', ext.dbPath ? 'routing store is closed' : 'this node keeps no routing store');
  };
  return {
    router,
    describeMachine(machine) {
      if (backend) machine.routing = { model: backend.model, maxOptions: optionLimit(backend) };
    },
    start() {
      if (!ext.dbPath) return;
      db = new DatabaseSync(ext.dbPath);
      db.exec('PRAGMA busy_timeout = 5000;');
      store = new RouteStore(db);
    },
    stop() {
      store = undefined;
      if (db?.isOpen) db.close();
      db = undefined;
    },
    methods: {
      'route.suggest': async (p: { text?: unknown } | undefined, ctx) => {
        const [{ workspaces }, { sessions }] = await Promise.all([ctx.node.call('workspaces.list', {}), ctx.node.call('sessions.list', {})]);
        const suggestion = await router.suggest(
          p?.text,
          { machines: [{ ...ctx.node.machine, online: true }], workspaces, sessions },
          { rules: store?.rules() ?? [] },
        );
        return { suggestion };
      },
      'route.score': async (p: { text?: unknown; options?: unknown } | undefined) => {
        if (!backend) throw new BizziError('unsupported', 'no routing classifier configured on this machine (BIZZI_ROUTER_URL)');
        const text = p?.text;
        const options = p?.options;
        if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_SCORE_TEXT) {
          throw new BizziError('bad_request', `text must be a non-empty string of at most ${MAX_SCORE_TEXT} characters`);
        }
        if (!Array.isArray(options) || !options.every((o) => typeof o === 'string' && o.length <= MAX_SCORE_TEXT)) {
          throw new BizziError('bad_request', 'options must be an array of strings');
        }
        const r = await scoreOptions(backend, text, options as string[]);
        return { ...r, model: backend.model };
      },
      'route.record': (p: unknown) => ({ decision: routes().record(p) }),
      'route.decisions': (p: unknown) => routes().list(p),
      'route.rules.get': () => ({ rules: routes().rules() }),
      'route.rules.set': (p: unknown) => ({ rules: routes().setRules(p) }),
    },
  };
}
