export interface Env {
  /** First provider-proxy credential; read by the Worker entrypoint only. */
  PROVIDER_PROXY_API_KEY?: string
  /** Durable pending-message capacity, integer 1..100; default 10. */
  QUEUE_LIMIT?: string
  /** Decision model for the post-turn memory filter. All three or none; no host in code. */
  DECISION_URL?: string
  DECISION_API_KEY?: string
  DECISION_MODEL?: string
  /** Slack adapter is optional; without these the Slack routes return 503. */
  SLACK_SIGNING_SECRET?: string
  SLACK_BOT_TOKEN?: string
  /** Bot user id, used to strip mentions and skip our own messages. */
  SLACK_BOT_USER_ID?: string
  CONVERSATION: DurableObjectNamespace<import("./conversation").Conversation>
  SETTINGS: DurableObjectNamespace<import("./settings-do").Settings>
  WORKSPACE_REPO?: string
  WORKSPACE_BRANCH?: string
  OPENCODE_MODEL: string
  POLL_SECONDS: string
  /** Exact DO key allowed to select the isolated event-retention canary image. */
  EVENTED_CANARY_KEY?: string
  /** Opt in only never-started conversations to the persistent-event image. */
  EVENTED_FRESH_CONVERSATIONS?: string
  /** Seconds an unused runtime stays warm; production sets 300, code defaults to 30. */
  IDLE_CLOSE_SECONDS?: string
  /** Optional container size profile; defaults to custom-1cpu-2gib. */
  CONTAINER_INSTANCE_PROFILE?: string
  CHECKPOINTS: R2Bucket
  /** Optional D1 database holding tenants, agents and channel bindings. */
  TENANCY?: import("./tenancy").TenancyDatabase
  /** Test seam: route container calls to an HTTP origin instead of ctx.container. */
  CONTAINER_URL?: string
  /** Bearer token for the HTTP/SSE adapter. */
  API_TOKEN?: string
  /** Opt in to the MCP connector; absent means the route does not exist. */
  MCP_ENABLED?: string
  /** MCP bearer token; falls back to API_TOKEN so it can be revoked alone. */
  MCP_TOKEN?: string
  /** Separate host-only capability. Never forwarded into an agent or checker. */
  CHECK_COLLECTOR_TOKEN?: string
  CHECK_COLLECTOR_ID?: string
  CHECK_RUNNER_IMAGE_ID?: string
  /** Collector image's actual architecture, not the agent VM architecture. */
  CHECK_RUNNER_PLATFORM?: string
  CHECK_RUNNER_TIMEOUT_MS?: string
  CHECK_SLACK_CHANNEL_ID?: string
  /** Signed legacy-router probe: restrict new thread ownership to this channel. */
  SLACK_CANARY_CHANNEL?: string
  SLACK_CANARY_NEW_THREADS?: string
  SLACK_CANARY_START_TS?: string
  /** Cloudflare rate-limit binding for message creation; optional in tests. */
  API_RATE_LIMIT?: RateLimit
  /** GitHub OAuth App, used by the onboarding wizard to clone private repos. */
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  /** Slack channel for threshold alerts; posting also needs SLACK_BOT_TOKEN. */
  ALERT_CHANNEL?: string
  /** Human-needed alerts go here only; the routine channel is ALERT_CHANNEL. */
  ESCALATION_CHANNEL?: string
  /** 64 hex characters; encrypts provider and GitHub credentials at rest. */
  VAULT_MASTER_KEY?: string
  /** Comma separated retained secrets; read-only, used to decrypt older archives. */
  VAULT_MASTER_KEY_PREVIOUS?: string
  /**
   * Explicit opt-out of archive encryption. Without a vault key, checkpoints
   * and account seeds fail closed unless this is exactly "1".
   */
  ALLOW_PLAINTEXT_ARCHIVES?: string
  /** Tenant key for stored credentials. Defaults to "default" (single tenant). */
  WORKSPACE_ID?: string
}

/** Model reference in provider/model[#variant] form. */
export function parseModelRef(ref: string | undefined): { providerID: string; id: string; variant?: string } | undefined {
  if (!ref) return undefined
  const [modelPart, variant] = ref.split("#", 2)
  const slash = modelPart.indexOf("/")
  if (slash <= 0 || slash === modelPart.length - 1) return undefined
  const providerID = modelPart.slice(0, slash)
  const id = modelPart.slice(slash + 1)
  return variant ? { providerID, id, variant } : { providerID, id }
}
