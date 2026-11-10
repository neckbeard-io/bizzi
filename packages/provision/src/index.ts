// @bizzi/provision: ADE detection, install/update/uninstall recipes, login helpers.

export type * from './types.ts';

export { BUILTIN_RECIPES_DIR, defaultRecipes, loadRecipes, parseRecipe, RecipeError, RecipeSet } from './recipes.ts';
export { validateRecipe, type ValidationResult } from './schema.ts';
export { currentPlatform, parsePlatform, platformKey, resolveRecipePlatform } from './platform.ts';
export {
  augmentedEnv,
  augmentedPath,
  extraPathDirs,
  findBinary,
  homeDir,
  resolveNpmPrefix,
  toolsDir,
  type PathContext,
} from './path.ts';
export { evaluateAuthCommand, guessMethod, probe, probeAll, probeTool, type ProbeOptions, type ToolProbe } from './probe.ts';
export { clearLatestVersionCache, compareVersions, latestVersion, type FetchFn, type LatestOptions } from './latest.ts';
export { assessSupport, parseRange, satisfies, type Comparator, type Range, type RangeOp, type SupportVerdict } from './versions.ts';
export { execTargets, readShellScript, resolveExecutable, type ResolvedExecutable, type ResolveOptions } from './shim.ts';
export {
  assessInstall,
  installFacts,
  methodBinDir,
  methodForPaths,
  preferredMethod,
  watchPaths,
  type AssessOptions,
  type InstallAssessment,
  type InstallFacts,
} from './install.ts';
export { planInstall, type PlanOptions } from './plan.ts';
export { runPlan, type RunOptions } from './run.ts';
export {
  detectLoginPrompts,
  localhostCallbackPort,
  LoginPromptScanner,
  loginSpec,
  stripAnsi,
  type DetectedCode,
  type DetectedUrl,
  type DetectOptions,
  type LoginPrompts,
} from './login.ts';
export { execCapture, type ExecOptions, type ExecResult } from './exec.ts';
export { render, shellQuote } from './template.ts';
