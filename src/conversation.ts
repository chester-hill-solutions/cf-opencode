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
import { formatSse, isSlowSubscriber, type ConversationEvent } from "./events"
import { createSseParser } from "./sse"
import { parseModelRef, type Env } from "./env"
import { withRetries } from "./retry"
import { retryAfterSeconds } from "./backoff"
import { logEvent } from "./log"
import type { HarnessSettings } from "./settings"

/** The fields of a pending permission the harness forwards. */
interface PermissionSummary {
  id: string
  action: string
  resources: string[]
}

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
  /** This instance has verified the container for the current spec. */
  private ready = false
  private opencodePort?: ContainerPort

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

    const prompt = input.user ? `${input.user}: ${text}` : text
    await this.store.advance("admitting")
    try {
      const sessionID = await this.ensureSession(text, input.transport ?? "http", input.slack)
      await this.withClient((client) => client.session.prompt({ sessionID, text: prompt }))
      await this.startRun()
      const settings = await this.settings()
      if (settings.streaming) this.ctx.waitUntil(this.startStream(sessionID))
      return Response.json({ ok: true, sessionID })
    } catch (err) {
      logEvent("admission.failed", { transport: "http" })
      const queued = await this.enqueue(prompt, undefined)
      if (!queued) {
        await this.store.advance("idle")
        return Response.json({ ok: false, error: "busy" }, { status: 503 })
      }
      return Response.json({ ok: true, queued: true, error: errorMessage(err) }, { status: 202 })
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
    let prompt = text
    await this.store.advance("admitting")
    try {
      prompt = await this.buildPrompt(event.channel, event.ts, event.thread_ts, text)
      const sessionID = await this.ensureSession(text, "slack", target)
      await this.withClient((client) => client.session.prompt({ sessionID, text: prompt }))
      await this.startRun()
      const settings = await this.settings()
      if (settings.streaming) this.ctx.waitUntil(this.startStream(sessionID))
      return Response.json({ ok: true, sessionID })
    } catch (err) {
      if (input.eventID) await this.store.releaseEvent(input.eventID).catch(() => {})
      logEvent("admission.failed", { transport: "slack" })
      const queued = await this.enqueue(prompt, target)
      if (!queued) {
        await this.postChunked(
          target.channel,
          `⚠️ Container busy and a message is already queued: ${errorMessage(err)}`,
          target.replyTs,
        ).catch(() => {})
      }
      return Response.json({ ok: true, queued })
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
      if (isSlowSubscriber(controller.desiredSize)) {
        this.subscribers.delete(controller)
        try {
          controller.close()
        } catch {
          /* already closed */
        }
        continue
      }
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
          if (isSlowSubscriber(controller.desiredSize)) {
            this.subscribers.delete(controller)
            try {
              controller.close()
            } catch {
              /* already closed */
            }
            continue
          }
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
  private async deliver(event: ConversationEvent, options: { slack?: boolean } = {}): Promise<void> {
    const seq = await this.store.nextSeq()
    await this.store.appendEvent({ seq, event })
    this.broadcast(event, seq)
    if (options.slack === false) return
    await this.deliverToSlack(event)
  }

  private async deliverToSlack(event: ConversationEvent): Promise<void> {
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
    await this.store.patch({
      lastReply: undefined,
      lastSlackReply: undefined,
      runStartedAt: Date.now(),
    })
    await this.store.advance("running")
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
      if (!state.sessionID) {
        await this.store.advance("idle")
        return true
      }

      const sessionID = state.sessionID
      // Context and permissions are independent: fetch them in one round-trip window.
      const [messages, pending] = await Promise.all([
        this.withClient((client) => client.session.context({ sessionID })) as Promise<MessageInfo[]>,
        this.withClient((client) => client.permission.list({ sessionID })).catch(
          () => [] as PermissionSummary[],
        ),
      ])
      const reply = latestAssistantReply(messages)
      const settled = isSettled(messages)

      if (reply && reply !== state.lastReply) {
        // SSE streams every change; Slack gets one message per turn, at settle.
        await this.deliver({ type: "assistant", text: reply }, { slack: false })
        await this.store.patch({ lastReply: reply })
      }

      await this.pollPermissions(sessionID, pending)

      if (settled) {
        await this.store.advance("settling")
        logEvent("turn.settled", {
          ...(state.runStartedAt ? { durationMs: Date.now() - state.runStartedAt } : {}),
          queued: Boolean(state.queued),
        })
        if (reply && reply !== state.lastSlackReply) {
          // At-least-once: persist only after delivery so a failed post is retried.
          await this.deliverToSlack({ type: "assistant", text: reply })
          await this.store.patch({ lastSlackReply: reply })
        }
        await this.deliver({ type: "settled" })
        const saved = await this.checkpoint()
        if (!saved) {
          await this.deliver({ type: "error", message: "workspace checkpoint failed; this turn is not durable" })
        }
        if ((await this.store.get()).queued) {
          await this.ctx.storage.setAlarm(Date.now() + 1000)
        }
        await this.store.advance("idle")
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
      const before = await this.store.get()
      if ((before.phase ?? "idle") === "admitting" && !this.pumping) {
        // The request that was admitting died with the previous DO instance.
        await this.store.advance("idle")
        logEvent("admission.stale")
      }
      if (await this.drainQueue()) return
      const settled = await this.pumpOnce()
      if (settled) return
    } catch (err) {
      console.warn("pump failed", err)
    }
    const state = await this.store.get()
    const settings = await this.settings().catch(() => undefined)
    // A queued admission retries on its own backoff; do not shorten it to the poll interval.
    const delay = this.streaming
      ? 30_000
      : state.queued
        ? Math.min(5000 * (state.queued.attempts + 1), 30_000)
        : (settings?.pollSeconds ?? 2) * 1000
    await this.ctx.storage.setAlarm(Date.now() + delay)
  }

  private async pollPermissions(sessionID: string, pending: PermissionSummary[]): Promise<void> {
    if (pending.length === 0) return
    const state = await this.store.get()
    const fresh = pending.filter((request) => !state.pending[request.id])
    if (fresh.length === 0) return
    // One read and one write for the whole batch.
    await this.store.rememberPermissions(fresh.map((request) => request.id), sessionID)
    for (const request of fresh) {
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
      this.ready = false
      this.opencodePort = undefined
      // Two consecutive failures: assume the container is wedged and recycle it.
      if (this.consecutiveFailures >= 2) {
        this.consecutiveFailures = 0
        logEvent("container.recycled")
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

    const versionChanged = state.settingsVersion !== undefined && state.settingsVersion !== settings.version
    const busy = this.pumping || this.streaming

    // A settings change is applied between runs: destroying mid-run loses the turn.
    if (container && versionChanged && container.running && busy) {
      return this.opencodePort ?? this.port(OPENCODE_PORT)
    }
    if (container && versionChanged && container.running) {
      await container.destroy()
      this.ready = false
      this.opencodePort = undefined
    }

    // Fast path: this instance already verified the container for this spec.
    if (this.ready && this.opencodePort && (!container || container.running) && !versionChanged) {
      return this.opencodePort
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
        await this.store.patch({ checkpointFingerprint: undefined })
      }
    }

    // Configure after restore: /restore replaces /workspace, including the config.
    // A warm container on the same spec already has its config.
    if (!status.initialized || versionChanged) {
      await control.fetch("http://container/configure", {
        method: "POST",
        body: JSON.stringify(settings),
        signal: AbortSignal.timeout(10_000),
      })
    }

    const startedAt = Date.now()
    const started = await control.fetch("http://container/start", {
      method: "POST",
      signal: AbortSignal.timeout(60_000),
    })
    if (!started.ok) throw new Error(`container start failed: ${await started.text()}`)

    if (state.settingsVersion !== settings.version) {
      await this.store.patch({ settingsVersion: settings.version })
    }

    const port = await this.port(OPENCODE_PORT)
    logEvent("container.ready", { durationMs: Date.now() - startedAt })
    this.opencodePort = port
    this.ready = true
    return port
  }

  /** Hold one admission when the container cannot start; drain it from the alarm. */
  private async enqueue(text: string, slack?: SlackTarget): Promise<boolean> {
    const state = await this.store.get()
    if (state.queued) return false
    await this.store.patch({ queued: { text, ...(slack ? { slack } : {}), attempts: 0 } })
    await this.store.advance("queued")
    logEvent("queue.enqueued", { transport: slack ? "slack" : "http" })
    if (slack) {
      await this.postChunked(slack.channel, "⏳ Container busy — queued; I'll retry shortly.", slack.replyTs).catch(() => {})
    }
    await this.ctx.storage.setAlarm(Date.now() + 5000)
    return true
  }

  private async drainQueue(): Promise<boolean> {
    const state = await this.store.get()
    if (!state.queued || this.pumping || this.streaming) return false
    const queued = state.queued

    try {
      const sessionID = await this.ensureSession(queued.text, queued.slack ? "slack" : "http", queued.slack)
      await this.withClient((client) => client.session.prompt({ sessionID, text: queued.text }))
      await this.store.patch({ queued: undefined })
      logEvent("queue.drained", { attempts: queued.attempts })
      await this.startRun()
      const settings = await this.settings()
      if (settings.streaming) this.ctx.waitUntil(this.startStream(sessionID))
      return true
    } catch (err) {
      const attempts = queued.attempts + 1
      if (attempts >= 5) {
        await this.store.patch({ queued: undefined })
        await this.store.advance("idle")
        logEvent("queue.failed", { attempts })
        await this.deliver({ type: "error", message: `queued message could not start: ${errorMessage(err)}` })
        if (queued.slack) {
          await this.postChunked(
            queued.slack.channel,
            `⚠️ Couldn't start the session: ${errorMessage(err)}`,
            queued.slack.replyTs,
          ).catch(() => {})
        }
        return false
      }
      await this.store.patch({ queued: { ...queued, attempts } })
      await this.ctx.storage.setAlarm(Date.now() + Math.min(5000 * attempts, 30_000))
      return false
    }
  }

  private checkpointKey(): string {
    return `workspaces/${this.ctx.id.toString()}.tar.gz`
  }

  private async checkpoint(): Promise<boolean> {
    try {
      await withRetries(
        async () => {
          const state = await this.store.get()
          const since = state.checkpointFingerprint ?? ""
          const control = await this.port(CONTROL_PORT)
          const response = await control.fetch(
            `http://container/checkpoint?since=${encodeURIComponent(since)}`,
            { signal: AbortSignal.timeout(120_000) },
          )
          if (response.status === 204) {
            logEvent("checkpoint.skipped")
            return
          }
          if (!response.ok || !response.body) throw new Error(`checkpoint returned ${response.status}`)
          const counted = countedStream(response.body)
          await this.env.CHECKPOINTS.put(this.checkpointKey(), counted.stream)
          const fingerprint = response.headers.get("x-workspace-fingerprint")
          if (fingerprint) await this.store.patch({ checkpointFingerprint: fingerprint })
          logEvent("checkpoint.saved", { bytes: counted.bytes() })
        },
        { attempts: 3, delayMs: 1000 },
      )
      return true
    } catch (err) {
      console.warn("checkpoint failed", err)
      logEvent("checkpoint.failed")
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

  private async slack(
    method: string,
    body: Record<string, unknown>,
    attempt = 0,
  ): Promise<Record<string, any>> {
    if (!this.env.SLACK_BOT_TOKEN) throw new Error("SLACK_BOT_TOKEN is not configured")
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.env.SLACK_BOT_TOKEN}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    })
    if (res.status === 429) {
      if (attempt >= 2) throw new Error(`${method}: rate_limited`)
      await sleep(retryAfterSeconds(res.headers.get("retry-after")) * 1000)
      return this.slack(method, body, attempt + 1)
    }
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

/** Pass a stream through unchanged while counting its bytes. */
function countedStream(stream: ReadableStream<Uint8Array>): {
  stream: ReadableStream<Uint8Array>
  bytes: () => number
} {
  let bytes = 0
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength
      controller.enqueue(chunk)
    },
  })
  return { stream: stream.pipeThrough(transform), bytes: () => bytes }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
