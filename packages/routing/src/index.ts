// @bizzi/routing: where a prompt should run (spec §11.2 one-pane mode). Explicit `@machine #workspace
// /agent` tokens, then an option-logit classifier on any OpenAI-compatible endpoint that returns logprobs.

export { buildTargets, type CatalogInput, type RouteTarget } from './catalog.ts';
export { parseExplicit, type ExplicitRoute } from './explicit.ts';
export {
  MAX_LOGPROB_OPTIONS,
  OPTION_LETTERS,
  buildMessages,
  confidence,
  backendScorer,
  optionLimit,
  scoreOptions,
  type LogprobBackend,
  type LogprobResult,
  type OptionScorer,
} from './logprobs.ts';
export { MAX_REMOTE_ATTEMPTS, remoteScorers, type ScoreCall } from './remote.ts';
export { DEFAULT_THRESHOLD, Router, routerOptionsFromEnv, type RouterOptions, type SuggestOptions } from './router.ts';
export { createRoutingExtension, type RoutingExtensionOptions } from './extension.ts';
export { MAX_RULES, applyRules, parseRules, ruleLabel, ruleMatches, type RuleRoute } from './rules.ts';
export { MAX_DECISIONS, RouteStore, parseDecision } from './store.ts';
