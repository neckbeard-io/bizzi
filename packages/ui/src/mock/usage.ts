// Mock usage, widgets and orchestration settings (docs/usage.md, spec §12.2).
import { BizziError, DEFAULT_ORCHESTRATION_SETTINGS, GLOBAL_CHANNEL } from '@bizzi/protocol';
import type { AccountUsage, OrchestrationSettings, WidgetValue } from '@bizzi/protocol';
import { MACHINE, mockAccounts, mockWidgets } from './fixtures.ts';
import type { MockHost, MockModule } from './host.ts';

const METHODS = new Set(['usage.list', 'widgets.list', 'widget.refresh', 'orchestration.settings.get', 'orchestration.settings.set']);

export class MockUsage implements MockModule {
  private readonly host: MockHost;
  readonly accounts = new Map<string, AccountUsage>();
  readonly widgets = new Map<string, WidgetValue>();
  /** Per machine, and per `machineId:workspaceId` for workspace overrides. */
  private readonly settings = new Map<string, Partial<OrchestrationSettings>>();
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(host: MockHost, opts: { live: boolean }) {
    this.host = host;
    for (const a of mockAccounts()) this.accounts.set(`${a.agent}:${a.accountId}`, a);
    for (const w of mockWidgets()) this.widgets.set(`${w.machineId}:${w.id}`, w);
    this.settings.set(MACHINE.id, { maxHelpersPerMachine: 6, treeBudgetUsd: 10 });
    this.settings.set(`${MACHINE.id}:w_acme`, { maxDepth: 1 });
    // Live demo: the LiteLLM spend creeps up and the H200 load moves, like values relayed from a node.
    if (opts.live) {
      this.ticker = setInterval(() => this.tick(), 15_000);
      (this.ticker as { unref?: () => void }).unref?.();
    }
  }

  dispose(): void {
    if (this.ticker) clearInterval(this.ticker);
  }

  handles(method: string): boolean {
    return METHODS.has(method);
  }

  async handle(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'usage.list':
        return { accounts: [...this.accounts.values()].map((a) => ({ ...a })) };
      case 'widgets.list': {
        const online = new Set(this.host.machines().filter((m) => m.online).map((m) => m.id));
        const mid = typeof params.machineId === 'string' && params.machineId ? params.machineId : null;
        return { widgets: [...this.widgets.values()].filter((w) => (mid ? w.machineId === mid : online.has(w.machineId))).map((w) => ({ ...w })) };
      }
      case 'widget.refresh': {
        const m = this.host.requireOnline(params.machineId);
        const key = `${m.id}:${String(params.widgetId)}`;
        const w = this.widgets.get(key);
        if (!w) throw new BizziError('not_found', `no widget ${String(params.widgetId)} on ${m.name}`);
        await this.host.sleep(300);
        const next: WidgetValue = { ...w, observedAt: new Date().toISOString() };
        delete next.error;
        this.widgets.set(key, next);
        this.host.emit(GLOBAL_CHANNEL, { type: 'widget.updated', data: { widget: { ...next } } });
        return { widget: { ...next } };
      }
      case 'orchestration.settings.get': {
        const m = this.host.requireOnline(params.machineId);
        return { settings: this.effective(m.id, typeof params.workspaceId === 'string' ? params.workspaceId : undefined) };
      }
      case 'orchestration.settings.set': {
        const m = this.host.requireOnline(params.machineId);
        const ws = typeof params.workspaceId === 'string' ? params.workspaceId : undefined;
        const patch = (params.settings ?? {}) as Partial<OrchestrationSettings>;
        if (patch.maxDepth !== undefined && (patch.maxDepth < 0 || patch.maxDepth > 5)) throw new BizziError('bad_request', 'maxDepth must be between 0 and 5');
        const key = ws ? `${m.id}:${ws}` : m.id;
        this.settings.set(key, { ...this.settings.get(key), ...patch });
        return { settings: this.effective(m.id, ws) };
      }
      default:
        throw new BizziError('unsupported', `mock does not implement ${method}`);
    }
  }

  private effective(machineId: string, workspaceId?: string): OrchestrationSettings {
    return { ...DEFAULT_ORCHESTRATION_SETTINGS, ...this.settings.get(machineId), ...(workspaceId ? this.settings.get(`${machineId}:${workspaceId}`) : {}) };
  }

  private tick(): void {
    const bill = this.widgets.get(`${MACHINE.id}:litellm-billed`);
    if (bill && bill.value !== undefined) this.update({ ...bill, value: Math.round((bill.value + Math.random() * 1.8) * 100) / 100, observedAt: new Date().toISOString() });
    for (const w of this.widgets.values()) {
      if (w.id !== 'h200' || w.value === undefined) continue;
      const v = Math.max(0, Math.min(8, w.value + (Math.random() < 0.5 ? -1 : 1)));
      this.update({ ...w, value: v, tone: v >= 7 ? 'warn' : 'neutral', observedAt: new Date().toISOString() });
    }
  }

  private update(w: WidgetValue): void {
    const m = this.host.machines().find((x) => x.id === w.machineId);
    if (!m?.online) return;
    this.widgets.set(`${w.machineId}:${w.id}`, w);
    this.host.emit(GLOBAL_CHANNEL, { type: 'widget.updated', data: { widget: { ...w } } });
  }
}
