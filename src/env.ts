export interface Env {
  /** Slack adapter is optional; without these the Slack routes return 503. */
  SLACK_SIGNING_SECRET?: string
  SLACK_BOT_TOKEN?: string
  /** Bot user id, used to strip mentions and skip our own messages. */
  SLACK_BOT_USER_ID?: string
  CONVERSATION: DurableObjectNamespace
  SETTINGS: DurableObjectNamespace
  WORKSPACE_REPO: string
  OPENCODE_MODEL: string
  POLL_SECONDS: string
  CHECKPOINTS: R2Bucket
  /** Test seam: route container calls to an HTTP origin instead of ctx.container. */
  CONTAINER_URL?: string
  /** Bearer token for the HTTP/SSE adapter. */
  API_TOKEN?: string
  /** GitHub OAuth App, used by the onboarding wizard to clone private repos. */
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  /** 64 hex characters; encrypts provider and GitHub credentials at rest. */
  VAULT_MASTER_KEY?: string
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
