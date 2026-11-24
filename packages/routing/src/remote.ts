// Borrowing a machine's classifier (spec §11.2). The model often isn't on the hub's network: it's on a
// box only one machine can reach (a lab GPU behind its VPN, a local server). That machine's node
// advertises `MachineInfo.routing` and answers `route.score`; the hub's router calls it over the node link.

import { BizziError, type MachineInfo } from '@bizzi/protocol';
import { MAX_LOGPROB_OPTIONS, type LogprobResult, type OptionScorer } from './logprobs.ts';

export type ScoreCall = (machineId: string, params: { text: string; options: string[] }) => Promise<unknown>;

/** At most this many machines are tried for one suggestion before giving up. */
export const MAX_REMOTE_ATTEMPTS = 2;

/**
 * Online machines that advertise a classifier, best first: the one named by `via` (name, hostname or id),
 * then always-on machines (a laptop that's about to sleep is a poor choice), then by name.
 */
export function remoteScorers(machines: MachineInfo[], call: ScoreCall, via?: string): OptionScorer[] {
  const v = via?.toLowerCase();
  const named = (m: MachineInfo) => v !== undefined && (m.id === via || m.name.toLowerCase() === v || m.hostname.toLowerCase() === v);
  return machines
    .filter((m) => m.online && m.routing)
    .sort((a, b) => Number(named(b)) - Number(named(a)) || Number(b.alwaysOn) - Number(a.alwaysOn) || a.name.localeCompare(b.name))
    .map((m) => remoteScorer(m, call));
}

function remoteScorer(m: MachineInfo, call: ScoreCall): OptionScorer {
  const limit = Math.max(1, Math.min(MAX_LOGPROB_OPTIONS, Math.floor(m.routing!.maxOptions) || MAX_LOGPROB_OPTIONS));
  return {
    model: m.routing!.model,
    via: m.id,
    limit,
    async score(text, options) {
      const t0 = performance.now();
      let r: Partial<LogprobResult> | undefined;
      try {
        r = (await call(m.id, { text, options })) as Partial<LogprobResult> | undefined;
      } catch (err) {
        throw new BizziError('agent_unavailable', `${m.name}: ${(err as Error).message}`);
      }
      const probabilities = r?.probabilities;
      const letterMass = r?.letterMass;
      const ok =
        Array.isArray(probabilities) &&
        probabilities.length === options.length &&
        probabilities.every((p) => typeof p === 'number' && Number.isFinite(p) && p >= 0) &&
        typeof letterMass === 'number';
      if (!ok) throw new BizziError('agent_unavailable', `${m.name} returned a malformed route.score result`);
      // ms is the whole round trip through the machine, which is what the user waits for.
      return { probabilities, letterMass, ms: Math.round(performance.now() - t0) };
    },
  };
}
