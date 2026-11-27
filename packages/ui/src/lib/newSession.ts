// What a new session starts with when nobody fills in the form: the agent the New session form preselects
// and the session.create params of a profile. Shared by the form and the "New session" hotkey (⌘T).
import type { AgentListing, AgentProfile, MethodParams, SessionMode } from '@bizzi/protocol';

/** The agent the form preselects: signed in, supported, structured-capable; else the first installed one. */
export function defaultAgent(agents: readonly AgentListing[] | null | undefined): AgentListing | undefined {
  const installed = (agents ?? []).filter((a) => a.installed);
  return (
    installed.find((a) => a.auth === 'ok' && a.support !== 'unsupported' && a.capabilities?.modes.includes('structured')) ??
    installed.find((a) => a.auth === 'ok' && a.capabilities?.modes.includes('structured')) ??
    installed[0]
  );
}

/** The agent's modes; agents that don't say get structured. */
export function agentModes(listing: AgentListing | undefined): SessionMode[] {
  const modes = listing?.capabilities?.modes;
  return modes && modes.length ? modes : ['structured'];
}

/** The profile's mode when the agent has it, else structured when it has that, else its first mode. */
export function resolveMode(wanted: SessionMode | '' | undefined, modes: readonly SessionMode[]): SessionMode {
  if (wanted && modes.includes(wanted)) return wanted;
  return modes.includes('structured') ? 'structured' : (modes[0] ?? 'structured');
}

/** session.create params for a profile as is (the form's Start session with nothing changed). */
export function profileSessionParams(workspaceId: string, listing: AgentListing, profile: AgentProfile): MethodParams<'session.create'> {
  const caps = listing.capabilities;
  const mode = resolveMode(profile.mode, agentModes(listing));
  const params: MethodParams<'session.create'> = { workspaceId, agent: listing.agent, mode };
  if (mode !== 'structured') {
    params.cols = 100;
    params.rows = 30;
    return params;
  }
  if (profile.model?.trim()) params.model = profile.model.trim();
  if (profile.permissionMode && (!caps || caps.permissionModes.includes(profile.permissionMode))) params.permissionMode = profile.permissionMode;
  if (profile.effort && (!caps?.effort || caps.effort.includes(profile.effort))) params.effort = profile.effort;
  return params;
}
