/**
 * Tenant → agent → channel identity.
 *
 * Tenancy is deliberately a naming/authorization layer, not a second runtime:
 * a channel binding decides which agent (and therefore which conversation
 * namespace) a Slack event belongs to. The Durable Object already isolates
 * storage by name, so namespacing the conversation key isolates state,
 * checkpoints and account seeds without changing the container model.
 *
 * Dormant by default: without `TENANCY` bound, or without a channel binding,
 * keys stay in the legacy single-tenant form and existing installs keep
 * working during the R1 migration.
 */

export interface AgentRef {  tenantID: string
  agentID: string
}

/** The subset of D1 the resolver needs; keeps tests free of Workers globals. */
export interface TenancyDatabase {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T = unknown>(): Promise<T | null>
    }
  }
}

const TENANT_PREFIX = "tenant:"
const AGENT_SEGMENT = ":agent:"
export const LEGACY_ACCOUNT_STATE_KEY = "account/state.tar.gz"

/** Tenant/agent ids are used in DO names and R2 keys; keep them boring. */
export function validTenantID(value: string | undefined): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value)
}

export function validAgentRef(agent: AgentRef | undefined): agent is AgentRef {
  return Boolean(agent && validTenantID(agent.tenantID) && validTenantID(agent.agentID))
}

/** Prefix that identifies every conversation belonging to one agent. */
export function agentKeyPrefix(agent: AgentRef): string {
  return `${TENANT_PREFIX}${agent.tenantID}${AGENT_SEGMENT}${agent.agentID}:`
}

/** Namespace a legacy conversation key (`channel:thread`) under an agent. */
export function conversationKey(agent: AgentRef, legacyKey: string): string {
  if (!validAgentRef(agent)) throw new Error("invalid tenant/agent id")
  return `${agentKeyPrefix(agent)}${legacyKey}`
}

/** Recover the agent from a namespaced conversation key, if there is one. */
export function parseConversationKey(key: string | undefined): AgentRef | undefined {
  if (!key?.startsWith(TENANT_PREFIX)) return undefined
  const rest = key.slice(TENANT_PREFIX.length)
  const marker = rest.indexOf(AGENT_SEGMENT)
  if (marker <= 0) return undefined
  const tenantID = rest.slice(0, marker)
  const after = rest.slice(marker + AGENT_SEGMENT.length)
  const end = after.indexOf(":")
  if (end <= 0) return undefined
  const agent: AgentRef = { tenantID, agentID: after.slice(0, end) }
  return validAgentRef(agent) ? agent : undefined
}

/**
 * Account seed (provider credentials) for an agent.
 *
 * A namespaced conversation never falls back to the legacy global seed: that
 * would let a newly bound agent inherit another tenant's credentials.
 */
export function accountStateKey(agent: AgentRef | undefined): string {
  return agent && validAgentRef(agent)
    ? `tenants/${agent.tenantID}/agents/${agent.agentID}/account/state.tar.gz`
    : LEGACY_ACCOUNT_STATE_KEY
}

/**
 * Resolve a Slack channel to its agent. Returns undefined when D1 is not bound
 * or the channel has no binding, which the caller treats as legacy mode.
 */
/** The subset of the Worker environment the resolver needs. */
export interface TenancyEnv {
  TENANCY?: TenancyDatabase
}

export async function resolveAgentForChannel(
  env: TenancyEnv,
  teamId: string | undefined,
  channelId: string | undefined,
): Promise<AgentRef | undefined> {  if (!env.TENANCY || !teamId || !channelId) return undefined
  const row = await env.TENANCY.prepare(
    `SELECT a.tenant_id AS tenant_id, a.id AS agent_id
       FROM channel_bindings b
       JOIN agents a ON a.id = b.agent_id
      WHERE b.slack_team_id = ?1 AND b.channel_id = ?2`,
  )
    .bind(teamId, channelId)
    .first<{ tenant_id: string; agent_id: string }>()
  if (!row) return undefined
  const agent: AgentRef = { tenantID: row.tenant_id, agentID: row.agent_id }
  return validAgentRef(agent) ? agent : undefined
}
