import type { AgentEnvProvider, NodeOptions } from '@bizzi/core';
import type { Logger } from '@bizzi/protocol';
import { isMissing } from './adapters.ts';

export const TITLE_SYSTEM_PROMPT = [
  'You name conversations between a developer and a coding agent.',
  "Given the developer's first message (and sometimes their latest messages), reply with a title for the conversation and nothing else:",
  '3 to 7 words, sentence case, no quotes, no trailing punctuation. Name the task, not the request ("Fix login redirect loop", not "Help me fix...").',
  'When latest messages are given, name what the conversation is about now; keep the first message’s task unless the work has clearly moved on.',
].join(' ');

/** The part of @bizzi/adapter-api used here. */
interface ApiModule {
  ConfigSource: new (opts: { dataDir: string }) => { get(): { config: { utilityModel?: string } } };
  createUtilityCompleter(opts: {
    dataDir: string;
    logger: Logger;
    maxRetries: number;
    key: (name: string) => Promise<string | undefined>;
  }): {
    complete(req: { model: string; system: string; prompt: string; maxTokens: number; timeoutMs: number }): Promise<{ text: string; stopReason: string }>;
  };
}

/**
 * Session titles from a model (spec §6.5): `BIZZI_AUTO_TITLE_MODEL`, else `utilityModel` in
 * `<dataDir>/api-providers.json`. Only an explicitly chosen model is used, so nothing is billed by
 * default; without one, sessions keep the title taken from their first message. Keys come from the
 * secrets stored for agent `api`, then the environment. `BIZZI_AUTO_TITLE_MODEL=off` turns it off.
 */
export async function loadTitleSuggester(dataDir: string, logger: Logger): Promise<NodeOptions['suggestTitle']> {
  const override = process.env.BIZZI_AUTO_TITLE_MODEL?.trim() || undefined;
  if (override === 'off') return undefined;
  let mod: ApiModule;
  const name = '@bizzi/adapter-api';
  try {
    // Imported by name, like the adapters: optional, and its sources stay out of this typecheck.
    mod = (await import(name)) as ApiModule;
  } catch (err) {
    if (!isMissing(err, name)) logger.log('warn', 'failed to load the title model', { err });
    return undefined;
  }
  const log = logger.child({ component: 'titles' });
  const source = new mod.ConfigSource({ dataDir });
  let agentEnv: AgentEnvProvider | undefined;
  const completer = mod.createUtilityCompleter({
    dataDir,
    logger: log,
    maxRetries: 0,
    key: async (name) => (agentEnv ? (await agentEnv('api'))[name] : undefined) ?? process.env[name],
  });
  return async (text, ctx) => {
    const model = override ?? source.get().config.utilityModel;
    if (!model) return undefined;
    agentEnv = ctx.agentEnv;
    const r = await completer.complete({ model, system: TITLE_SYSTEM_PROMPT, prompt: text, maxTokens: 400, timeoutMs: 30_000 });
    return r.stopReason === 'refusal' ? undefined : r.text;
  };
}
