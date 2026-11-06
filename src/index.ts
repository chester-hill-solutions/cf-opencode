import { parseInteractionBody, verifySlackSignature, type SlackEventEnvelope } from "./adapters/slack"
import type { Env } from "./env"
import type { MessageRequest, PermissionRequest, SlackEventRequest } from "./conversation"
import { ACCOUNT_STATE_KEY } from "./conversation"
import { GITHUB_LOGIN_KEY, GITHUB_TOKEN_KEY } from "./vault"
import { MODEL_CATALOG, recommendModel } from "./models"

export { Conversation } from "./conversation"
export { Settings } from "./settings-do"

const DECISIONS = {
  oc_perm_once: "once",
  oc_perm_always: "always",
  oc_perm_reject: "reject",
} as const

const KEY_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/

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
      return handleApi(request, env, url)
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
      const payload = JSON.parse(body) as SlackEventEnvelope
      if (payload.type === "url_verification") {
        return Response.json({ challenge: payload.challenge })
      }

      const event = payload.event
      if (!event?.channel || !event.ts) return new Response("ok")

      const isDm = event.channel_type === "im"
      const replyTs = isDm ? undefined : event.thread_ts ?? event.ts
      const key = isDm ? `${event.channel}:dm` : `${event.channel}:${event.thread_ts ?? event.ts}`

      const dispatch: SlackEventRequest = {
        ...(payload.event_id ? { eventID: payload.event_id } : {}),
        ...(replyTs ? { replyTs } : {}),
        event,
      }
      ctx.waitUntil(
        env.CONVERSATION.getByName(key).fetch("https://conversation/slack", {
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
      if (!decision) return new Response("ok")

      const parsed = JSON.parse(action.value) as { key?: string; requestID?: string }
      if (!parsed.key || !parsed.requestID) return new Response("ok")

      const dispatch: PermissionRequest = { requestID: parsed.requestID, decision }
      ctx.waitUntil(
        env.CONVERSATION.getByName(parsed.key).fetch("https://conversation/permission", {
          method: "POST",
          body: JSON.stringify(dispatch),
        }),
      )
      return new Response("ok")
    }

    return new Response("not found", { status: 404 })
  },
}

/** HTTP/SSE adapter: any client can drive a conversation. */
async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.API_TOKEN) {
    return Response.json({ error: "API_TOKEN is not configured" }, { status: 503 })
  }
  const authorization = request.headers.get("authorization") ?? ""
  if (authorization !== `Bearer ${env.API_TOKEN}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }

  const parts = url.pathname.split("/").filter(Boolean) // api, ...

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

  if (parts[1] === "models" && request.method === "GET") {
    return Response.json({ models: MODEL_CATALOG, recommended: recommendModel().ref })
  }

  if (parts[1] === "settings") {
    const settings = env.SETTINGS.getByName("global")
    if (request.method === "GET") return settings.fetch("https://settings/get")
    if (request.method === "PUT" || request.method === "POST") {
      return settings.fetch("https://settings/put", { method: "POST", body: await request.text() })
    }
    return Response.json({ error: "not found" }, { status: 404 })
  }

  if (parts[1] === "onboarding") return handleOnboarding(request, env, url, parts)

  if (parts[0] !== "api" || parts[1] !== "conversations" || !parts[2]) {
    return Response.json({ error: "not found" }, { status: 404 })
  }
  const key = decodeURIComponent(parts[2])
  if (!KEY_PATTERN.test(key)) return Response.json({ error: "invalid conversation key" }, { status: 400 })

  const conversation = env.CONVERSATION.getByName(key)
  const suffix = parts.slice(3)

  if (request.method === "POST" && suffix.length === 1 && suffix[0] === "messages") {
    const body = (await request.json()) as {
      text?: string
      user?: string
      idempotencyKey?: string
    }
    if (!body.text) return Response.json({ error: "text is required" }, { status: 400 })
    const message: MessageRequest = {
      text: body.text,
      transport: "http",
      ...(body.user ? { user: body.user } : {}),
      ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
    }
    const res = await conversation.fetch("https://conversation/message", {
      method: "POST",
      body: JSON.stringify(message),
    })
    return new Response(res.body, { status: res.status, headers: res.headers })
  }

  if (request.method === "GET" && suffix.length === 1 && suffix[0] === "events") {
    return conversation.fetch("https://conversation/events", {
      headers: { accept: "text/event-stream" },
    })
  }

  if (request.method === "GET" && suffix.length === 1 && suffix[0] === "context") {
    return conversation.fetch("https://conversation/context")
  }

  if (request.method === "GET" && suffix.length === 1 && suffix[0] === "debug") {
    return conversation.fetch("https://conversation/debug")
  }

  if (request.method === "POST" && suffix.length === 1 && suffix[0] === "recycle") {
    return conversation.fetch("https://conversation/recycle", { method: "POST" })
  }

  if (request.method === "DELETE" && suffix.length === 0) {
    return conversation.fetch("https://conversation/delete", { method: "DELETE" })
  }

  if (request.method === "GET" && suffix.length === 0) {
    return conversation.fetch("https://conversation/state")
  }

  if (request.method === "POST" && suffix.length === 2 && suffix[0] === "permissions") {
    const requestID = decodeURIComponent(suffix[1]!)
    const body = (await request.json()) as { decision?: "once" | "always" | "reject" }
    if (!body.decision) return Response.json({ error: "decision is required" }, { status: 400 })
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

async function settingsDo(env: Env, path: string, body?: unknown): Promise<Response> {
  return env.SETTINGS.getByName("global").fetch(`https://settings${path}`, {
    method: body === undefined ? "GET" : "POST",
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
  // OpenCode owns the OAuth attempt and the live model catalogue.
  if (section === "opencode") {
    const path = "/" + parts.slice(3).join("/")
    if (!path || path === "/") return Response.json({ error: "not found" }, { status: 404 })
    const conversation = env.CONVERSATION.getByName(ONBOARDING_KEY)
    const body =
      request.method === "GET" || request.method === "HEAD" ? undefined : await request.text()
    const res = await conversation.fetch(`https://conversation/onboarding${path}`, {
      method: request.method,
      ...(body === undefined ? {} : { body }),
    })
    return new Response(res.body, { status: res.status, headers: res.headers })
  }

  if (section === "reset" && request.method === "POST") {
    const conversation = env.CONVERSATION.getByName(ONBOARDING_KEY)
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
    let snapshot = false
    try {
      const conversation = env.CONVERSATION.getByName(ONBOARDING_KEY)
      const res = await conversation.fetch("https://conversation/onboarding/state-checkpoint")
      if (res.ok) {
        const bytes = await res.arrayBuffer()
        if (bytes.byteLength > 0) {
          await env.CHECKPOINTS.put(ACCOUNT_STATE_KEY, bytes, {
            httpMetadata: { contentType: "application/gzip" },
          })
          snapshot = true
        }
      }
    } catch {
      // A missing state only means the next conversation reconnects.
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

// ---------------------------------------------------------------------- health

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Deep health: configuration and bindings, without starting a container. */
async function healthCheck(env: Env): Promise<Response> {
  const checks: Record<string, { ok: boolean; detail?: string }> = {
    apiToken: { ok: Boolean(env.API_TOKEN) },
    vault: {
      ok: Boolean(env.VAULT_MASTER_KEY),
      ...(env.VAULT_MASTER_KEY ? {} : { detail: "VAULT_MASTER_KEY is not set" }),
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

  const ok = checks.apiToken.ok && checks.checkpoints.ok && checks.settings.ok
  return Response.json({ ok, checks }, { status: ok ? 200 : 503 })
}
