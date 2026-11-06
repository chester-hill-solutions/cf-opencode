import { parseInteractionBody, verifySlackSignature, type SlackEventEnvelope } from "./adapters/slack"
import type { Env } from "./env"
import type { MessageRequest, PermissionRequest, SlackEventRequest } from "./conversation"
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

  if (parts[0] !== "api" || parts[1] !== "conversations" || !parts[2]) {
    return Response.json({ error: "not found" }, { status: 404 })
  }
  const key = decodeURIComponent(parts[2])
  if (!KEY_PATTERN.test(key)) return Response.json({ error: "invalid conversation key" }, { status: 400 })

  const conversation = env.CONVERSATION.getByName(key)
  const suffix = parts.slice(3)

  if (request.method === "POST" && suffix.length === 1 && suffix[0] === "messages") {
    const body = (await request.json()) as { text?: string; user?: string }
    if (!body.text) return Response.json({ error: "text is required" }, { status: 400 })
    const message: MessageRequest = { text: body.text, transport: "http", ...(body.user ? { user: body.user } : {}) }
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
