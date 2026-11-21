import { parseInteractionBody, verifySlackSignature, type SlackEventEnvelope } from "./adapters/slack"
import type { SlackEventRequest } from "./conversation"
import type { Env } from "./env"
import { logEvent } from "./log"
import { admitSlackActor } from "./slack-actor"
import { handleSlackCanaryRoute } from "./slack-canary"
import { handleSlackInteraction } from "./slack-interactivity"
import { conversationKey, resolveAgentForChannel } from "./tenancy"
import { conversationStub, settingsDo } from "./worker-routes"

type Event = NonNullable<SlackEventEnvelope["event"]>

const notFound = () => new Response("not found", { status: 404 })
const ok = () => new Response("ok")

/**
 * Slack ingress: signature, canary routing, actor admission, then dispatch to the
 * conversation that owns the thread.
 *
 * It lives outside the Worker entry so the entry stays a router, and it is split
 * by decision rather than by step: who sent this, whether it may act, and which
 * conversation owns the thread.
 */
export async function handleSlackIngress(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  if (request.method !== "POST") return notFound()
  if (!env.SLACK_SIGNING_SECRET) return new Response("slack adapter not configured", { status: 503 })
  const body = await request.text()
  if (!await signedBySlack(request, env.SLACK_SIGNING_SECRET, body)) {
    return new Response("invalid signature", { status: 401 })
  }
  const canary = await routeCanary(env, url, body)
  if (canary) return canary
  if (url.pathname === "/slack/events") return handleEventCallback(body, env, ctx, url)
  if (url.pathname === "/slack/interactivity") return handleInteraction(body, env, ctx)
  return notFound()
}

function signedBySlack(request: Request, secret: string, body: string): Promise<boolean> {
  return verifySlackSignature({
    signingSecret: secret,
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signature: request.headers.get("x-slack-signature"),
    body,
  })
}

/** A canary-claimed thread answers before the ordinary dispatch: the delegation
 * cannot act outside a thread it previously claimed. */
async function routeCanary(env: Env, url: URL, body: string): Promise<Response | undefined> {
  const canaryRoute = (kind: string | null, claim: boolean) => handleSlackCanaryRoute(body, kind, {
    channel: env.SLACK_CANARY_CHANNEL,
    newThreads: claim ? env.SLACK_CANARY_NEW_THREADS : "false",
    startTS: env.SLACK_CANARY_START_TS,
    botUserID: env.SLACK_BOT_USER_ID,
    ownership: (action, channel, threadTs) => canaryOwnership(env, action, channel, threadTs),
  })
  if (url.pathname === "/slack/canary-route") return canaryRoute(url.searchParams.get("kind"), true)
  if (!env.SLACK_CANARY_CHANNEL) return undefined
  if (!["/slack/events", "/slack/interactivity"].includes(url.pathname)) return undefined
  const decision = await canaryRoute(url.pathname === "/slack/events" ? "events" : "interactivity", false)
  if (!decision.ok) return decision
  return (await decision.json() as { route: string }).route === "canary" ? undefined : ok()
}

/** The Settings Durable Object owns canary membership; its answer is authoritative. */
async function canaryOwnership(
  env: Env,
  action: "claim" | "lookup",
  channel: string,
  threadTs: string,
): Promise<boolean> {
  const response = await settingsDo(env, "/slack/canary-thread", { action, channel, threadTs })
  if (!response.ok) throw new Error("Canary ownership unavailable")
  const result: unknown = await response.json()
  if (!result || typeof result !== "object" || Array.isArray(result) ||
    Object.keys(result).length !== 1 || typeof (result as { owned?: unknown }).owned !== "boolean") {
    throw new Error("Invalid canary ownership acknowledgement")
  }
  return (result as { owned: boolean }).owned
}

function parseEnvelope(body: string): SlackEventEnvelope | undefined {
  try {
    return JSON.parse(body) as SlackEventEnvelope
  } catch {
    return undefined
  }
}

/** Self, bot and edit/delete events never start work; the actor rule decides the rest. */
function admitted(env: Env, payload: SlackEventEnvelope, event: Event): boolean {
  const isFileShare = event.subtype === "file_share" && Boolean(event.files?.length)
  if (event.bot_id || (event.subtype && !isFileShare)) return false
  if (env.SLACK_BOT_USER_ID && event.user === env.SLACK_BOT_USER_ID) return false
  return admitSlackActor(env, event, payload.team_id)
}

/** A DM, a mention, or a thread message that is not already a mention of the bot. */
function wantsReply(event: Event, env: Env): boolean {
  if (event.channel_type === "im" || event.type === "app_mention") return true
  if (event.type !== "message" || !event.thread_ts) return false
  return !(env.SLACK_BOT_USER_ID && event.text?.includes(`<@${env.SLACK_BOT_USER_ID}>`))
}

interface ThreadTarget {
  replyTs?: string
  legacyKey: string
}

/** Only a DM, a mention, or a thread the bot is already engaged in becomes work. */
function threadTarget(event: Event, env: Env): ThreadTarget | undefined {
  if (!event.channel || !wantsReply(event, env)) return undefined
  const isDm = event.channel_type === "im"
  const replyTs = isDm ? undefined : event.thread_ts ?? event.ts
  return {
    ...(replyTs ? { replyTs } : {}),
    legacyKey: isDm ? `${event.channel}:dm` : `${event.channel}:${event.thread_ts ?? event.ts}`,
  }
}

/**
 * A channel binding selects the agent, which namespaces the conversation (and so
 * its state, checkpoints and account seed); unbound channels stay on the legacy
 * single-tenant key during the migration.
 */
async function resolveConversationKey(env: Env, teamId: string | undefined, channel: string, legacyKey: string): Promise<string> {
  const agent = await resolveAgentForChannel(env, teamId, channel).catch((error) => {
    logEvent("tenancy.resolve_failed", { error: String(error) })
    return undefined
  })
  if (!agent && env.TENANCY) logEvent("tenancy.unbound", { channel })
  return agent ? conversationKey(agent, legacyKey) : legacyKey
}

async function handleEventCallback(body: string, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const payload = parseEnvelope(body)
  if (!payload) return new Response("invalid json", { status: 400 })
  if (payload.type === "url_verification") return Response.json({ challenge: payload.challenge })
  const event = payload.event
  if (!event?.channel || !event.ts) return ok()
  if (!admitted(env, payload, event)) return ok()
  const target = threadTarget(event, env)
  if (!target) return ok()

  const key = await resolveConversationKey(env, payload.team_id, event.channel, target.legacyKey)
  // The registry is the only way to answer "what conversations exist?".
  ctx.waitUntil(settingsDo(env, "/conversations", { key }).catch(() => undefined))
  const dispatch: SlackEventRequest = {
    appUrl: url.origin,
    ...(payload.event_id ? { eventID: payload.event_id } : {}),
    ...(target.replyTs ? { replyTs: target.replyTs } : {}),
    event,
  }
  ctx.waitUntil(
    conversationStub(env, key).fetch("https://conversation/slack", {
      method: "POST",
      body: JSON.stringify(dispatch),
    }),
  )
  return ok()
}

/** Slack needs an acknowledgement in three seconds: authorization, application and
 * feedback stay in one background operation. */
function handleInteraction(body: string, env: Env, ctx: ExecutionContext): Response {
  ctx.waitUntil(handleSlackInteraction(parseInteractionBody(body), {
    env,
    dispatch: (key, path, value) => conversationStub(env, key).fetch(`https://conversation${path}`, {
      method: "POST", body: JSON.stringify(value),
    }),
  }))
  return ok()
}
