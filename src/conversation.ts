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
import { createSseParser } from "./sse"
import { parseModelRef, type Env } from "./env"
import { withRetries } from "./retry"
import type { HarnessSettings } from "./settings"

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
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private streaming = false
  private pumping = false
  private consecutiveFailures = 0

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.store = new ConversationStore(ctx.storage)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/message") return this.onMessage((await request.json()) as MessageRequest)
    if (url.pathname === "/slack") return this.onSlackEvent((await request.json()) as SlackEventRequest)
    if (url.pathname === "/permission") return this.onPermission((await request.json()) as PermissionRequest)
    if (url.pathname === "/events") return this.onEvents(request)
    if (url.pathname === "/state") return Response.json(await this.store.get())
    if (url.pathname === "/health") return Response.json({ ok: true })
    return new Response("not found", { status: 404 })
  }

  // --------------------------------------------------------------- HTTP adapter

  private async onMessage(input: MessageRequest): Promise<Response> {
    const text = input.text.trim()
    if (!text) return Response.json({ ok: false, error: "empty message" }, { status: 400 })

    try {
      const sessionID = await this.ensureSession(text, input.transport ?? "http", input.slack)
      const prompt = input.user ? `${input.user}: ${text}` : text
      await this.withClient((client) => client.session.prompt({ sessionID, text: prompt }))
      await this.startRun()
      const settings = await this.settings()
      if (settings.streaming) this.ctx.waitUntil(this.startStream(sessionID))
      return Response.json({ ok: true, sessionID })
    } catch (err) {
      return Response.json({ ok: false, error: errorMessage(err) }, { status: 500 })
    }
  }

  private async settings(): Promise<HarnessSettings> {
    const res = await this.env.SETTINGS.getByName("global").fetch("https://settings/get")
    return (await res.json()) as HarnessSettings
  }

  // -------------------------------------------------------------- Slack adapter

  private async onSlackEvent(input: SlackEventRequest): Promise<Response> {
    const event = input.event
    if (!event.channel || !event.ts) return Response.json({ ok: true })
    if (event.bot_id || event.subtype) return Response.json({ ok: true })
    if (!event.text) return Response.json({ ok: true })
    if (input.eventID && !(await this.store.claimEvent(input.eventID))) return Response.json({ ok: true })

    const text = this.stripMention(event.text)
    if (!text) return Response.json({ ok: true })

    const target: SlackTarget = { channel: event.channel, ...(input.replyTs ? { replyTs: input.replyTs } : {}) }
    try {
      const sessionID = await this.ensureSession(text, "slack", target)
      const prompt = await this.buildPrompt(event.channel, event.ts, event.thread_ts, text)
      await this.withClient((client) => client.session.prompt({ sessionID, text: prompt }))
      await this.startRun()
      const settings = await this.settings()
      if (settings.streaming) this.ctx.waitUntil(this.startStream(sessionID))
      return Response.json({ ok: true, sessionID })
    } catch (err) {
      if (input.eventID) await this.store.releaseEvent(input.eventID).catch(() => {})
      await this.postChunked(target.channel, `⚠️ Couldn't start the session: ${errorMessage(err)}`, target.replyTs).catch(() => {})
      return Response.json({ ok: false, error: errorMessage(err) }, { status: 500 })
    }
  }

  private async onPermission(input: PermissionRequest): Promise<Response> {
    const sessionID = (await this.store.peekPermission(input.requestID)) ?? input.sessionID
    if (!sessionID) return Response.json({ ok: false, error: "unknown request" }, { status: 404 })
    await this.withClient((client) =>
      client.permission.reply({ sessionID, requestID: input.requestID, decision: input.decision }),
    )
    await this.store.clearPermission(input.requestID)
    return Response.json({ ok: true })
  }

  // -------------------------------------------------------------------- SSE

  private async onEvents(request: Request): Promise<Response> {
    const lastID = Number(request.headers.get("last-event-id") ?? "0") || 0
    const oldest = await this.store.oldestSeq()
    const replay = await this.store.eventsAfter(lastID)
    const encoder = new TextEncoder()
    let ref: ReadableStreamDefaultController<Uint8Array> | undefined

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        ref = controller
        if (lastID > 0 && oldest !== undefined && lastID < oldest - 1) {
          controller.enqueue(encoder.encode(formatSse({ type: "reset" })))
        }
        for (const entry of replay) controller.enqueue(encoder.encode(formatSse(entry.event, entry.seq)))
        controller.enqueue(encoder.encode(": connected\n\n"))
        this.subscribers.add(controller)
        this.syncHeartbeat()
      },
      cancel: () => {
        if (ref) this.subscribers.delete(ref)
        this.syncHeartbeat()
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

  private broadcast(event: ConversationEvent, seq: number): void {
    const chunk = new TextEncoder().encode(formatSse(event, seq))
    for (const controller of this.subscribers) {
      try {
        controller.enqueue(chunk)
      } catch {
        this.subscribers.delete(controller)
      }
    }
    this.syncHeartbeat()
  }

  /** Keep idle SSE connections alive without holding a container. */
  private syncHeartbeat(): void {
    if (this.subscribers.size > 0 && !this.heartbeat) {
      this.heartbeat = setInterval(() => {
        const chunk = new TextEncoder().encode(": heartbeat\n\n")
        for (const controller of this.subscribers) {
          try {
            controller.enqueue(chunk)
          } catch {
            this.subscribers.delete(controller)
          }
        }
      }, 15_000)
    } else if (this.subscribers.size === 0 && this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = undefined
    }
  }

  /** Emit to SSE and, when the conversation has a Slack target, post there too. */
  private async deliver(event: ConversationEvent): Promise<void> {
    const seq = await this.store.nextSeq()
    await this.store.appendEvent({ seq, event })
    this.broadcast(event, seq)
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

    const settings = await this.settings()
    const model = parseModelRef(settings.model)
    if (model) {
      await this.withClient((client) => client.session.switchModel({ sessionID, model }))
    }
    await this.store.setSession(sessionID, transport, slack)
    return sessionID
  }

  private async startRun(): Promise<void> {
    await this.store.patch({ lastReply: undefined })
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

  /**
   * Warm stream: read OpenCode's event stream while the container is up and
   * pump on completion. Alarms remain the fallback if the stream drops.
   */
  private async startStream(sessionID: string): Promise<void> {
    if (this.streaming) return
    const settings = await this.settings()
    if (!settings.streaming) return
    this.streaming = true
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10 * 60_000)
    try {
      const port = await this.ensureReady()
      const res = await port.fetch("http://container/api/event", {
        headers: { accept: "text/event-stream" },
        signal: controller.signal,
      })
      if (!res.ok || !res.body) return
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      const parse = createSseParser((message) => {
        if (message.event === "session.execution.succeeded") void this.pumpOnce()
        if (message.event === "session.execution.failed") void this.pumpOnce()
        if (message.event === "session.execution.interrupted") void this.pumpOnce()
      })
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        parse(decoder.decode(value, { stream: true }))
      }
    } catch {
      /* fall back to the alarm pump */
    } finally {
      clearTimeout(timeout)
      this.streaming = false
      await this.ctx.storage.setAlarm(Date.now() + POLL_MS)
    }
  }

  /** One poll: deliver new assistant text, permissions, settle + checkpoint. */
  private async pumpOnce(): Promise<boolean> {
    if (this.pumping) return false
    this.pumping = true
    try {
      const state = await this.store.get()
      if (!state.sessionID) return true

      const sessionID = state.sessionID
      const messages = (await this.withClient((client) => client.session.context({ sessionID }))) as MessageInfo[]
      const reply = latestAssistantReply(messages)

      if (reply && reply !== state.lastReply) {
        // At-least-once: persist only after delivery so a failed post is retried.
        await this.deliver({ type: "assistant", text: reply })
        await this.store.patch({ lastReply: reply })
      }

      await this.pollPermissions(sessionID)

      if (isSettled(messages)) {
        await this.deliver({ type: "settled" })
        const saved = await this.checkpoint()
        if (!saved) {
          await this.deliver({ type: "error", message: "workspace checkpoint failed; this turn is not durable" })
        }
        return true
      }
      return false
    } finally {
      this.pumping = false
    }
  }

  /** Alarm fallback: poll while a stream is not covering the run. */
  async alarm(): Promise<void> {
    try {
      const settled = await this.pumpOnce()
      if (settled) return
    } catch (err) {
      console.warn("pump failed", err)
    }
    const settings = await this.settings().catch(() => undefined)
    await this.ctx.storage.setAlarm(Date.now() + (this.streaming ? 30_000 : (settings?.pollSeconds ?? 2) * 1000))
  }

  private async pollPermissions(sessionID: string): Promise<void> {
    const pending = (await this.withClient((client) => client.permission.list({ sessionID })).catch(() => [])) ?? []
    for (const request of pending) {
      const state = await this.store.get()
      if (state.pending[request.id]) continue
      await this.store.rememberPermission(request.id, sessionID)
      await this.deliver({
        type: "permission",
        requestID: request.id,
        action: request.action,
        resources: request.resources,
      })
    }
  }

  // ---------------------------------------------------------------- container

  /** Test seam: replaces the container port for a given number. */
  transport?: (number: number) => ContainerPort

  private async port(number: number): Promise<ContainerPort> {
    if (this.transport) return this.transport(number)
    if (this.env.CONTAINER_URL) {
      const host = new URL(this.env.CONTAINER_URL).hostname
      return {
        fetch: (input, init) => {
          const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
          url.hostname = host
          url.port = String(number)
          return fetch(url.toString(), init)
        },
      }
    }
    const container = this.ctx.container
    if (!container) throw new Error("no container bound")
    if (!container.running) container.start()
    const port = container.getTcpPort(number)
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const res = await port.fetch("http://container/health", { signal: AbortSignal.timeout(2000) })
        if (res.ok) return port
      } catch {
        /* not ready yet */
      }
      await sleep(200)
    }
    throw new Error(`container port ${number} did not become ready`)
  }

  private async withClient<T>(fn: (client: ReturnType<typeof makeClient>) => Promise<T>): Promise<T> {
    try {
      const port = await this.ensureReady()
      const client = makeClient(portFetch(port))
      const result = await fn(client)
      this.consecutiveFailures = 0
      return result
    } catch (error) {
      this.consecutiveFailures++
      // Two consecutive failures: assume the container is wedged and recycle it.
      if (this.consecutiveFailures >= 2) {
        this.consecutiveFailures = 0
        await this.ctx.container?.destroy().catch(() => {})
      }
      throw error
    }
  }

  private readying?: Promise<ContainerPort>

  /** Start the container, restore the checkpoint on first boot, start OpenCode. */
  private async ensureReady(): Promise<ContainerPort> {
    if (!this.readying) {
      this.readying = this.doEnsureReady().finally(() => {
        this.readying = undefined
      })
    }
    return this.readying
  }

  private async doEnsureReady(): Promise<ContainerPort> {
    const settings = await this.settings()
    const state = await this.store.get()
    const container = this.ctx.container
    if (!container && !this.env.CONTAINER_URL && !this.transport) throw new Error("no container bound")

    // Apply a settings change only between runs: destroying mid-run loses the turn.
    if (
      container &&
      state.settingsVersion !== undefined &&
      state.settingsVersion !== settings.version &&
      container.running &&
      !this.pumping &&
      !this.streaming
    ) {
      await container.destroy()
    }

    const control = await this.port(CONTROL_PORT)

    const status = (await (
      await control.fetch("http://container/status", { signal: AbortSignal.timeout(10_000) })
    ).json()) as { initialized?: boolean }
    if (!status.initialized) {
      const checkpoint = await this.env.CHECKPOINTS.get(this.checkpointKey())
      if (checkpoint?.body) {
        await control.fetch("http://container/restore", {
          method: "POST",
          body: checkpoint.body,
          signal: AbortSignal.timeout(60_000),
        })
      }
    }

    // Configure after restore: /restore replaces /workspace, including the config.
    await control.fetch("http://container/configure", {
      method: "POST",
      body: JSON.stringify(settings),
      signal: AbortSignal.timeout(10_000),
    })

    const started = await control.fetch("http://container/start", {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
    })
    if (!started.ok) throw new Error(`container start failed: ${await started.text()}`)

    if (state.settingsVersion !== settings.version) {
      await this.store.patch({ settingsVersion: settings.version })
    }
    if (this.env.CONTAINER_URL || this.transport) return this.port(OPENCODE_PORT)
    if (!container) throw new Error("no container bound")
    return container.getTcpPort(OPENCODE_PORT)
  }

  private checkpointKey(): string {
    return `workspaces/${this.ctx.id.toString()}.tar.gz`
  }

  private async checkpoint(): Promise<boolean> {
    try {
      await withRetries(
        async () => {
          const control = await this.port(CONTROL_PORT)
          const response = await control.fetch("http://container/checkpoint", {
            signal: AbortSignal.timeout(120_000),
          })
          if (!response.ok || !response.body) throw new Error(`checkpoint returned ${response.status}`)
          await this.env.CHECKPOINTS.put(this.checkpointKey(), response.body)
        },
        { attempts: 3, delayMs: 1000 },
      )
      return true
    } catch (err) {
      console.warn("checkpoint failed", err)
      return false
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

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
