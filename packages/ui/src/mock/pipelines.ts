// Mock pipelines (docs/pipelines.md): one planner → implementer → reviewer run in acme-shop, stopped at
// the gate before implementing. Approving runs the last two stages on a timer; rejecting cancels.
import { BizziError, GLOBAL_CHANNEL } from '@bizzi/protocol';
import type { PipelineInfo } from '@bizzi/protocol';
import { reviewPipeline } from '@bizzi/client';
import { MACHINE, iso } from './fixtures.ts';
import type { MockHost, MockModule } from './host.ts';

const METHODS = new Set(['pipelines.list', 'pipeline.start', 'pipeline.get', 'pipeline.gate', 'pipeline.cancel', 'pipeline.delete']);

function seed(): PipelineInfo {
  return {
    id: 'pl_auth',
    machineId: MACHINE.id,
    workspaceId: 'w_acme',
    title: 'Move sessions to signed cookies',
    task: 'Move sessions from the in-memory store to signed cookies, keeping the logout endpoint working.',
    spec: reviewPipeline({ planner: 'claude', implementer: 'codex', reviewer: 'opencode', reviewerModel: 'qwen3.8-27b (h200)' }),
    status: 'waiting',
    current: 1,
    gate: { stage: 1, reason: 'gate', message: 'Start implement (codex) after plan?', since: iso(-3) },
    stages: [
      {
        name: 'plan',
        agent: 'claude',
        status: 'done',
        sessionId: 's_plan',
        workspaceId: 'w_acme',
        startedAt: iso(-12),
        endedAt: iso(-3),
        summary: '1. Add a cookie signer in src/session/cookie.ts. 2. Replace MemoryStore in src/server.ts. 3. Clear the cookie in /logout. 4. Tests: session.spec.ts covers sign, verify, tamper and logout.',
        changedFiles: 0,
      },
      { name: 'implement', agent: 'codex', status: 'pending' },
      { name: 'review', agent: 'opencode', status: 'pending' },
    ],
    createdAt: iso(-12),
    updatedAt: iso(-3),
  };
}

export class MockPipelines implements MockModule {
  private readonly host: MockHost;
  private readonly runs = new Map<string, PipelineInfo>([['pl_auth', seed()]]);

  constructor(host: MockHost) {
    this.host = host;
  }

  handles(method: string): boolean {
    return METHODS.has(method);
  }

  handle(method: string, p: Record<string, unknown>): unknown {
    switch (method) {
      case 'pipelines.list':
        return { pipelines: [...this.runs.values()].filter((r) => !p.workspaceId || r.workspaceId === p.workspaceId).map((r) => structuredClone(r)) };
      case 'pipeline.get':
        return { pipeline: structuredClone(this.get(p.pipelineId)) };
      case 'pipeline.start':
        throw new BizziError('unsupported', 'the mock does not start pipelines; approve the seeded one in acme-shop');
      case 'pipeline.gate': {
        const r = this.get(p.pipelineId);
        if (r.status !== 'waiting' || !r.gate) throw new BizziError('conflict', 'not waiting at a gate');
        const stage = r.gate.stage;
        delete r.gate;
        if (p.decision === 'reject') {
          r.status = 'cancelled';
          r.error = `rejected at the gate before ${r.stages[stage]!.name}`;
          for (let i = stage; i < r.stages.length; i++) r.stages[i]!.status = 'cancelled';
        } else {
          r.status = 'running';
          void this.runFrom(r, stage);
        }
        return { pipeline: this.save(r) };
      }
      case 'pipeline.cancel': {
        const r = this.get(p.pipelineId);
        r.status = 'cancelled';
        delete r.gate;
        for (const s of r.stages) if (s.status === 'pending' || s.status === 'running') s.status = 'cancelled';
        return { pipeline: this.save(r) };
      }
      case 'pipeline.delete': {
        const r = this.get(p.pipelineId);
        this.runs.delete(r.id);
        this.host.emit(GLOBAL_CHANNEL, { type: 'pipeline.removed', data: { pipelineId: r.id, machineId: r.machineId } });
        return {};
      }
    }
    return undefined;
  }

  private get(id: unknown): PipelineInfo {
    const r = typeof id === 'string' ? this.runs.get(id) : undefined;
    if (!r) throw new BizziError('not_found', `pipeline ${String(id)} not found`);
    return r;
  }

  private save(r: PipelineInfo): PipelineInfo {
    r.updatedAt = new Date().toISOString();
    const copy = structuredClone(r);
    this.host.emit(GLOBAL_CHANNEL, { type: 'pipeline.updated', data: { pipeline: copy } });
    return copy;
  }

  private async runFrom(r: PipelineInfo, from: number): Promise<void> {
    for (let i = from; i < r.stages.length; i++) {
      if (r.status !== 'running') return;
      const st = r.stages[i]!;
      const s = this.host.createSession({ machineId: r.machineId, workspaceId: r.workspaceId, agent: st.agent, mode: 'structured', title: `${r.title} · ${st.name}`, status: 'running' });
      Object.assign(st, { status: 'running', sessionId: s.id, startedAt: new Date().toISOString() });
      r.current = i;
      this.save(r);
      await this.host.sleep(2500);
      if (r.status !== 'running') return;
      this.host.setSessionStatus(s.id, 'idle');
      Object.assign(st, { status: 'done', endedAt: new Date().toISOString(), summary: st.name === 'review' ? 'Looks good; one nit: the cookie max-age is hard-coded.' : 'Signed cookies in place; session.spec.ts passes.', changedFiles: st.name === 'implement' ? 3 : 0 });
    }
    r.status = 'done';
    this.save(r);
  }
}
