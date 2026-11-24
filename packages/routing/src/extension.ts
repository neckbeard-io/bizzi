// The routing methods on a node.
//   route.suggest: routes among this machine's own workspaces (local mode, or a client talking to the
//     node directly). Through a hub the hub answers instead, across every machine.
//   route.score: one readout through this node's classifier, for a hub that has none of its own. The
//     node advertises it as `MachineInfo.routing`; the model only has to be reachable from here.

import type { NodeExtension } from '@bizzi/core';
import { BizziError } from '@bizzi/protocol';
import { optionLimit, scoreOptions } from './logprobs.ts';
import { Router, type RouterOptions } from './router.ts';

/** Longest option or prompt text `route.score` accepts, in characters. */
const MAX_SCORE_TEXT = 4000;

export function createRoutingExtension(opts: RouterOptions | Router = {}): NodeExtension & { router: Router } {
  const router = opts instanceof Router ? opts : new Router(opts);
  const backend = router.backend;
  return {
    router,
    describeMachine(machine) {
      if (backend) machine.routing = { model: backend.model, maxOptions: optionLimit(backend) };
    },
    methods: {
      'route.suggest': async (p: { text?: unknown } | undefined, ctx) => {
        const [{ workspaces }, { sessions }] = await Promise.all([ctx.node.call('workspaces.list', {}), ctx.node.call('sessions.list', {})]);
        const suggestion = await router.suggest(p?.text, { machines: [{ ...ctx.node.machine, online: true }], workspaces, sessions });
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
    },
  };
}
