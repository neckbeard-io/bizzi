// The hub's routing core: machines and their links, the workspace/session → machine index, ingestion
// of replicated node events, and client request handling (hub-only methods + forwarding).

import os from 'node:os';
import { mergeAccountUsage, normalizeAccountUsage, sortAccountUsage, usageKey } from '@bizzi/core';
import {
  type AccountUsage,
  BizziError,
  GLOBAL_CHANNEL,
  NO_CAPABILITIES,
  PROTOCOL_VERSION,
  newId,
  sessionChannel,
  type AgentCapabilities,
  type ChannelEvent,
  type DeviceInfo,
  type GlobalEvent,
  type GlobalEventBody,
  type Logger,
  type MachineInfo,
  type SessionInfo,
  type WidgetValue,
  type WorkspaceInfo,
} from '@bizzi/protocol';
import type { Auth } from './auth.ts';
import type { HubBus } from './bus.ts';
import { publicDevice, type DeviceRow, type HubStore } from './store.ts';

/** What the relay needs from a hub-side node link. */
export interface LinkHandle {
  readonly machineId: string;
  readonly deviceId: string;
  request(method: string, params: unknown): Promise<unknown>;
  /** Subscribe a session channel over the link if not already subscribed. */
  watch(ch: string): void;
  /** Forget a channel (session removed). */
  forget(ch: string): void;
  close(code: number, reason: string): void;
}

/** What the relay needs from a client connection. */
export interface ClientHandle {
  readonly device: DeviceRow;
  close(code: number, reason: string): void;
}

export const CLOSE_REVOKED = 4403;

const HUB_ONLY = new Set(['pairing.create', 'devices.list', 'device.revoke']);

export interface RelayOptions {
  store: HubStore;
  bus: HubBus;
  auth: Auth;
  logger: Logger;
  version: string;
  /** Public base URL (https://bizzi.example.com), used for pairUrl / clientUrl. */
  publicUrl?: string;
}

export class Relay {
  readonly store: HubStore;
  readonly bus: HubBus;
  readonly auth: Auth;
  readonly logger: Logger;
  readonly version: string;
  readonly machine: MachineInfo;
  publicUrl?: string;
  readonly #links = new Map<string, LinkHandle>();
  readonly #clients = new Set<ClientHandle>();
  readonly #nodeCursors = new Map<string, number>();

  constructor(o: RelayOptions) {
    this.store = o.store;
    this.bus = o.bus;
    this.auth = o.auth;
    this.logger = o.logger;
    this.version = o.version;
    if (o.publicUrl) this.publicUrl = o.publicUrl.replace(/\/+$/, '');
    let hubId = this.store.getMeta('hubId');
    if (!hubId) {
      hubId = newId('m');
      this.store.setMeta('hubId', hubId);
    }
    const hostname = os.hostname();
    const platform = process.platform;
    this.machine = {
      id: hubId,
      name: hostname,
      hostname,
      os: platform === 'darwin' || platform === 'linux' || platform === 'win32' ? platform : 'other',
      arch: process.arch,
      headful: false,
      alwaysOn: true,
      tags: [],
      online: true,
      roles: ['hub'],
      bizziVersion: o.version,
    };
    // Machines can't be online before any node has linked to this process. Record that in the global log
    // too, or clients replaying it would see the last "online" from before the restart.
    for (const m of this.store.listMachines()) {
      if (!m.info.online) continue;
      this.store.putMachine({ ...m, info: { ...m.info, online: false } });
      this.#emitMachine(m.info.id);
    }
  }

  helloResult(): { protocol: string; serverVersion: string; machine: MachineInfo; role: 'hub' } {
    return { protocol: PROTOCOL_VERSION, serverVersion: this.version, machine: this.machine, role: 'hub' };
  }

  // --- machines ---------------------------------------------------------------------------------

  isOnline(machineId: string): boolean {
    return this.#links.has(machineId);
  }

  machineView(machineId: string): MachineInfo | undefined {
    const row = this.store.getMachine(machineId);
    if (!row) return undefined;
    const info: MachineInfo = { ...row.info, online: this.isOnline(machineId) };
    if (row.lastSeenAt) info.lastSeenAt = row.lastSeenAt;
    return info;
  }

  listMachines(): MachineInfo[] {
    return this.store
      .listMachines()
      .map((m) => this.machineView(m.info.id))
      .filter((m): m is MachineInfo => m !== undefined);
  }

  #emitMachine(machineId: string): void {
    const machine = this.machineView(machineId);
    if (machine) this.bus.appendGlobal({ type: 'machine.updated', data: { machine } }, { machineId });
  }

  /** A node finished node.hello: replace any previous link for the machine and mark it online. */
  attachLink(link: LinkHandle, machine: MachineInfo): void {
    const previous = this.#links.get(link.machineId);
    // Register the new link first so closing the old one doesn't flap the machine offline.
    this.#links.set(link.machineId, link);
    if (previous && previous !== link) previous.close(4409, 'replaced by a newer connection');
    const now = new Date().toISOString();
    const info: MachineInfo = { ...machine, online: true };
    delete info.lastSeenAt;
    this.store.putMachine({ info, deviceId: link.deviceId, lastSeenAt: now });
    this.store.touchDevice(link.deviceId, now);
    this.#nodeCursors.set(link.machineId, this.store.nodeCursor(link.machineId));
    this.logger.log('info', 'machine online', { machineId: link.machineId, name: machine.name });
    this.#emitMachine(link.machineId);
  }

  detachLink(link: LinkHandle): void {
    if (this.#links.get(link.machineId) !== link) return;
    this.#links.delete(link.machineId);
    if (!this.store.isOpen) return;
    const now = new Date().toISOString();
    const row = this.store.getMachine(link.machineId);
    if (row) this.store.putMachine({ ...row, info: { ...row.info, online: false }, lastSeenAt: now });
    this.store.touchDevice(link.deviceId, now);
    this.logger.log('info', 'machine offline', { machineId: link.machineId });
    this.#emitMachine(link.machineId);
  }

  linkFor(machineId: string): LinkHandle | undefined {
    return this.#links.get(machineId);
  }

  // --- ingestion of replicated node events ------------------------------------------------------

  /** A node's own `global` event: update the index, then append a re-sequenced copy to the hub log. */
  ingestNodeGlobal(link: LinkHandle, ev: GlobalEvent): void {
    const machineId = link.machineId;
    const cursor = this.#nodeCursors.get(machineId) ?? this.store.nodeCursor(machineId);
    if (ev.seq <= cursor) return;
    let body: GlobalEventBody | undefined = { type: ev.type, data: ev.data } as GlobalEventBody;
    let afterCommit: (() => void) | undefined;

    switch (ev.type) {
      case 'machine.updated': {
        if (ev.data.machine.id !== machineId) break;
        const row = this.store.getMachine(machineId);
        const info: MachineInfo = { ...ev.data.machine, online: true };
        delete info.lastSeenAt;
        this.store.putMachine({ info, deviceId: link.deviceId, lastSeenAt: row?.lastSeenAt ?? new Date().toISOString() });
        const view = this.machineView(machineId);
        if (view) body = { type: 'machine.updated', data: { machine: view } };
        break;
      }
      case 'workspace.created':
        if (ev.data.workspace.machineId === machineId) this.store.putWorkspace(ev.data.workspace);
        break;
      case 'workspace.removed':
        if (this.store.workspaceMachine(ev.data.workspaceId) === machineId) this.store.deleteWorkspace(ev.data.workspaceId);
        break;
      case 'session.created':
      case 'session.updated': {
        const s = ev.data.session;
        if (s.machineId !== machineId) break;
        this.store.putSession(s);
        if (ev.type === 'session.created') afterCommit = () => link.watch(sessionChannel(s.id));
        break;
      }
      case 'session.removed': {
        const owner = this.store.getSession(ev.data.sessionId)?.info.machineId;
        if (owner && owner !== machineId) break;
        const ch = sessionChannel(ev.data.sessionId);
        this.store.deleteSession(ev.data.sessionId, ch);
        this.bus.dropChannel(ch);
        link.forget(ch);
        break;
      }
      case 'account.usage': {
        // Store this machine's snapshot; relay the login merged across machines (usage.md §3.1).
        const u = normalizeAccountUsage(ev.data?.usage);
        if (!u) {
          body = undefined;
          break;
        }
        u.machines = [machineId];
        this.store.putUsage(machineId, u);
        const merged = mergeAccountUsage(this.store.listUsage({ agent: u.agent, accountId: u.accountId }));
        body = merged ? { type: 'account.usage', data: { usage: merged } } : undefined;
        break;
      }
      case 'widget.updated': {
        const w = ev.data?.widget;
        if (!isWidgetValue(w)) {
          body = undefined;
          break;
        }
        const widget: WidgetValue = { ...w, machineId };
        this.store.putWidget(widget);
        body = { type: 'widget.updated', data: { widget } };
        break;
      }
      case 'widget.removed': {
        if (typeof ev.data?.widgetId !== 'string') {
          body = undefined;
          break;
        }
        this.store.deleteWidget(machineId, ev.data.widgetId);
        body = { type: 'widget.removed', data: { machineId, widgetId: ev.data.widgetId } };
        break;
      }
    }

    if (body) {
      this.bus.appendGlobal(body, {
        ts: ev.ts,
        machineId,
        inTx: () => this.store.setNodeCursor(machineId, ev.seq),
      });
    } else {
      this.logger.log('debug', 'dropping invalid node global event', { machineId, type: ev.type, seq: ev.seq });
      this.store.setNodeCursor(machineId, ev.seq);
    }
    this.#nodeCursors.set(machineId, ev.seq);
    afterCommit?.();
  }

  /** A replicated session-channel event. */
  ingestSessionEvent(link: LinkHandle, ev: ChannelEvent): void {
    const sessionId = ev.ch.slice('session:'.length);
    const owner = this.store.getSession(sessionId)?.info.machineId;
    if (owner && owner !== link.machineId) {
      this.logger.log('warn', 'dropping event for a session owned by another machine', { ch: ev.ch, from: link.machineId });
      return;
    }
    this.bus.appendReplica(ev);
  }

  /** Reconcile the index with a node's current workspaces and sessions (after each link). */
  reconcile(link: LinkHandle, workspaces: WorkspaceInfo[], sessions: SessionInfo[]): void {
    this.store.tx(() => {
      const live = new Set(workspaces.map((w) => w.id));
      for (const w of this.store.listWorkspaces(link.machineId)) if (!live.has(w.id)) this.store.deleteWorkspace(w.id);
      for (const w of workspaces) if (w.machineId === link.machineId) this.store.putWorkspace(w);
      for (const s of sessions) if (s.machineId === link.machineId) this.store.putSession(s);
    });
    for (const s of sessions) if (s.machineId === link.machineId) link.watch(sessionChannel(s.id));
  }

  // --- devices ----------------------------------------------------------------------------------

  addClient(c: ClientHandle): void {
    this.#clients.add(c);
  }

  removeClient(c: ClientHandle): void {
    this.#clients.delete(c);
  }

  emitDevice(device: DeviceRow): void {
    this.bus.appendGlobal({ type: 'device.updated', data: { device: publicDevice(device) } });
  }

  revokeDevice(deviceId: string): void {
    const device = this.store.getDevice(deviceId);
    if (!device) throw new BizziError('not_found', `device ${deviceId} not found`);
    if (!device.revoked) {
      this.store.revokeDevice(deviceId);
      this.logger.log('info', 'device revoked', { deviceId, kind: device.kind });
    }
    for (const c of [...this.#clients]) if (c.device.id === deviceId) c.close(CLOSE_REVOKED, 'device revoked');
    for (const l of [...this.#links.values()]) if (l.deviceId === deviceId) l.close(CLOSE_REVOKED, 'device revoked');
    this.emitDevice({ ...device, revoked: true });
  }

  // --- client requests --------------------------------------------------------------------------

  /** Handle a client request other than hello/subscribe/unsubscribe. */
  async handle(device: DeviceRow, method: string, params: unknown, ctx: { baseUrl?: string } = {}): Promise<unknown> {
    const p = (params && typeof params === 'object' && !Array.isArray(params) ? params : {}) as Record<string, unknown>;
    if (HUB_ONLY.has(method) && device.kind !== 'device') {
      throw new BizziError('unauthorized', `${method} is only available to paired devices`);
    }
    switch (method) {
      case 'hello':
        return this.helloResult();
      case 'machines.list':
        return { machines: this.listMachines() };
      case 'pairing.create': {
        const kind = p.kind;
        if (kind !== 'device' && kind !== 'node') throw new BizziError('bad_request', "kind must be 'device' or 'node'");
        const opts: { name?: string; createdBy: string } = { createdBy: device.id };
        if (typeof p.name === 'string' && p.name.trim()) opts.name = p.name.trim().slice(0, 100);
        const { code, expiresAt } = this.auth.createPairingCode(kind, opts);
        const base = this.publicUrl ?? ctx.baseUrl ?? '';
        return { code, expiresAt, pairUrl: `${base}/#/pair?code=${encodeURIComponent(code)}` };
      }
      case 'devices.list':
        return { devices: this.store.listDevices().map(publicDevice) satisfies DeviceInfo[] };
      case 'device.revoke': {
        if (typeof p.deviceId !== 'string') throw new BizziError('bad_request', 'deviceId is required');
        this.revokeDevice(p.deviceId);
        return {};
      }
      case 'workspaces.list': {
        const machineId = this.#optMachine(p);
        return { workspaces: this.store.listWorkspaces(machineId) };
      }
      case 'sessions.list': {
        const filter: { machineId?: string; workspaceId?: string } = {};
        if (typeof p.workspaceId === 'string') {
          if (!this.store.workspaceMachine(p.workspaceId)) throw new BizziError('not_found', `workspace ${p.workspaceId} not found`);
          filter.workspaceId = p.workspaceId;
        } else {
          const machineId = this.#optMachine(p);
          if (machineId) filter.machineId = machineId;
        }
        return { sessions: this.store.listSessions(filter).map((s) => this.#withLastSeq(s)) };
      }
      case 'usage.list':
        return { accounts: this.listUsage() };
      case 'widgets.list': {
        const machineId = this.#optMachine(p);
        if (!machineId) return { widgets: this.store.listWidgets() };
        const link = this.#links.get(machineId);
        if (!link) return { widgets: this.store.listWidgets(machineId) };
        const res = (await link.request(method, p)) as { widgets?: WidgetValue[] };
        if (Array.isArray(res?.widgets)) this.store.replaceWidgets(machineId, res.widgets.filter(isWidgetValue));
        return res;
      }
      // Custom themes live on the hub so every device sees them (theming.md §5); never relayed.
      case 'themes.list':
        return { themes: this.store.themes.list() };
      case 'theme.save':
        return { theme: this.store.themes.save(p) };
      case 'theme.delete':
        this.store.themes.delete(p);
        return {};
      case 'session.get': {
        if (typeof p.sessionId !== 'string') throw new BizziError('bad_request', 'sessionId is required');
        const cached = this.store.getSession(p.sessionId);
        if (!cached) throw new BizziError('not_found', `session ${p.sessionId} not found`);
        const link = this.#links.get(cached.info.machineId);
        if (!link) {
          // Offline: serve the last known state so clients can still open the timeline.
          return { session: this.#withLastSeq(cached.info), capabilities: cached.capabilities ?? { ...NO_CAPABILITIES } };
        }
        const res = (await link.request(method, p)) as { session: SessionInfo; capabilities: AgentCapabilities };
        if (res?.capabilities) this.store.setSessionCapabilities(p.sessionId, res.capabilities);
        return res;
      }
    }
    const machineId = this.route(p);
    const link = this.#links.get(machineId);
    if (!link) throw new BizziError('machine_offline', `machine ${machineId} is offline`, { machineId, lastSeenAt: this.store.getMachine(machineId)?.lastSeenAt });
    return link.request(method, p);
  }

  /** Every login merged across machines; offline machines' last snapshots still count (with their age). */
  listUsage(): AccountUsage[] {
    const groups = new Map<string, AccountUsage[]>();
    for (const u of this.store.listUsage()) {
      const key = usageKey(u);
      const g = groups.get(key);
      if (g) g.push(u);
      else groups.set(key, [u]);
    }
    return sortAccountUsage([...groups.values()].map((g) => mergeAccountUsage(g)).filter((u): u is AccountUsage => u !== undefined));
  }

  /** The machine that owns a request: by sessionId, workspaceId, then machineId. */
  route(p: Record<string, unknown>): string {
    if (typeof p.sessionId === 'string') {
      const s = this.store.getSession(p.sessionId);
      if (!s) throw new BizziError('not_found', `session ${p.sessionId} not found`);
      return s.info.machineId;
    }
    if (typeof p.workspaceId === 'string') {
      const m = this.store.workspaceMachine(p.workspaceId);
      if (!m) throw new BizziError('not_found', `workspace ${p.workspaceId} not found`);
      return m;
    }
    const machineId = this.#optMachine(p);
    if (machineId) return machineId;
    const all = this.store.listMachines();
    if (all.length === 1) return all[0]!.info.id;
    throw new BizziError('bad_request', 'machineId is required when talking to a hub');
  }

  #optMachine(p: Record<string, unknown>): string | undefined {
    if (p.machineId === undefined) return undefined;
    if (typeof p.machineId !== 'string') throw new BizziError('bad_request', 'machineId must be a string');
    if (!this.store.getMachine(p.machineId)) throw new BizziError('not_found', `machine ${p.machineId} not found`);
    return p.machineId;
  }

  #withLastSeq(s: SessionInfo): SessionInfo {
    const stored = this.bus.lastSeq(sessionChannel(s.id));
    return stored > s.lastSeq ? { ...s, lastSeq: stored } : s;
  }

  /** Throws not_found / bad_request unless `ch` is a channel the hub can serve. */
  assertChannel(ch: unknown): asserts ch is string {
    if (typeof ch !== 'string') throw new BizziError('bad_request', 'ch must be a string');
    if (ch === GLOBAL_CHANNEL) return;
    if (!ch.startsWith('session:') || ch.length <= 'session:'.length) throw new BizziError('bad_request', `invalid channel ${ch}`);
    const sessionId = ch.slice('session:'.length);
    if (!this.store.getSession(sessionId) && this.bus.lastSeq(ch) === 0) {
      throw new BizziError('not_found', `session ${sessionId} not found`);
    }
  }

  /** Close every link and client (hub shutdown). */
  closeAll(): void {
    for (const c of [...this.#clients]) c.close(1001, 'hub shutting down');
    for (const l of [...this.#links.values()]) l.close(1001, 'hub shutting down');
  }
}

const WIDGET_KINDS = new Set(['meter', 'text', 'status']);

function isWidgetValue(w: unknown): w is WidgetValue {
  if (!w || typeof w !== 'object') return false;
  const v = w as Partial<WidgetValue>;
  return typeof v.id === 'string' && v.id.length > 0 && typeof v.label === 'string' && WIDGET_KINDS.has(v.kind as string) && Array.isArray(v.placement);
}
