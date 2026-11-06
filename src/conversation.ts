import { DurableObject } from "cloudflare:workers"
import { makeClient, portFetch, type ContainerPort } from "./opencode"
import { ConversationStore, type SlackTarget, type Transport } from "./state"
import {
  chunkText,
  formatSlackContext,
  mrkdwnEscape,
  type SlackContextMessage,
  type SlackEventEnvelope,
} from "./adapters/slack"
import { isSettled, latestAssistantReply, type MessageInfo } from "./messages"
import { formatSse, type ConversationEvent } from "./events"
import { parseModelRef, type Env } from "./env"

const OPENCODE_PORT = 4000
const CONTROL_PORT = 4001
const POLL_MS = 2000

export interface MessageRequest {
  text: string
  user?: string
  transport?: Transport
  slack?: SlackTarget
}

export interface SlackEventRequest {
  eventID?: string
  replyTs?: string
  event: NonNullable<SlackEventEnvelope["event"]>
}

export interface PermissionRequest {
  requestID: string
  decision: "once" | "always" | "reject"
  sessionID?: string
}

/**
 * One Durable Object per conversation. Transport-neutral: every event is
 * emitted to SSE subscribers, and delivered to Slack when a Slack target is set.
 */
export class Conversation extends DurableObject<Env> {
  private readonly store: ConversationStore
  private readonly subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.store = new ConversationStore(ctx.storage)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/message") return this.onMessage((await request.json()) as MessageRequest)
    if (url.pathname === "/slack") return this.onSlackEvent((await request.json()) as SlackEventRequest)
    if (url.pathname === "/permission") return this.onPermission((await request.json()) as PermissionRequest)
    if (url.pathname === "/events") return this.onEvents()
    if (url.pathname === "/state") return Response.json(await this.store.get())
    if (url.pathname === "/health") return Response.json({ ok: true })
    return new Response("not found", { status: 404 })
  }

  // --------------------------------------------------------------- HTTP adapter

  private async onMessage(input: MessageRequest): Promise<Response> {
    const text = input.text.trim()
    if (!text) return Response.json({ ok: false, error: "empty message" }, { status: 400 })

    const sessionID = await this.ensureSession(text, input.transport ?? "http", input.slack)
    const prompt = input.user ? `${input.user}: ${text}` : text
    await this.withClient((client) => client.session.prompt({ sessionID, text: prompt }))
    await this.startRun()
    return Response.json({ ok: true, sessionID })
  }

  // -------------------------------------------------------------- Slack adapter

  private async onSlackEvent(input: SlackEventRequest): Promise<Response> {
    const event = input.event
    if (!event.channel || !event.ts) return Response.json({ ok: true })
    if (event.bot_id || event.subtype) return Response.json({ ok: true })
    if (!event.text) return Response.json({ ok: true })
    if (input.eventID && (await this.store.seenBefore(input.eventID))) return Response.json({ ok: true })

    const text = this.stripMention(event.text)
    if (!text) return Response.json({ ok: true })

    const target: SlackTarget = { channel: event.channel, ...(input.replyTs ? { replyTs: input.replyTs } : {}) }
    const sessionID = await this.ensureSession(text, "slack", target)
    const prompt = await this.buildPrompt(event.channel, event.ts, event.thread_ts, text)
    await this.withClient((client) => client.session.prompt({ sessionID, text: prompt }))
    await this.startRun()
    return Response.json({ ok: true, sessionID })
  }

  private async onPermission(input: PermissionRequest): Promise<Response> {
    const sessionID = (await this.store.takePermission(input.requestID)) ?? input.sessionID
    if (!sessionID) return Response.json({ ok: false, error: "unknown request" }, { status: 404 })
    await this.withClient((client) =>
      client.permission.reply({ sessionID, requestID: input.requestID, decision: input.decision }),
    )
    return Response.json({ ok: true })
  }

  // -------------------------------------------------------------------- SSE

  private onEvents(): Response {
    const encoder = new TextEncoder()
    let ref: ReadableStreamDefaultController<Uint8Array> | undefined
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        ref = controller
        this.subscribers.add(controller)
        controller.enqueue(encoder.encode(": connected\n\n"))
      },
      cancel: () => {
        if (ref) this.subscribers.delete(ref)
      },
    })
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    })
  }

  private emit(event: ConversationEvent): void {
    const chunk = new TextEncoder().encode(formatSse(event))
    for (const controller of this.subscribers) {
      try {
        controller.enqueue(chunk)
      } catch {
        this.subscribers.delete(controller)
      }
    }
  }

  /** Emit to SSE and, when the conversation has a Slack target, post there too. */
  private async deliver(event: ConversationEvent): Promise<void> {
    this.emit(event)
    const state = await this.store.get()
    if (!state.slack || !this.env.SLACK_BOT_TOKEN) return
    if (event.type === "assistant") {
      await this.postChunked(state.slack.channel, event.text, state.slack.replyTs)
    }
    if (event.type === "permission") {
      await this.postPermission(state.slack, event)
    }
  }

  // ------------------------------------------------------------------- prompt

  private async ensureSession(text: string, transport: Transport, slack?: SlackTarget): Promise<string> {
    const state = await this.store.get()
    if (state.sessionID) {
      if (slack && (state.slack?.channel !== slack.channel || state.slack?.replyTs !== slack.replyTs)) {
        state.slack = slack
        await this.store.save(state)
      }
      return state.sessionID
    }

    const session = await this.withClient((client) =>
      client.session.create({
        location: { directory: "/workspace" },
        title: text.replace(/\s+/g, " ").slice(0, 80),
      }),
    )
    const sessionID = (session as { id?: string }).id
    if (!sessionID) throw new Error("session.create returned no id")

    const model = parseModelRef(this.env.OPENCODE_MODEL)
    if (model) {
      await this.withClient((client) => client.session.switchModel({ sessionID, model })).catch(() => {})
    }
    await this.store.setSession(sessionID, transport, slack)
    return sessionID
  }

  private async startRun(): Promise<void> {
    const state = await this.store.get()
    state.lastReply = undefined
    await this.store.save(state)
    await this.ctx.storage.setAlarm(Date.now() + POLL_MS)
  }

  private async buildPrompt(channel: string, ts: string, threadTs: string | undefined, text: string): Promise<string> {
    const messages = await this.fetchContext(channel, ts, threadTs)
    const context = formatSlackContext(messages, {
      botUserId: this.env.SLACK_BOT_USER_ID ?? "",
      excludeTs: ts,
    })
    if (!context) return text
    return [
      `<slack_context channel="${channel}" source="${threadTs ? `thread ${threadTs}` : "recent channel history"}">`,
      context,
      "</slack_context>",
      "",
      "<message>",
      text,
      "</message>",
    ].join("\n")
  }

  private async fetchContext(
    channel: string,
    ts: string,
    threadTs: string | undefined,
  ): Promise<SlackContextMessage[]> {
    try {
      if (threadTs) {
        const res = await this.slack("conversations.replies", { channel, ts: threadTs, limit: 60 })
        return (res.messages ?? []) as SlackContextMessage[]
      }
      const res = await this.slack("conversations.history", { channel, latest: ts, inclusive: false, limit: 20 })
      return ((res.messages ?? []) as SlackContextMessage[]).reverse()
    } catch {
      return []
    }
  }

  // -------------------------------------------------------------- reply pump

  /** One poll per alarm; re-arms itself until the run settles. */
  async alarm(): Promise<void> {
    const state = await this.store.get()
    if (!state.sessionID) return

    const sessionID = state.sessionID
    const messages = (await this.withClient((client) => client.session.context({ sessionID }))) as MessageInfo[]
    const reply = latestAssistantReply(messages)

    if (reply && reply !== state.lastReply) {
      state.lastReply = reply
      await this.store.save(state)
      await this.deliver({ type: "assistant", text: reply })
    }

    await this.pollPermissions(sessionID, state)

    if (isSettled(messages)) {
      await this.deliver({ type: "settled" })
      await this.checkpoint()
      return
    }
    await this.ctx.storage.setAlarm(Date.now() + POLL_MS)
  }

  private async pollPermissions(sessionID: string, state: Awaited<ReturnType<ConversationStore["get"]>>): Promise<void> {
    const pending = (await this.withClient((client) => client.permission.list({ sessionID })).catch(() => [])) ?? []
    for (const request of pending) {
      if (state.pending[request.id]) continue
      state.pending[request.id] = sessionID
      await this.store.save(state)
      await this.deliver({
        type: "permission",
        requestID: request.id,
        action: request.action,
        resources: request.resources,
      })
    }
  }

  // ---------------------------------------------------------------- container

  private async port(number: number): Promise<ContainerPort> {
    const container = this.ctx.container
    if (!container) throw new Error("no container bound")
    if (!container.running) container.start()
    const port = container.getTcpPort(number)
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const res = await port.fetch("http://container/health")
        if (res.ok) return port
      } catch {
        /* not ready yet */
      }
      await sleep(200)
    }
    throw new Error(`container port ${number} did not become ready`)
  }

  private async withClient<T>(fn: (client: ReturnType<typeof makeClient>) => Promise<T>): Promise<T> {
    const port = await this.ensureReady()
    const client = makeClient(portFetch(port))
    return fn(client)
  }

  /** Start the container, restore the checkpoint on first boot, start OpenCode. */
  private async ensureReady(): Promise<ContainerPort> {
    const control = await this.port(CONTROL_PORT)
    const status = (await (await control.fetch("http://container/status")).json()) as { initialized?: boolean }
    if (!status.initialized) {
      const checkpoint = await this.env.CHECKPOINTS.get(this.checkpointKey())
      if (checkpoint?.body) {
        await control.fetch("http://container/restore", { method: "POST", body: checkpoint.body })
      }
    }
    await control.fetch("http://container/start", { method: "POST" })
    const container = this.ctx.container
    if (!container) throw new Error("no container bound")
    return container.getTcpPort(OPENCODE_PORT)
  }

  private checkpointKey(): string {
    return `workspaces/${this.ctx.id.toString()}.tar.gz`
  }

  private async checkpoint(): Promise<void> {
    try {
      const control = await this.port(CONTROL_PORT)
      const response = await control.fetch("http://container/checkpoint")
      if (!response.ok || !response.body) return
      await this.env.CHECKPOINTS.put(this.checkpointKey(), response.body)
    } catch (err) {
      console.warn("checkpoint failed", err)
    }
  }

  // -------------------------------------------------------------------- Slack

  private async postChunked(channel: string, text: string, threadTs?: string): Promise<void> {
    for (const chunk of chunkText(text)) {
      await this.slack("chat.postMessage", {
        channel,
        text: chunk,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      })
    }
  }

  private async postPermission(target: SlackTarget, event: Extract<ConversationEvent, { type: "permission" }>): Promise<void> {
    const key = this.ctx.id.name ?? this.ctx.id.toString()
    const resources = (event.resources ?? []).map((resource) => `• \`${mrkdwnEscape(resource)}\``).join("\n")
    await this.slack("chat.postMessage", {
      channel: target.channel,
      ...(target.replyTs ? { thread_ts: target.replyTs } : {}),
      text: `🔐 Approval needed — ${event.action ?? "unknown action"}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `🔐 *Approval needed* — \`${mrkdwnEscape(event.action ?? "unknown action")}\`\n${resources || "• _(no resources)_"}`,
          },
        },
        {
          type: "actions",
          elements: [
            button("Approve once", "primary", "oc_perm_once", key, event.requestID),
            button("Always allow", undefined, "oc_perm_always", key, event.requestID),
            button("Deny", "danger", "oc_perm_reject", key, event.requestID),
          ],
        },
      ],
    })
  }

  private stripMention(text: string): string {
    const botUserId = this.env.SLACK_BOT_USER_ID
    if (!botUserId) return text.trim()
    return text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim()
  }

  private async slack(method: string, body: Record<string, unknown>): Promise<Record<string, any>> {
    if (!this.env.SLACK_BOT_TOKEN) throw new Error("SLACK_BOT_TOKEN is not configured")
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.env.SLACK_BOT_TOKEN}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    })
    const json = (await res.json()) as { ok?: boolean; error?: string }
    if (!json.ok) throw new Error(`${method}: ${json.error ?? "unknown_error"}`)
    return json as Record<string, any>
  }
}

function button(
  label: string,
  style: "primary" | "danger" | undefined,
  actionID: string,
  key: string,
  requestID: string,
): Record<string, unknown> {
  return {
    type: "button",
    text: { type: "plain_text", text: label },
    ...(style ? { style } : {}),
    action_id: actionID,
    value: JSON.stringify({ key, requestID }),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
