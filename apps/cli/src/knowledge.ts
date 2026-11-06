import { join } from 'node:path';
import type { PrepareStart } from '@bizzi/core';
import type { Logger } from '@bizzi/protocol';

interface KnowledgeModule {
  KnowledgeStore: new (opts: { path: string; machineId: string; logger?: Logger }) => { path: string };
  knowledgeForSession: (
    context: { agent: string; machineId: string; projectId?: string; workspaceId?: string; sessionId?: string },
    opts: { store: never },
  ) => ReturnType<PrepareStart>;
}

/**
 * Build the session-start hook that injects scoped rules, the memory digest and the bizzi-memory MCP server.
 * Returns undefined when @bizzi/knowledge isn't installed. The store opens lazily on the first session start,
 * after the node (and its machine id) exists.
 */
export async function createKnowledgeHook(
  dataDir: string,
  logger: Logger,
  machineId: () => string,
): Promise<PrepareStart | undefined> {
  let mod: KnowledgeModule;
  try {
    mod = (await import('@bizzi/knowledge')) as unknown as KnowledgeModule;
  } catch (err) {
    logger.log('debug', 'knowledge layer not available', { err: String(err) });
    return undefined;
  }
  let store: { path: string } | undefined;
  return (session, workspace) => {
    // Terminal sessions type into a TUI; they get no injected prompt or MCP server for now.
    if (session.mode !== 'structured') return {};
    store ??= new mod.KnowledgeStore({ path: join(dataDir, 'knowledge.db'), machineId: machineId(), logger });
    const context = {
      agent: session.agent,
      machineId: session.machineId,
      workspaceId: workspace.id,
      sessionId: session.id,
      ...(workspace.projectId ? { projectId: workspace.projectId } : {}),
    };
    return mod.knowledgeForSession(context, { store: store as never });
  };
}
