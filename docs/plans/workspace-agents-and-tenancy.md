# Workspace, agents and multitenancy

Status: proposed, 2026-11-18.

This maps the product from one global configuration to tenants, workspaces and
agents. It builds on the dormant naming layer already in `src/tenancy.ts` and
`migrations/0001_tenancy.sql`; it does not replace them.

## 1. Product model

- **Tenant** — the trust and billing boundary. One Slack team (or one paying
  organisation), one set of credentials, one budget, one default policy.
- **Workspace** — the tenant-level configuration surface: access to providers,
  source control, MCP, models, channels and limits. One workspace per tenant.
- **Agent** — a named, bound configuration inside a tenant: model, rules,
  access, repository scope, channel bindings. Work happens under exactly one
  agent.
- **Conversation** — a durable unit of work under one agent. It never moves
  between agents.

Naming warning: the product "agent" is not OpenCode's `agents` map. One product
agent owns one OpenCode runtime, and that runtime may define OpenCode subagents
(`agents` in `opencode.json`). Keep the UI vocabulary separate: "Agent" for the
tenant-bound thing, "Subagent" only inside an agent's runtime.

```
tenant ── workspace (config) ── agents ── conversations
   │                              │
   ├─ providers / MCP / skills    ├─ model, rules, access
   ├─ Slack team + channels       ├─ channel bindings
   ├─ budget, max containers      ├─ repo defaults
   └─ members + API tokens        └─ usage
```

## 2. What exists

| Piece | State |
|---|---|
| `src/tenancy.ts` | Tenant → agent → channel, conversation-key namespacing (`tenant:<t>:agent:<a>:<legacy>`), per-agent account seed key, D1 resolver. Dormant without `TENANCY` or a channel row. |
| `migrations/0001_tenancy.sql` | `tenants`, `agents` (name, repo, branch, model), `channel_bindings`. |
| Settings | One global Durable Object: every call is `SETTINGS.getByName("global")`. Holds `workspaceRepo`, `model`, `permissions`, budget, containers, usage and vault secrets. |
| Auth | One `API_TOKEN` bearer for the whole deployment; MCP optionally falls back to it. |
| Vault | `workspaceID(env) = WORKSPACE_ID ?? "default"`; records are `vault:<workspaceId>:<key>`. |
| Account seed | `accountStateKey()` exists, but `src/index.ts` still writes the legacy `account/state.tar.gz`; only the readiness path reads the namespaced key. |
| R2 checkpoints | `workspaces/<conversation-uuid>/` — the UUID does not carry tenant/agent. |
| UI | One settings page (Connection, Workspace, Model & runtime, Permissions); `/workspace/` is a usage dashboard; no agent entity anywhere. |

## 3. Target

### Storage and identity

- **Settings DO per agent**: `SETTINGS.getByName("tenant:<t>:agent:<a>")`. The
  legacy `global` becomes the `default` agent during migration.
- **D1 owns identity**, not configuration: tenants, agents, bindings, API
  tokens, audit. Configuration stays in the agent's Settings DO so a save keeps
  the existing `version`/restart semantics.
- **Vault workspace id = `<tenant>:<agent>`**. Remove the env fallback once
  tenancy is on; fail closed instead of reading `default`.
- **R2 keys**: `tenants/<t>/agents/<a>/workspaces/<conversation>/...`,
  `.../account/state.tar.gz`. Keep the legacy `account/` and `workspaces/`
  prefixes readable until the backfill ships.
- **Conversation keys** stay namespaced by the existing helper. A conversation's
  agent is derived from the key, never from ambient request state.

### Access

- API tokens are stored hashed in D1 with `tenant_id` and a role
  (`workspace-admin`, `agent-operator`, `agent-readonly`). One token maps to one
  tenant; it cannot address another tenant's agents.
- Slack: the team binding is the tenant; each channel binding is an agent. If
  `TENANCY` is bound and a channel has no binding, fail closed rather than fall
  back to `default`.
- Provider, GitHub, MCP and skill credentials are per agent, read through that
  agent's vault namespace. There is no fallback to a tenant-wide or legacy
  credential — that is how one agent would inherit another's access.
- The non-removable deny floor (deny commands, state root, secrets) stays
  global. An agent's rules may add or narrow; they may not remove it.

### Config mapping

| Product field | OpenCode config |
|---|---|
| Agent model | `model` (provider/model[#variant]) |
| Agent rules | `permissions` (ordered rules; global denies appended last) |
| Tool/provider/MCP/skill access | `policies` (`tool.use`, `provider.use`, `mcp.use`, `skill.use`, …) |
| Subagents | `agents.<id>` (`model`, `permissions`, `system`, `mode`, `steps`) |
| Default agent | `default_agent` |
| Workspace defaults | `WORKSPACE_REPO`/`WORKSPACE_BRANCH` removal; per-conversation selection |

`writeOpencodeConfig()` currently writes only `{ model, permissions }`. It needs
the agent record and the policy set; the container contract already receives
settings through `/configure`.

## 4. Screens

### Workspace (tenant)

- **Access**: Slack installation, GitHub account, provider credentials and live
  model catalogue, MCP servers, skills/plugins.
- **Defaults**: default agent, default model, optional default repository and
  branch.
- **Limits**: tenant daily budget, max concurrent containers, polling and
  streaming.
- **People and tokens**: members, roles, API tokens (create/revoke, last used).
- **Usage**: today's reported spend, reservations, unknown-cost receipts
  (moved from the old `/workspace/` dashboard).

### Agents (tenant)

- **List**: name, model, bound channels, today's spend, last activity, enabled.
- **Editor**:
  - Identity: name, description, enabled, default-agent marker.
  - Model: provider/model/variant, subagent defaults.
  - Rules: presets (`read-only`, `coding`, `research` from
    `docs/plans/agent-permissions-and-transcripts.md`) plus per-agent
    allow/ask/deny patterns.
  - Access: tools, providers, MCP servers, skills, repository scope.
  - Channels: Slack bindings for this agent.
  - Usage: spend, reservations, conversations.
  - Danger: disable, rotate credentials, delete (after its conversations are
    archived).

### Settings and onboarding

- `/settings/` keeps deployment mechanics (API token to the Worker) and can
  redirect into Workspace once tenancy is on.
- Onboarding becomes per tenant: create the tenant, connect access, create the
  first agent, finish. The existing four steps map onto the same data.

## 5. Routes

| Route | Purpose |
|---|---|
| `/workspace/` | Tenant configuration (replaces today's usage dashboard) |
| `/workspace/usage/` | Usage and reservations |
| `/agents/` | Agent list |
| `/agents/<id>/` | Agent editor |
| `/onboarding/` | Per-tenant first run |
| `GET/POST /api/tenants` | Tenant metadata and members |
| `GET/POST /api/agents` | Agent registry |
| `GET/PUT /api/agents/<id>/settings` | Agent configuration (Settings DO) |
| `GET/PUT/DELETE /api/agents/<id>/channels` | Slack bindings |
| `POST /api/tenants/<id>/tokens` | Issue a scoped token |

## 6. Migration phases

0. **Now** — B3 mark and the repo-optional settings/onboarding changes. No
   tenancy behaviour changes.
1. **Agent config storage** — Settings DO per agent, D1 migration `0002`
   (agent columns, tokens, audit), `writeOpencodeConfig` takes the agent record,
   conversation creation records its agent. Backfill `default` → tenant
   `default`, agent `default`.
2. **Auth and onboarding** — hashed tenant tokens, OAuth state carrying the
   tenant, per-agent vault ids.
3. **Screens** — Workspace and Agents, built against the new API. Keep the old
   settings UI as a redirect until the new screens have parity.
4. **Slack** — channel-binding admin, fail-closed unbound channels, per-agent
   Slack credentials if the app limit allows it.
5. **Isolation hardening** — R2 key backfill, legacy seed removal, per-tenant
   usage rollups, audit coverage, delete/export flows.

## 7. Invariants

- A conversation belongs to one agent for life. A cross-namespace resume is a
  bug, not a feature.
- No credential fallback across agents or from agent to legacy.
- The deny floor is not configurable per agent, only extendable.
- Every storage key, R2 key and vault record carries tenant and agent.
- Tenancy-off keeps working: the `default` agent is just another agent.
- Every credential read, binding change and token issue is logged without the
  secret.

## 8. Open decisions

1. Is a tenant exactly one Slack team, or can one team own several tenants?
2. Does an agent own one repository by default, or is repository selection
   always per conversation?
3. Per-agent Slack apps vs one app with channel bindings (workspace app limit).
4. Budget: agent budget with a tenant cap, or a single tenant budget? Recommend
   agent budget plus a tenant cap.
5. Do members exist now, or is a tenant one operator with several tokens?
6. Final route naming: `/workspace/` config + `/workspace/usage/`, or keep
   `/workspace/` for usage and put config under `/settings/`?
7. How the existing production `default` credentials and checkpoints are
   re-keyed (online migration vs export/import).
