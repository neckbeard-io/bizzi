import { join } from 'node:path';
import type { PrepareStart } from '@bizzi/core';
import type { KnowledgeStore } from '@bizzi/knowledge';
import type { Logger, MachineInfo } from '@bizzi/protocol';

type KnowledgeModule = typeof import('@bizzi/knowledge');

/**
 * One knowledge store per node, shared by the session-start injection hook and the knowledge
 * methods of @bizzi/services (so both see the same data and the same settings).
 */
export interface KnowledgeRuntime {
  /** The shared store, opened on first use (after the node, and its machine id, exists). */
  store(machineId: string): KnowledgeStore;
  /** Session-start hook: the machine card, scoped rules, the memory digest and the bizzi-memory MCP server. */
  prepareStart: PrepareStart;
  /** The node's machine (tags, description) for the card and tag rules; read at each session start. */
  bindMachine(machine: () => MachineInfo): void;
  /** Where the bizzi-memory server reaches session history (history_search, handoff_brief), per session. */
  bindHistory(history: (sessionId: string) => { url: string; token: string } | undefined): void;
  close(): void;
}

/** Returns undefined when @bizzi/knowledge isn't installed. */
export async function createKnowledgeRuntime(dataDir: string, logger: Logger): Promise<KnowledgeRuntime | undefined> {
  let mod: KnowledgeModule;
  try {
    mod = await import('@bizzi/knowledge');
  } catch (err) {
    logger.log('debug', 'knowledge layer not available', { err: String(err) });
    return undefined;
  }
  let store: KnowledgeStore | undefined;
  const open = (machineId: string): KnowledgeStore => {
    store ??= new mod.KnowledgeStore({ path: join(dataDir, 'knowledge.db'), machineId, logger: logger.child({ component: 'knowledge' }) });
    return store;
  };
  let machine: (() => MachineInfo) | undefined;
  let history: ((sessionId: string) => { url: string; token: string } | undefined) | undefined;
  return {
    store: open,
    bindMachine(fn) {
      machine = fn;
    },
    bindHistory(fn) {
      history = fn;
    },
    prepareStart: (session, workspace) => {
      // Terminal sessions type into a TUI; they get no injected prompt or MCP server for now.
      if (session.mode !== 'structured') return {};
      const m = machine?.();
      const context = {
        agent: session.agent,
        machineId: session.machineId,
        ...(m && m.tags.length > 0 ? { machineTags: [...m.tags] } : {}),
        workspaceId: workspace.id,
        sessionId: session.id,
        ...(workspace.projectId ? { projectId: workspace.projectId } : {}),
      };
      const h = history?.(session.id);
      const env = h ? { [mod.HISTORY_URL_ENV]: h.url, [mod.HISTORY_TOKEN_ENV]: h.token } : undefined;
      return mod.knowledgeForSession(context, { store: open(session.machineId), ...(m ? { machine: m } : {}), ...(env ? { env } : {}) });
    },
    close() {
      store?.close();
      store = undefined;
    },
  };
}
