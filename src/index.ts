import { parseInteractionBody, verifySlackSignature, type SlackEventEnvelope } from "./adapters/slack"
import type { Env } from "./env"
import type { MessageRequest, PermissionRequest, SlackEventRequest } from "./conversation"
import { ACCOUNT_STATE_KEY } from "./conversation"
import { GITHUB_LOGIN_KEY, GITHUB_TOKEN_KEY, workspaceID } from "./vault"
import { encryptBytes } from "./archive-crypto"
import { deriveWorkspaceKey } from "@chester-hill-solutions/vault/core"
import type { Alert } from "./alerts"
import { annotate, traceId } from "./telemetry"
import { MODEL_CATALOG, recommendModel } from "./models"
import { isOnboardingProxyPath } from "./onboarding"
import { approvalVerdict, fetchChannelMembers } from "./slack-auth"
import { conversationKey, parseConversationKey, resolveAgentForChannel } from "./tenancy"
import { encryptionRequired, plaintextArchivesAllowed } from "./archive-policy"
import { bearerAuthorized } from "./control-auth"
import { enforceRateLimit } from "./rate-limit"
import { logEvent } from "./log"
import { parseObjectJson } from "./http-json"

export { Conversation } from "./conversation"
export { Settings } from "./settings-do"

const DECISIONS = {
  oc_perm_once: "once",
  oc_perm_always: "always",
  oc_perm_reject: "reject",
} as const

// Tenancy-namespaced keys can exceed 128 chars: `tenant:{64}:agent:{64}:{legacy}`
// where legacy is a Slack `channel:thread` pair (thread_ts has a dot).
// Keep the cap generous but finite. `:` separates segments, `.` appears in thread timestamps.
const KEY_PATTERN = /^[A-Za-z0-9:.\\_-]{1,256}$/

/** Decode a path segment without letting a malformed escape reach the router. */
function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

/** Decode and validate path segments before forwarding them to the container. */
function decodePathSegments(parts: string[]): string | undefined {
  const decoded: string[] = []
  for (const value of parts) {
    const part = safeDecode(value)
    if (part === undefined) return undefined
    if (part === "." || part === ".." || part.includes("/") || part.includes("\\")) return undefined
    decoded.push(part)
  }
  return "/" + decoded.join("/")
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/health") return new Response("ok")

    // GitHub redirects the browser here without our bearer token; the OAuth
    // state value is the credential, and it is single-use.
    if (url.pathname === "/api/onboarding/github/callback") {
      return handleGithubCallback(request, env, url)
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url, ctx)
    }

    if (request.method !== "POST") return new Response("not found", { status: 404 })
    if (!env.SLACK_SIGNING_SECRET) {
      return new Response("slack adapter not configured", { status: 503 })
    }

    const body = await request.text()
    const valid = await verifySlackSignature({
      signingSecret: env.SLACK_SIGNING_SECRET,
      timestamp: request.headers.get("x-slack-request-timestamp"),
      signature: request.headers.get("x-slack-signature"),
      body,
    })
    if (!valid) return new Response("invalid signature", { status: 401 })

    if (url.pathname === "/slack/events") {
      let payload: SlackEventEnvelope
      try {
        payload = JSON.parse(body) as SlackEventEnvelope
      } catch {
        return new Response("invalid json", { status: 400 })
      }
      if (payload.type === "url_verification") {
        return Response.json({ challenge: payload.challenge })
      }

      const event = payload.event
      if (!event?.channel || !event.ts) return new Response("ok")
      if (event.bot_id || event.subtype || (env.SLACK_BOT_USER_ID && event.user === env.SLACK_BOT_USER_ID)) return new Response("ok")

      const isDm = event.channel_type === "im"
      if (!isDm && event.type !== "app_mention" &&
        (event.type !== "message" || !event.thread_ts ||
          (env.SLACK_BOT_USER_ID && event.text?.includes(`<@${env.SLACK_BOT_USER_ID}>`)))) return new Response("ok")
      const replyTs = isDm ? undefined : event.thread_ts ?? event.ts
      const legacyKey = isDm ? `${event.channel}:dm` : `${event.channel}:${event.thread_ts ?? event.ts}`
      // A channel binding selects the agent, which namespaces the conversation
      // (and therefore its state, checkpoints and account seed). Unbound
      // channels stay on the legacy single-tenant key during the migration.
      const agent = await resolveAgentForChannel(env, payload.team_id, event.channel).catch(
        (error) => {
          logEvent("tenancy.resolve_failed", { error: String(error) })
          return undefined
        },
      )
      if (!agent && env.TENANCY) logEvent("tenancy.unbound", { channel: event.channel })
      const key = agent ? conversationKey(agent, legacyKey) : legacyKey

      // The registry is the only way to answer "what conversations exist?";
      // record Slack traffic as well as HTTP traffic.
      ctx.waitUntil(settingsDo(env, "/conversations", { key }).catch(() => undefined))

      const dispatch: SlackEventRequest = {
        appUrl: url.origin,
        ...(payload.event_id ? { eventID: payload.event_id } : {}),
        ...(replyTs ? { replyTs } : {}),
        event,
      }
      ctx.waitUntil(
        conversationStub(env, key).fetch("https://conversation/slack", {
          method: "POST",
          body: JSON.stringify(dispatch),
        }),
      )
      return new Response("ok")
    }

    if (url.pathname === "/slack/interactivity") {
      const payload = parseInteractionBody(body)
      const action = payload?.actions?.[0]
      if (!action?.value || !action.action_id) return new Response("ok")

      const decision = DECISIONS[action.action_id as keyof typeof DECISIONS]
      const formAction = action.action_id === "form_answer" || action.action_id === "form_cancel"
      if (!decision && !formAction) return new Response("ok")

      let parsed: { key?: string; requestID?: string; channel?: string; sessionID?: string; field?: string; value?: string | number | boolean }
      try {
        parsed = JSON.parse(action.value) as typeof parsed
      } catch {
        return new Response("ok")
      }
      if (!parsed.key || !parsed.requestID) return new Response("ok")

      // A namespaced approval must come from the channel bound to the same
      // agent. This stops a button from one tenant's channel being replayed
      // against another tenant's conversation.
      const sourceAgent = parseConversationKey(parsed.key)
      if (sourceAgent) {
        const bound = await resolveAgentForChannel(
          env,
          payload?.team?.id,
          payload?.channel?.id,
        ).catch((error) => {
          logEvent("tenancy.resolve_failed", { error: String(error) })
          return undefined
        })
        if (
          !bound ||
          bound.tenantID !== sourceAgent.tenantID ||
          bound.agentID !== sourceAgent.agentID
        ) {
          logEvent("permission.tenant_mismatch", { channel: payload?.channel?.id })
          return Response.json({
            response_type: "ephemeral",
            text: "This approval belongs to another agent.",
          })
        }
      }

      // A permission decision is only valid from a member of the channel the
      // request was posted in. Anyone in the channel may approve.
      const members = await fetchChannelMembers(
        payload?.channel?.id ?? "",
        env.SLACK_BOT_TOKEN ?? "",
      )
      const verdict = approvalVerdict({
        userId: payload?.user?.id,
        channelId: payload?.channel?.id,
        buttonChannel: parsed.channel,
        members,
      })
      if (verdict !== "allow") {
        logEvent("permission.unverified", { verdict })
        const text =
          verdict === "wrong_channel"
            ? "This approval belongs to another channel."
            : verdict === "deny"
              ? "Only members of this channel can approve this request."
              : "Couldn't verify channel membership; check the Slack app scopes."
        return Response.json({ response_type: "ephemeral", text })
      }

      if (formAction) {
        if (typeof parsed.sessionID !== "string" || !parsed.channel) return new Response("invalid question", { status: 400 })
        ctx.waitUntil(
          conversationStub(env, parsed.key).fetch("https://conversation/form", {
            method: "POST",
            body: JSON.stringify({
              sessionID: parsed.sessionID, formID: parsed.requestID, channel: payload?.channel?.id,
              ...(action.action_id === "form_cancel" ? { cancel: true } : { field: parsed.field, value: parsed.value }),
            }),
          }),
        )
        return new Response("ok")
      }
      const dispatch: PermissionRequest = { requestID: parsed.requestID, decision: decision! }
      ctx.waitUntil(
        conversationStub(env, parsed.key).fetch("https://conversation/permission", {
          method: "POST",
          body: JSON.stringify(dispatch),
        }),
      )
      return new Response("ok")
    }

    return new Response("not found", { status: 404 })
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(checkAlerts(env))
  },
}

/**
 * Conversation DO handle that carries the key with every call. Durable Objects
 * cannot look up their own name, and the DO needs it to exempt admin traffic
 * from the container cap.
 */
function conversationStub(env: Env, key: string) {
  const stub = env.CONVERSATION.getByName(key)
  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      headers.set("x-conversation-key", key)
      return stub.fetch(input, { ...init, headers })
    },
  }
}

/** HTTP/SSE adapter: any client can drive a conversation. */
async function handleApi(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!env.API_TOKEN) {
    return Response.json({ error: "API_TOKEN is not configured" }, { status: 503 })
  }
  const authorization = request.headers.get("authorization") ?? ""
  if (!bearerAuthorized(authorization, env.API_TOKEN)) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }

  const parts = url.pathname.split("/").filter(Boolean) // api, ...

  // Message creation is the cost-driving endpoint; keep it behind the
  // per-client rate limit before any container work is scheduled.
  if (request.method === "POST" && parts[1] === "conversations" && parts[3] === "messages") {
    const limited = await enforceRateLimit(env.API_RATE_LIMIT, request, "messages")
    if (limited) return limited
  }

  if (parts[1] === "health" && request.method === "GET") {
    return healthCheck(env)
  }

  if (parts[1] === "usage" && request.method === "GET") {
    const [today, settings] = await Promise.all([
      settingsDo(env, "/usage/today"),
      settingsDo(env, "/get"),
    ])
    const usage = (await today.json()) as Record<string, unknown>
    const current = (await settings.json()) as { dailyBudgetUSD?: number }
    return Response.json({ ...usage, budgetUSD: current.dailyBudgetUSD ?? 0 })
  }

  if (parts[1] === "metrics" && request.method === "GET") {
    return settingsDo(env, `/metrics${url.search}`)
  }

  if (parts[1] === "leases" && request.method === "GET") {
    return settingsDo(env, "/leases")
  }

  if (parts[1] === "alerts" && parts[2] === "check" && request.method === "POST") {
    return checkAlerts(env)
  }

  if (parts[1] === "alerts" && request.method === "GET") {
    return settingsDo(env, "/alerts")
  }

  if (parts[1] === "alerts" && request.method === "DELETE") {
    return settingsDo(env, `/alerts${url.search}`, undefined, "DELETE")
  }

  if (parts[1] === "models" && request.method === "GET") {
    return Response.json({ models: MODEL_CATALOG, recommended: recommendModel().ref })
  }

  if (parts[1] === "settings") {
    const settings = env.SETTINGS.getByName("global")
    if (request.method === "GET") return settings.fetch("https://settings/get")
    if (request.method === "PUT" || request.method === "POST") {
      const parsed = await parseObjectJson(request)
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 })
      return settings.fetch("https://settings/put", {
        method: "POST",
        body: JSON.stringify(parsed.value),
      })
    }
    return Response.json({ error: "not found" }, { status: 404 })
  }

  if (parts[1] === "onboarding") return handleOnboarding(request, env, url, parts)

  if (parts[1] === "conversations" && parts.length === 2 && request.method === "GET") {
    return settingsDo(env, "/conversations")
  }

  if (parts[0] !== "api" || parts[1] !== "conversations" || !parts[2]) {
    return Response.json({ error: "not found" }, { status: 404 })
  }
  const key = safeDecode(parts[2])
  if (!key || !KEY_PATTERN.test(key)) {
    return Response.json({ error: "invalid conversation key" }, { status: 400 })
  }
  annotate({ "conversation.key": key, "http.route": `/api/conversations/{key}/${suffixLabel(parts)}` })
  const recordConversation = () =>
    ctx.waitUntil(settingsDo(env, "/conversations", { key }).catch(() => undefined))

  const conversation = conversationStub(env, key)
  const suffix = parts.slice(3)

  if (suffix.length === 1 && suffix[0] === "recovery") {
    if (request.method === "GET") {
      // Passive recovery inspection must not register the conversation.
      return conversation.fetch("https://conversation/recovery")
    }
    if (request.method === "POST") {
      const parsed = await parseObjectJson(request)
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 })
      const action = parsed.value.action
      const expectedSnapshotID = parsed.value.expectedSnapshotID
      if (Object.keys(parsed.value).some((field) => field !== "action" && field !== "expectedSnapshotID") ||
        (action !== "retry" && action !== "cancel_before_dispatch") ||
        typeof expectedSnapshotID !== "string" || !/^[a-f0-9]{64}$/.test(expectedSnapshotID)) {
        return Response.json({ error: "action and SHA-256 expectedSnapshotID are required" }, { status: 400 })
      }
      const response = await conversation.fetch("https://conversation/recovery", {
        method: "POST",
        body: JSON.stringify({ action, expectedSnapshotID }),
      })
      return new Response(response.body, { status: response.status, headers: response.headers })
    }
    return Response.json({ error: "method not allowed" }, { status: 405 })
  }

  if (suffix.length === 2 && suffix[0] === "accounting" && suffix[1] === "cutover") {
    if (request.method === "GET") {
      // Read-only planning must not create/update the conversation registry.
      return conversation.fetch("https://conversation/accounting/cutover")
    }
    if (request.method === "POST") {
      const parsed = await parseObjectJson(request)
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 })
      const expectedPlanID = parsed.value.expectedPlanID
      if (typeof expectedPlanID !== "string" || !/^[a-f0-9]{64}$/.test(expectedPlanID)) {
        return Response.json({ error: "expectedPlanID must be a SHA-256 plan id" }, { status: 400 })
      }
      const response = await conversation.fetch("https://conversation/accounting/cutover", {
        method: "POST",
        body: JSON.stringify({ expectedPlanID }),
      })
      if (response.ok) recordConversation()
      return new Response(response.body, { status: response.status, headers: response.headers })
    }
    return Response.json({ error: "method not allowed" }, { status: 405 })
  }

  if (request.method === "POST" && suffix.length === 1 && suffix[0] === "messages") {
    const parsed = await parseObjectJson(request)
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 })
    const body = parsed.value
    if (body.user !== undefined && typeof body.user !== "string") {
      return Response.json({ error: "invalid user" }, { status: 400 })
    }
    if (body.idempotencyKey !== undefined && typeof body.idempotencyKey !== "string") {
      return Response.json({ error: "invalid idempotencyKey" }, { status: 400 })
    }
    if (typeof body.idempotencyKey === "string" && body.idempotencyKey && !/^[A-Za-z0-9:_-]{1,128}$/.test(body.idempotencyKey)) {
      return Response.json({ error: "invalid idempotencyKey" }, { status: 400 })
    }
    if (body.text === undefined) return Response.json({ error: "text is required" }, { status: 400 })
    if (typeof body.text !== "string" || !body.text.trim()) {
      return Response.json({ error: "empty message" }, { status: 400 })
    }
    recordConversation()
    const message: MessageRequest = {
      text: body.text,
      transport: "http",
      ...(body.user ? { user: body.user as string } : {}),
      ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey as string } : {}),
    }
    const res = await conversation.fetch("https://conversation/message", {
      method: "POST",
      body: JSON.stringify(message),
    })
    return new Response(res.body, { status: res.status, headers: res.headers })
  }

  if (request.method === "GET" && suffix.length === 1 && suffix[0] === "events") {
    recordConversation()
    return conversation.fetch("https://conversation/events", {
      headers: { accept: "text/event-stream" },
    })
  }

  if (request.method === "GET" && suffix.length === 1 && suffix[0] === "context") {
    recordConversation()
    return conversation.fetch("https://conversation/context")
  }

  if (request.method === "GET" && suffix.length === 1 && suffix[0] === "debug") {
    recordConversation()
    return conversation.fetch("https://conversation/debug")
  }

  if (request.method === "GET" && suffix.join("/") === "debug/messages") {
    recordConversation()
    return conversation.fetch("https://conversation/debug/messages")
  }

  if (request.method === "GET" && suffix.join("/") === "debug/providers") {
    return conversation.fetch("https://conversation/debug/providers")
  }

  if (request.method === "POST" && suffix.join("/") === "debug/snapshot/invalidate") {
    recordConversation()
    return conversation.fetch("https://conversation/debug/snapshot/invalidate", { method: "POST" })
  }

  if (request.method === "POST" && suffix.length === 1 && suffix[0] === "recycle") {
    recordConversation()
    return conversation.fetch("https://conversation/recycle", { method: "POST" })
  }

  if (request.method === "DELETE" && suffix.length === 0) {
    recordConversation()
    const res = await conversation.fetch("https://conversation/delete", { method: "DELETE" })
    if (res.ok) await settingsDo(env, "/conversations/delete", { key }).catch(() => undefined)
    return res
  }

  if (request.method === "GET" && suffix.length === 0) {
    recordConversation()
    return conversation.fetch("https://conversation/state")
  }

  if (request.method === "POST" && suffix.length === 2 && suffix[0] === "permissions") {
    const requestID = safeDecode(suffix[1]!)
    if (!requestID) return Response.json({ error: "invalid request id" }, { status: 400 })
    const parsed = await parseObjectJson(request)
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 })
    const body = parsed.value as { decision?: "once" | "always" | "reject" }
    if (body.decision !== "once" && body.decision !== "always" && body.decision !== "reject") {
      return Response.json({ error: "decision is required" }, { status: 400 })
    }
    recordConversation()
    const res = await conversation.fetch("https://conversation/permission", {
      method: "POST",
      body: JSON.stringify({ requestID, decision: body.decision } satisfies PermissionRequest),
    })
    return new Response(res.body, { status: res.status, headers: res.headers })
  }

  return Response.json({ error: "not found" }, { status: 404 })
}

// ------------------------------------------------------------------ onboarding

const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize"
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
const GITHUB_USER_URL = "https://api.github.com/user"
/** The conversation DO whose container performs provider onboarding. */
const ONBOARDING_KEY = "onboarding"

async function settingsDo(
  env: Env,
  path: string,
  body?: unknown,
  method?: string,
): Promise<Response> {
  return env.SETTINGS.getByName("global").fetch(`https://settings${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function handleOnboarding(
  request: Request,
  env: Env,
  url: URL,
  parts: string[],
): Promise<Response> {
  const section = parts[2]

  if (section === "status" && request.method === "GET") {
    const settings = (await (await settingsDo(env, "/get")).json()) as {
      onboarding?: Record<string, unknown>
      workspaceRepo?: string
      workspaceBranch?: string
      model?: string
    }
    const secrets = (await (await settingsDo(env, "/secrets")).json().catch(() => ({}))) as {
      keys?: string[]
    }
    const keys = secrets.keys ?? []
    return Response.json({
      configured: {
        github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
        vault: Boolean(env.VAULT_MASTER_KEY),
      },
      onboarding: settings.onboarding ?? {},
      workspace: {
        repo: settings.workspaceRepo ?? "",
        branch: settings.workspaceBranch ?? "main",
      },
      model: settings.model ?? "",
      secrets: {
        github: keys.includes(GITHUB_TOKEN_KEY),
      },
    })
  }

  // Provider onboarding is proxied into the conversation container, where
  // OpenCode owns the OAuth attempt and the live model catalogue. Only the
  // wizard's own endpoints are reachable; control-plane routes are internal.
  if (section === "opencode") {
    const path = decodePathSegments(parts.slice(3))
    if (!path || !isOnboardingProxyPath(path, request.method)) {
      return Response.json({ error: "not found" }, { status: 404 })
    }
    if (request.method === "POST" && path.startsWith("/integrations/")) {
      const parsed = await parseObjectJson(request.clone())
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 })
    }
    const conversation = conversationStub(env, ONBOARDING_KEY)
    const body =
      request.method === "GET" || request.method === "HEAD" ? undefined : await request.text()
    const res = await conversation.fetch(`https://conversation/onboarding${path}`, {
      method: request.method,
      ...(body === undefined ? {} : { body }),
    })
    const headers = new Headers(res.headers)
    headers.delete("content-encoding")
    headers.delete("content-length")
    return new Response(res.body, { status: res.status, headers })
  }

  if (section === "reset" && request.method === "POST") {
    const conversation = conversationStub(env, ONBOARDING_KEY)
    const res = await conversation.fetch("https://conversation/reset", { method: "POST" })
    return new Response(res.body, { status: res.status, headers: res.headers })
  }

  if (section === "github" && parts[3] === "start" && request.method === "GET") {
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
      return Response.json(
        { error: "GitHub OAuth is not configured", configured: false },
        { status: 503 },
      )
    }
    const state = crypto.randomUUID().replace(/-/g, "")
    await settingsDo(env, "/oauth-state", { state })
    const redirect = `${url.origin}/api/onboarding/github/callback`
    const authorize = new URL(GITHUB_AUTHORIZE)
    authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID)
    authorize.searchParams.set("redirect_uri", redirect)
    authorize.searchParams.set("scope", "repo read:user")
    authorize.searchParams.set("state", state)
    return Response.json({ url: authorize.toString(), redirect })
  }

  if (section === "github" && parts[3] === "disconnect" && request.method === "POST") {
    await settingsDo(env, "/secrets/delete", { key: GITHUB_TOKEN_KEY })
    await settingsDo(env, "/secrets/delete", { key: GITHUB_LOGIN_KEY })
    await settingsDo(env, "/onboarding", { githubConnectedAt: undefined, githubLogin: undefined })
    return Response.json({ ok: true })
  }

  // Persist the account state (OpenCode config + credentials) so every new
  // conversation starts already connected.
  if (section === "finish" && request.method === "POST") {
    // The wizard disables Finish without a provider; enforce it on the server
    // too, since the API is reachable directly.
    const current = (await (await settingsDo(env, "/get")).json()) as {
      onboarding?: { opencodeConnectedAt?: number }
    }
    if (!current.onboarding?.opencodeConnectedAt) {
      const conversation = conversationStub(env, ONBOARDING_KEY)
      // Ask the owning runtime for a small serialized status, rather than
      // parsing a forwarded (possibly compressed) provider response across DOs.
      const status = await conversation.fetch("https://conversation/provider-status")
      if (!status.ok) {
        return Response.json(
          { error: "provider status unavailable", retryable: true },
          { status: 503 },
        )
      }
      const body = (await status.json()) as { connected?: boolean }
      if (body.connected !== true) {
        return Response.json({ error: "connect a provider before finishing" }, { status: 400 })
      }
    }

    let snapshot = false
    // The account snapshot carries provider credentials. Without a vault key it
    // is skipped rather than written to R2 in plaintext; the next conversation
    // simply reconnects the provider.
    if (encryptionRequired(env)) {
      logEvent("onboarding.snapshot.skipped", { reason: "vault_key_missing" })
    } else {
      try {
        const conversation = conversationStub(env, ONBOARDING_KEY)
        const res = await conversation.fetch("https://conversation/onboarding/state-checkpoint")
        if (res.ok) {
          const bytes = await res.arrayBuffer()
          if (bytes.byteLength > 0) {
            const master = env.VAULT_MASTER_KEY
            const key = master ? await deriveWorkspaceKey(master, workspaceID(env)) : undefined
            const stored = key
              ? await encryptBytes(new Uint8Array(bytes), key)
              : new Uint8Array(bytes)
            await env.CHECKPOINTS.put(ACCOUNT_STATE_KEY, stored, {
              httpMetadata: { contentType: "application/gzip" },
              ...(key ? { customMetadata: { encrypted: "1" } } : {}),
            })
            snapshot = true
          }
        }
      } catch {
        // A missing state only means the next conversation reconnects.
      }
    }
    const now = Date.now()
    await settingsDo(env, "/onboarding", {
      completedAt: now,
      ...(snapshot ? { opencodeConnectedAt: now } : {}),
    })
    return Response.json({ ok: true, snapshot })
  }

  return Response.json({ error: "not found" }, { status: 404 })
}

async function handleGithubCallback(request: Request, env: Env, url: URL): Promise<Response> {
  const back = (status: string) =>
    Response.redirect(`${url.origin}/onboarding/?step=github&status=${status}`, 302)

  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  if (!code || !state) return back("cancelled")
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return back("unconfigured")

  const consumed = (await (await settingsDo(env, "/oauth-state/consume", { state })).json()) as {
    valid?: boolean
  }
  if (!consumed.valid) return back("invalid_state")

  const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  })
  const tokenBody = (await tokenResponse.json().catch(() => ({}))) as { access_token?: string }
  if (!tokenBody.access_token) return back("denied")

  let login: string | undefined
  try {
    const user = await fetch(GITHUB_USER_URL, {
      headers: {
        authorization: `Bearer ${tokenBody.access_token}`,
        accept: "application/vnd.github+json",
        "user-agent": "aboiteau",
      },
    })
    if (user.ok) login = ((await user.json()) as { login?: string }).login
  } catch {
    // The token still works for cloning without a display name.
  }

  await settingsDo(env, "/secrets/put", { key: GITHUB_TOKEN_KEY, value: tokenBody.access_token })
  if (login) await settingsDo(env, "/secrets/put", { key: GITHUB_LOGIN_KEY, value: login })
  await settingsDo(env, "/onboarding", {
    githubConnectedAt: Date.now(),
    ...(login ? { githubLogin: login } : {}),
  })
  return back("connected")
}

// ---------------------------------------------------------------------- alerts

/** Compare today's counters and spend against the last reported values. */
async function checkAlerts(env: Env): Promise<Response> {
  const [metricsRes, usageRes, leasesRes, settingsRes] = await Promise.all([
    settingsDo(env, "/metrics"),
    settingsDo(env, "/usage/today"),
    settingsDo(env, "/leases"),
    settingsDo(env, "/get"),
  ])
  const metricsBody = (await metricsRes.json().catch(() => ({}))) as {
    metrics?: Record<string, number>
  }
  const usageBody = (await usageRes.json().catch(() => ({}))) as { costUSD?: number }
  const leasesBody = (await leasesRes.json().catch(() => ({}))) as {
    cap?: number
    active?: unknown[]
  }
  const settingsBody = (await settingsRes.json().catch(() => ({}))) as { dailyBudgetUSD?: number }

  const checked = await settingsDo(env, "/alerts/check", {
    metrics: metricsBody.metrics ?? {},
    spendUSD: usageBody.costUSD ?? 0,
    budgetUSD: settingsBody.dailyBudgetUSD ?? 0,
    leases: {
      cap: leasesBody.cap ?? 0,
      active: Array.isArray(leasesBody.active) ? leasesBody.active.length : 0,
    },
  })
  const body = (await checked.json()) as { date: string; alerts: Alert[] }
  for (const alert of body.alerts) await postAlert(env, alert)
  return Response.json(body)
}

/** Post to Slack when a bot token and alert channel are configured. */
async function postAlert(env: Env, alert: Alert): Promise<void> {
  if (!env.SLACK_BOT_TOKEN || !env.ALERT_CHANNEL) return
  try {
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ channel: env.ALERT_CHANNEL, text: `:warning: ${alert.message}` }),
    })
  } catch {
    /* alerts are best effort */
  }
}

// ---------------------------------------------------------------------- health

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Deep health: configuration and bindings, without starting a container. */
/** Route shape for span attributes, e.g. `messages` or `debug/messages`. */
function suffixLabel(parts: string[]): string {
  const suffix = parts.slice(3)
  if (suffix.length === 0) return "state"
  return suffix.map((part, index) => (index === 0 ? part : "{value}")).join("/")
}

async function healthCheck(env: Env): Promise<Response> {
  const checks: Record<string, { ok: boolean; detail?: string }> = {
    apiToken: { ok: Boolean(env.API_TOKEN) },
    vault: {
      ok: Boolean(env.VAULT_MASTER_KEY) || plaintextArchivesAllowed(env),
      ...(env.VAULT_MASTER_KEY || plaintextArchivesAllowed(env)
        ? {}
        : {
            detail:
              "VAULT_MASTER_KEY is not set; checkpoints and account seeds are disabled (set ALLOW_PLAINTEXT_ARCHIVES=1 to override)",
          }),
    },
    github: {
      ok: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
      ...(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
        ? {}
        : { detail: "GitHub OAuth is not configured" }),
    },
  }

  try {
    await env.CHECKPOINTS.list({ limit: 1 })
    checks.checkpoints = { ok: true }
  } catch (error) {
    checks.checkpoints = { ok: false, detail: detail(error) }
  }

  try {
    const response = await env.SETTINGS.getByName("global").fetch("https://settings/get")
    checks.settings = response.ok
      ? { ok: true }
      : { ok: false, detail: `status ${response.status}` }
  } catch (error) {
    checks.settings = { ok: false, detail: detail(error) }
  }

  const ok = checks.apiToken.ok && checks.vault.ok && checks.checkpoints.ok && checks.settings.ok
  const trace = traceId()
  return Response.json({ ok, checks, ...(trace ? { traceId: trace } : {}) }, { status: ok ? 200 : 503 })
}
