import { DurableObject } from "cloudflare:workers"
import { basicAuth, makeClient, portFetch, type ContainerPort } from "./opencode"
import {
  ConversationStore,
  type ConversationPhase,
  type ConversationState,
  type SlackTarget,
  type Transport,
} from "./state"
import {
  chunkText,
  formatSlackContext,
  mrkdwnEscape,
  type SlackContextMessage,
  type SlackEventEnvelope,
} from "./adapters/slack"
import {
  failureKey,
  isSettled,
  latestAssistantReply,
  turnFailure,
  type MessageInfo,
  type TurnFailure,
} from "./messages"
import { formatSse, isSlowSubscriber, type ConversationEvent } from "./events"
import { createSseParser } from "./sse"
import { parseModelRef, type Env } from "./env"
import { withRetries } from "./retry"
import { retryAfterSeconds } from "./backoff"
import { logEvent } from "./log"
import type { HarnessSettings } from "./settings"
import { staleAction } from "./lifecycle"
import { budgetExceeded } from "./budget"
import { GITHUB_TOKEN_KEY } from "./vault"

/** The fields of a pending permission the harness forwards. */
interface PermissionSummary {
  id: string
  action: string
  resources: string[]
}

const OPENCODE_PORT = 4000
const CONTROL_PORT = 4001
const POLL_MS = 2000
/** Delay before retrying a checkpoint that failed after a turn. */
const CHECKPOINT_RETRY_MS = 30_000
const CHECKPOINT_RETRY_LIMIT = 3
/** How many checkpoint versions to keep per conversation. */
const CHECKPOINT_KEEP = 5

/** R2 key holding the account's OpenCode state (config + provider credentials). */
export const ACCOUNT_STATE_KEY = "account/state.tar.gz"

export interface MessageRequest {
  text: string
  user?: string
  transport?: Transport
  slack?: SlackTarget
  /** Optional client key; a retry with the same key is not a second turn. */
  idempotencyKey?: string
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
  /** Password for the current OpenCode server process. */
  private opencodePassword?: string
  /** Event names seen on the warm stream, for diagnostics. */
  private seenEvents = new Map<string, number>()
  /** Last state of the warm stream: opened, an error, or idle. */
  private streamState = "idle"
  /** How the current container was started, for diagnostics. */
  private startMode: "image" | "snapshot" | "none" = "none"
  /** An admission is in flight in this instance; alarms must not reset it. */
  private admitting = false

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
    if (url.pathname === "/context") return this.onContext()
    if (url.pathname === "/state") return Response.json(await this.store.get())
    if (url.pathname === "/health") return Response.json({ ok: true })
    if (url.pathname.startsWith("/onboarding")) return this.onOnboarding(url.pathname, request)
    if (url.pathname === "/reset" && request.method === "POST") return this.onReset()
    if (url.pathname === "/recycle" && request.method === "POST") return this.onRecycle()
    if (url.pathname === "/debug" && request.method === "GET") {
      return Response.json({
        streamState: this.streamState,
        streaming: this.streaming,
        ready: this.ready,
        startMode: this.startMode,
        snapshot: Boolean(await this.snapshotHandle()),
        events: Object.fromEntries(this.seenEvents),
      })
    }
    if (url.pathname === "/delete" && request.method === "DELETE") return this.onDelete()
    return new Response("not found", { status: 404 })
  }

  // --------------------------------------------------------------- HTTP adapter

  private async onMessage(input: MessageRequest): Promise<Response> {
    const text = input.text.trim()
    if (!text) return Response.json({ ok: false, error: "empty message" }, { status: 400 })

    if (input.idempotencyKey) {
      if (!/^[A-Za-z0-9:_-]{1,128}$/.test(input.idempotencyKey)) {
        return Response.json({ ok: false, error: "invalid idempotencyKey" }, { status: 400 })
      }
      if (!(await this.store.claimEvent(`msg:${input.idempotencyKey}`))) {
        const current = await this.store.get()
        return Response.json({ ok: true, duplicate: true, sessionID: current.sessionID })
      }
    }

    const prompt = input.user ? `${input.user}: ${text}` : text

    const spent = await this.budgetBlocked()
    if (spent !== undefined) {
      return Response.json(
        { ok: false, error: "daily budget reached", spentUSD: spent },
        { status: 429 },
      )
    }

    if (!(await this.claimAdmission())) {
      const queued = await this.enqueue(prompt, undefined)
      if (!queued) return Response.json({ ok: false, error: "busy" }, { status: 503 })
      return Response.json({ ok: true, queued: true }, { status: 202 })
    }
    let sessionID = ""
    try {
      sessionID = await this.ensureSession(text, input.transport ?? "http", input.slack)
      const baseline = await this.turnBaseline(sessionID)
      await this.withClient((client) => client.session.prompt({ sessionID, text: prompt }))
      await this.startRun(baseline)
    } catch (err) {
      this.admitting = false
      void this.count("admission.failed")
      logEvent("admission.failed", { transport: "http" })
      const queued = await this.enqueue(prompt, undefined)
      if (!queued) {
        await this.store.advance("idle")
        return Response.json({ ok: false, error: "busy" }, { status: 503 })
      }
      return Response.json({ ok: true, queued: true, error: errorMessage(err) }, { status: 202 })
    }
    // The prompt is accepted; a settings/stream failure must not re-enqueue it.
    const settings = await this.settings().catch(() => undefined)
    if (settings?.streaming) this.ctx.waitUntil(this.startStream(sessionID))
    return Response.json({ ok: true, sessionID })
  }

  private async settings(): Promise<HarnessSettings> {
    const res = await this.env.SETTINGS.getByName("global").fetch("https://settings/get")
    return (await res.json()) as HarnessSettings
  }

  /** Decrypt one stored credential through the Settings DO. */
  private async secret(key: string): Promise<string | undefined> {
    try {
      const res = await this.env.SETTINGS.getByName("global").fetch("https://settings/secrets/get", {
        method: "POST",
        body: JSON.stringify({ key }),
      })
      if (!res.ok) return undefined
      const body = (await res.json()) as { value?: string | null }
      return body.value ?? undefined
    } catch {
      return undefined
    }
  }

  /**
   * Onboarding traffic: provider integrations, OAuth attempts, live models and
   * the account-state snapshot. Paths beyond `/onboarding` mirror the control
   * server, so the Worker only forwards the authenticated request.
   */
  private async onOnboarding(pathname: string, request: Request): Promise<Response> {
    const path = pathname.slice("/onboarding".length) || "/"
    try {
      await this.ensureReady()
      const control = await this.port(CONTROL_PORT)
      const body =
        request.method === "GET" || request.method === "HEAD" ? undefined : await request.text()
      const res = await control.fetch(`http://container${path}`, {
        method: request.method,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(120_000),
      })
      // The state snapshot pauses OpenCode; the next call must start it again.
      if (path === "/state-checkpoint" && res.ok) {
        this.ready = false
        this.opencodePort = undefined
      }
      return new Response(res.body, { status: res.status, headers: res.headers })
    } catch (error) {
      // A cold start can outlast the port wait. Report it so the wizard can
      // retry instead of surfacing an opaque Worker exception.
      return Response.json(
        { error: errorMessage(error), retryable: true },
        { status: 503 },
      )
    }
  }

  /** Hard reset: drop the container and this conversation's stored state. */
  private async onReset(): Promise<Response> {
    try {
      await this.ctx.container?.destroy()
    } catch {
      /* already stopped */
    }
    this.ready = false
    this.opencodePort = undefined
    this.opencodePassword = undefined
    await this.ctx.storage.deleteAll()
    return Response.json({ ok: true })
  }

  /**
   * Recycle the container so the next call starts the current image. State is
   * kept: this is what a long-lived conversation needs after an image deploy.
   */
  private async onRecycle(): Promise<Response> {
    try {
      await this.ctx.container?.destroy()
    } catch {
      /* already stopped */
    }
    this.ready = false
    this.opencodePort = undefined
    this.opencodePassword = undefined
    return Response.json({ ok: true })
  }

  /** Remove the workspace archives and this conversation's stored state. */
  private async onDelete(): Promise<Response> {
    try {
      await this.ctx.container?.destroy()
    } catch {
      /* already stopped */
    }
    this.ready = false
    this.opencodePort = undefined
    this.opencodePassword = undefined
    const id = this.ctx.id.toString()
    const list = await this.env.CHECKPOINTS.list({ prefix: this.checkpointPrefix() })
    for (const object of list.objects) await this.env.CHECKPOINTS.delete(object.key)
    await this.env.CHECKPOINTS.delete(`workspaces/${id}.tar.gz`)
    await this.ctx.storage.deleteAll()
    logEvent("conversation.deleted")
    return Response.json({ ok: true })
  }

  /** Increment a harness counter; counting must never fail a turn. */
  protected async count(name: string): Promise<void> {
    try {
      await this.env.SETTINGS.getByName("global").fetch("https://settings/metrics", {
        method: "POST",
        body: JSON.stringify({ name }),
      })
    } catch {
      /* counters are advisory */
    }
  }

  // ------------------------------------------------------------ container start

  /** Startup options for the scheduling policy in use. */
  protected startOptions(): ContainerStartupOptions {
    const images = (this.ctx.container as unknown as { images?: Record<string, string> } | undefined)
      ?.images
    return {
      enableInternet: true,
      image: images?.base,
      // `basic` has no exact equivalent on this policy; standard-1 is the
      // closest size with enough memory for OpenCode plus stow.
      instance: "standard-1",
    } as ContainerStartupOptions
  }

  /** A snapshot to restore instead of a fresh start, when supported. */
  protected async snapshotHandle(): Promise<ContainerSnapshot | undefined> {
    return this.ctx.storage.get<ContainerSnapshot>("snapshot")
  }

  /** Drop a snapshot that cannot be used (image change, corruption). */
  protected async clearSnapshot(): Promise<boolean> {
    const existing = await this.ctx.storage.get<ContainerSnapshot>("snapshot")
    await this.ctx.storage.delete("snapshot")
    return Boolean(existing)
  }

  /**
   * Capture a filesystem snapshot after a durable checkpoint. Snapshots are a
   * fast restore cache: they are bound to the image they were taken from, so
   * the R2 archive remains the portable source of truth.
   */
  protected async captureSnapshot(): Promise<void> {
    try {
      const snapshot = await this.ctx.container?.snapshotContainer({ name: "turn" })
      if (!snapshot) return
      await this.ctx.storage.put("snapshot", snapshot)
      logEvent("snapshot.saved", { bytes: snapshot.size })
      await this.count("snapshot.saved")
    } catch {
      logEvent("snapshot.failed")
      void this.count("snapshot.failed")
    }
  }

  /** Start the container, preferring a snapshot when one is available. */
  private async startContainer(): Promise<boolean> {
    const container = this.ctx.container
    if (!container) throw new Error("no container bound")
    const snapshot = await this.snapshotHandle()
    if (snapshot) {
      try {
        container.start({ ...this.startOptions(), image: undefined, containerSnapshot: snapshot } as ContainerStartupOptions)
        this.startMode = "snapshot"
        logEvent("snapshot.restored")
        return true
      } catch {
        await this.clearSnapshot()
      }
    }
    container.start(this.startOptions())
    this.startMode = "image"
    return false
  }

  /** A phase where a new prompt must wait for the current turn. */
  private isBusy(phase: ConversationPhase | undefined): boolean {
    return phase === "admitting" || phase === "running" || phase === "settling" || phase === "queued"
  }

  /** Serializes check-then-claim steps so two requests cannot both admit. */
  private admissionTail: Promise<unknown> = Promise.resolve()

  private withAdmissionLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.admissionTail.then(task, task)
    this.admissionTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private claimAdmission(): Promise<boolean> {
    return this.withAdmissionLock(async () => {
      const state = await this.store.get()
      if (state.queued || this.isBusy(state.phase)) return false
      await this.store.advance("admitting")
      this.admitting = true
      return true
    })
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
    try {
      prompt = await this.buildPrompt(event.channel, event.ts, event.thread_ts, text)
      if (!(await this.claimAdmission())) {
        const queued = await this.enqueue(prompt, target)
        if (!queued) {
          await this.postChunked(
            target.channel,
            "⚠️ Container busy and a message is already queued.",
            target.replyTs,
          ).catch(() => {})
        }
        return Response.json({ ok: true, queued })
      }
      const sessionID = await this.ensureSession(text, "slack", target)
      const baseline = await this.turnBaseline(sessionID)
      await this.withClient((client) => client.session.prompt({ sessionID, text: prompt }))
      await this.startRun(baseline)
      const settings = await this.settings().catch(() => undefined)
      if (settings?.streaming) this.ctx.waitUntil(this.startStream(sessionID))
      return Response.json({ ok: true, sessionID })
    } catch (err) {
      if (input.eventID) await this.store.releaseEvent(input.eventID).catch(() => {})
      logEvent("admission.failed", { transport: "slack" })
      const queued = await this.enqueue(prompt, target)
      if (!queued) {
        await this.store.advance("idle")
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

  /** Diagnostics: the raw OpenCode message context for this conversation. */
  private async onContext(): Promise<Response> {
    const state = await this.store.get()
    if (!state.sessionID) return Response.json({ error: "no session" }, { status: 404 })
    try {
      const messages = await this.withClient((client) =>
        client.session.context({ sessionID: state.sessionID as string }),
      )
      return Response.json({ sessionID: state.sessionID, messages })
    } catch (err) {
      return Response.json({ error: errorMessage(err) }, { status: 502 })
    }
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
    const seq = await this.store.appendEvent(event)
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

  /**
   * The last assistant message id before a prompt. Everything after it belongs
   * to the next turn, even before OpenCode has recorded the new user message.
   */
  private async turnBaseline(sessionID: string): Promise<string | undefined> {
    try {
      const messages = (await this.withClient((client) =>
        client.session.context({ sessionID }),
      )) as MessageInfo[]
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (message?.type === "assistant" && message.id) return message.id
      }
    } catch {
      /* no baseline: fall back to last-user scoping */
    }
    return undefined
  }

  private async startRun(turnBaseline?: string): Promise<void> {
    this.admitting = false
    await this.store.patch({
      lastReply: undefined,
      lastSlackReply: undefined,
      runStartedAt: Date.now(),
      turnBaseline,
    })
    if (!(await this.store.advance("running"))) {
      // A concurrent alarm may have reset the admission; the prompt is already
      // sent, so force the phase rather than leaving the turn invisible.
      await this.store.save({ ...(await this.store.get()), phase: "running" })
    }
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
    const settings = await this.settings().catch(() => undefined)
    if (!settings?.streaming) return
    this.streaming = true
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10 * 60_000)
    try {
      const port = await this.ensureReady()
      const res = await port.fetch("http://container/api/event", {
        headers: {
          accept: "text/event-stream",
          ...(this.opencodePassword ? { authorization: basicAuth(this.opencodePassword) } : {}),
        },
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        this.streamState = `http ${res.status}`
        return
      }
      this.streamState = "opened"
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      const parse = createSseParser((message) => {
        // OpenCode's stream may name frames `message` and put the type in the
        // JSON payload, so prefer the payload's `type` when present.
        let parsed: { type?: string } | undefined
        if (message.data) {
          try {
            parsed = JSON.parse(message.data) as { type?: string }
          } catch {
            parsed = undefined
          }
        }
        const name = message.event && message.event !== "message" ? message.event : parsed?.type
        if (!name) return
        this.seenEvents.set(name, (this.seenEvents.get(name) ?? 0) + 1)
        if (name === "session.execution.succeeded") void this.pumpOnce()
        if (name === "session.execution.failed") void this.pumpOnce()
        if (name === "session.execution.interrupted") void this.pumpOnce()
        if (name === "session.usage.updated" && message.data) {
          this.ctx.waitUntil(this.recordUsage(message.data, "replace"))
        }
        if (name === "session.usage.recorded" && message.data) {
          this.ctx.waitUntil(this.recordUsage(message.data, "add"))
        }
      })
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        parse(decoder.decode(value, { stream: true }))
      }
    } catch (error) {
      this.streamState = errorMessage(error)
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
      // A late alarm or stream event can arrive after the turn settled. Do not
      // re-deliver or checkpoint an idle conversation. `settling` is allowed so
      // a restart in the middle of a settle can finish it.
      const phase = state.phase ?? "idle"
      if (phase !== "running" && phase !== "settling") return true

      const sessionID = state.sessionID
      // Context and permissions are independent: fetch them in one round-trip window.
      const [messages, pending] = await Promise.all([
        this.withClient((client) => client.session.context({ sessionID })) as Promise<MessageInfo[]>,
        this.withClient((client) => client.permission.list({ sessionID })).catch(
          () => [] as PermissionSummary[],
        ),
      ])
      const reply = latestAssistantReply(messages, state.turnBaseline)
      const settled = isSettled(messages, state.turnBaseline)
      // A terminal `idle` error means the turn is over even though no assistant
      // message completed, so it must settle, checkpoint and go idle.
      const failure = settled ? undefined : turnFailure(messages, state.turnBaseline, state.runStartedAt)

      if (reply && reply !== state.lastReply) {
        // SSE streams every change; Slack gets one message per turn, at settle.
        await this.deliver({ type: "assistant", text: reply }, { slack: false })
        await this.store.patch({ lastReply: reply })
      }

      await this.pollPermissions(sessionID, pending)

      if (settled || failure) {
        await this.finishTurn(state, reply, failure)
        return true
      }
      return false
    } finally {
      this.pumping = false
    }
  }

  /**
   * End-of-turn bookkeeping, shared by the poll path and the timeout guard.
   * Persists only after delivery so a failed post is retried next time.
   */
  private async finishTurn(
    state: ConversationState,
    reply: string,
    failure?: TurnFailure,
  ): Promise<void> {
    await this.store.advance("settling")
    void this.count(failure ? "turn.failed" : "turn.settled")
    logEvent(failure ? "turn.failed" : "turn.settled", {
      ...(state.runStartedAt ? { durationMs: Date.now() - state.runStartedAt } : {}),
      ...(failure ? { error: failure.message.slice(0, 200) } : {}),
      queued: Boolean(state.queued),
    })
    if (failure) {
      const key = failureKey(failure)
      if (key !== state.reportedError) {
        await this.deliver({ type: "error", message: failure.message })
        await this.store.patch({ reportedError: key, lastTurnError: failure.message })
      }
    }
    if (reply && reply !== state.lastSlackReply) {
      await this.deliverToSlack({ type: "assistant", text: reply })
      await this.store.patch({ lastSlackReply: reply })
    }
    await this.deliver({ type: "settled" })
    const saved = await this.checkpoint()
    if (!saved && !failure) {
      await this.deliver({
        type: "error",
        message: "workspace checkpoint failed; retrying in the background",
      })
    }
    if ((await this.store.get()).queued) await this.ctx.storage.setAlarm(Date.now() + 1000)
    await this.store.advance("idle")
  }

  /**
   * Record spend reported by OpenCode. `session.usage.updated` carries the
   * session's cumulative totals (replace); `session.usage.recorded` describes
   * one metered step (add). Both feed today's conversation total and ledger.
   */
  private async recordUsage(raw: string, mode: "replace" | "add"): Promise<void> {
    try {
      const parsed = JSON.parse(raw) as {
        data?: { cost?: number; tokens?: { input?: number; output?: number } }
        cost?: number
        tokens?: { input?: number; output?: number }
      }
      const payload = parsed.data ?? parsed
      const cost = Number(payload.cost ?? 0) || 0
      const input = Number(payload.tokens?.input ?? 0) || 0
      const output = Number(payload.tokens?.output ?? 0) || 0
      if (cost === 0 && input === 0 && output === 0) return
      const date = new Date().toISOString().slice(0, 10)
      const state = await this.store.get()
      const base =
        state.usage?.date === date ? state.usage : { date, costUSD: 0, input: 0, output: 0 }
      const usage =
        mode === "replace"
          ? { date, costUSD: cost, input, output }
          : {
              date,
              costUSD: base.costUSD + cost,
              input: base.input + input,
              output: base.output + output,
            }
      await this.store.patch({ usage, usageError: undefined })
      await this.env.SETTINGS.getByName("global").fetch("https://settings/usage", {
        method: "POST",
        body: JSON.stringify({ conversationID: this.ctx.id.toString(), ...usage }),
      })
    } catch (error) {
      await this.store.patch({ usageError: errorMessage(error) }).catch(() => {})
    }
  }

  /** Spend so far today, or undefined when the budget is disabled or unreadable. */
  private async budgetBlocked(): Promise<number | undefined> {
    const settings = await this.settings().catch(() => undefined)
    const budget = settings?.dailyBudgetUSD ?? 0
    if (!Number.isFinite(budget) || budget <= 0) return undefined
    try {
      const response = await this.env.SETTINGS.getByName("global").fetch("https://settings/usage/today")
      if (!response.ok) return undefined
      const usage = (await response.json()) as { costUSD?: number }
      const spent = Number(usage.costUSD ?? 0)
      return budgetExceeded(spent, budget) ? spent : undefined
    } catch {
      return undefined
    }
  }

  /** Alarm fallback: poll while a stream is not covering the run. */
  async alarm(): Promise<void> {
    try {
      const before = await this.store.get()
      const action = staleAction(before, Date.now(), this.pumping || this.admitting)
      if (action === "admission") {
        // The request that was admitting died with the previous DO instance.
        await this.store.advance("idle")
        logEvent("admission.stale")
      } else if (action === "settlement") {
        // A settle interrupted by a crash or deploy must not strand the DO.
        logEvent("settlement.stale", {
          ...(before.runStartedAt ? { durationMs: Date.now() - before.runStartedAt } : {}),
        })
        await this.store.advance("idle")
      } else if (action === "timeout") {
        // No terminal message and no error: abandon the turn so the container
        // is not pinned forever.
        void this.count("turn.timedout")
        logEvent("turn.timedout", {
          ...(before.runStartedAt ? { durationMs: Date.now() - before.runStartedAt } : {}),
        })
        await this.finishTurn(before, before.lastReply ?? "", { message: "turn timed out" })
        return
      }
      if (await this.retryCheckpoint()) return
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
    // The direct Container API defaults internet access off; OpenCode needs
    // DNS and outbound HTTPS for the workspace clone and model providers.
    let usedSnapshot = false
    if (!container.running) usedSnapshot = await this.startContainer()
    const port = container.getTcpPort(number)
    const path = number === OPENCODE_PORT ? "/api/info" : "/health"
    const headers =
      number === OPENCODE_PORT && this.opencodePassword
        ? { authorization: basicAuth(this.opencodePassword) }
        : undefined
    const ready = async (limit: number): Promise<boolean> => {
      for (let attempt = 0; attempt < limit; attempt++) {
        try {
          const res = await port.fetch(`http://container${path}`, {
            headers,
            signal: AbortSignal.timeout(2000),
          })
          if (res.ok) return true
        } catch {
          /* not ready yet */
        }
        await sleep(200)
      }
      return false
    }
    // A snapshot restore should be quick; do not burn the long cold-start
    // window before falling back to the image.
    if (await ready(usedSnapshot ? 90 : 300)) return port
    // A snapshot is tied to the image it was taken from. If restoring it never
    // becomes ready, drop it and start from the current image instead.
    if (usedSnapshot) {
      logEvent("snapshot.stale")
      await this.clearSnapshot()
      await container.destroy().catch(() => {})
      await this.startContainer()
      if (await ready(300)) return port
    }
    throw new Error(`container port ${number} did not become ready`)
  }

  private async withClient<T>(fn: (client: ReturnType<typeof makeClient>) => Promise<T>): Promise<T> {
    try {
      const port = await this.ensureReady()
      const client = makeClient(portFetch(port), this.opencodePassword)
      const result = await fn(client)
      this.consecutiveFailures = 0
      return result
    } catch (error) {
      // A cold start that outlasts the wait is slow, not wedged: do not count
      // it as a failure or recycle the container out from under itself.
      if (error instanceof Error && error.message.includes("did not become ready")) throw error
      this.consecutiveFailures++
      this.invalidateOpenCode()
      // Two consecutive failures: assume the container is wedged and recycle it.
      if (this.consecutiveFailures >= 2) {
        this.consecutiveFailures = 0
        void this.count("container.recycled")
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
    // A warm event stream can stay open across idle turns; only a live turn
    // should protect the container from a settings-driven restart.
    const busy =
      this.pumping ||
      state.phase === "admitting" ||
      state.phase === "running" ||
      state.phase === "settling"

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
      const checkpoint = await this.latestCheckpoint()
      if (checkpoint?.body) {
        await control.fetch("http://container/restore", {
          method: "POST",
          body: checkpoint.body,
          signal: AbortSignal.timeout(60_000),
        })
        await this.store.patch({ checkpointFingerprint: undefined })
      } else {
        // A fresh conversation inherits the account's provider credentials, so
        // onboarding only has to happen once.
        const seed = await this.env.CHECKPOINTS.get(ACCOUNT_STATE_KEY)
        if (seed?.body) {
          const seeded = await control.fetch("http://container/seed-state", {
            method: "POST",
            body: seed.body,
            signal: AbortSignal.timeout(60_000),
          })
          if (!seeded.ok) logEvent("account.seed.failed", { status: seeded.status })
        }
      }
    }

    // Configure after restore: /restore replaces /workspace, including the config.
    // A warm container on the same spec already has its config.
    if (!status.initialized || versionChanged) {
      const githubToken = await this.secret(GITHUB_TOKEN_KEY)
      await control.fetch("http://container/configure", {
        method: "POST",
        body: JSON.stringify({ ...settings, ...(githubToken ? { githubToken } : {}) }),
        signal: AbortSignal.timeout(10_000),
      })
    }

    const startedAt = Date.now()
    const started = await control.fetch("http://container/start", {
      method: "POST",
      signal: AbortSignal.timeout(120_000),
    })
    if (!started.ok) throw new Error(`container start failed: ${await started.text()}`)
    const startedBody = (await started.json()) as { password?: string }
    if (startedBody.password) this.opencodePassword = startedBody.password
    await this.store.patch({
      containerStarts: ((await this.store.get()).containerStarts ?? 0) + 1,
    })

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
    const nextAttemptAt = Date.now() + 5000
    await this.store.patch({
      queued: { text, ...(slack ? { slack } : {}), attempts: 0, nextAttemptAt },
    })
    await this.store.advance("queued")
    void this.count("queue.enqueued")
    logEvent("queue.enqueued", { transport: slack ? "slack" : "http" })
    if (slack) {
      await this.postChunked(slack.channel, "⏳ Container busy — queued; I'll retry shortly.", slack.replyTs).catch(() => {})
    }
    await this.ctx.storage.setAlarm(nextAttemptAt)
    return true
  }

  private async drainQueue(): Promise<boolean> {
    // Claim the queued work under the same lock as admissions, so a new
    // message cannot start while the queue is being drained.
    const queued = await this.withAdmissionLock(async () => {
      const state = await this.store.get()
      // The warm stream stays connected while idle; it must not block the queue.
      if (!state.queued || this.pumping) return undefined
      const phase = state.phase ?? "idle"
      if (phase === "running" || phase === "settling" || phase === "admitting") return undefined
      await this.store.advance("admitting")
      this.admitting = true
      return state.queued
    })
    if (!queued) return false

    try {
      const sessionID = await this.ensureSession(queued.text, queued.slack ? "slack" : "http", queued.slack)
      const baseline = await this.turnBaseline(sessionID)
      await this.withClient((client) => client.session.prompt({ sessionID, text: queued.text }))
      await this.store.patch({ queued: undefined })
      void this.count("queue.drained")
      logEvent("queue.drained", { attempts: queued.attempts })
      await this.startRun(baseline)
      const settings = await this.settings()
      if (settings.streaming) this.ctx.waitUntil(this.startStream(sessionID))
      return true
    } catch (err) {
      this.admitting = false
      const attempts = queued.attempts + 1
      if (attempts >= 5) {
        await this.store.patch({ queued: undefined, lastTurnError: errorMessage(err) })
        await this.store.advance("idle")
        void this.count("queue.failed")
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
      await this.store.patch({
        queued: {
          ...queued,
          attempts,
          lastError: errorMessage(err),
          nextAttemptAt: Date.now() + Math.min(5000 * attempts, 30_000),
        },
      })
      await this.store.advance("queued")
      await this.ctx.storage.setAlarm(Date.now() + Math.min(5000 * attempts, 30_000))
      return false
    }
  }

  private checkpointPrefix(): string {
    return `workspaces/${this.ctx.id.toString()}/`
  }

  /** Newest checkpoint, with a fallback to the pre-versioning single object. */
  private async latestCheckpoint(): Promise<R2ObjectBody | null> {
    const list = await this.env.CHECKPOINTS.list({ prefix: this.checkpointPrefix() })
    const newest = list.objects
      .map((object) => object.key)
      .sort()
      .at(-1)
    if (newest) return this.env.CHECKPOINTS.get(newest)
    return this.env.CHECKPOINTS.get(`workspaces/${this.ctx.id.toString()}.tar.gz`)
  }

  /** Drop old versions, keeping the most recent few for recovery. */
  private async pruneCheckpoints(): Promise<void> {
    const list = await this.env.CHECKPOINTS.list({ prefix: this.checkpointPrefix() })
    const keys = list.objects.map((object) => object.key).sort()
    const stale = keys.slice(0, Math.max(0, keys.length - CHECKPOINT_KEEP))
    for (const key of stale) await this.env.CHECKPOINTS.delete(key)
    if (stale.length) logEvent("checkpoint.pruned", { count: stale.length })
  }

  /** Retry a checkpoint that failed at settle time, with a bounded attempt count. */
  private async retryCheckpoint(): Promise<boolean> {
    const state = await this.store.get()
    if (!state.checkpointPending) return false
    if ((state.phase ?? "idle") !== "idle") return false
    const attempts = state.checkpointAttempts ?? 0
    if (attempts >= CHECKPOINT_RETRY_LIMIT) {
      await this.store.patch({ checkpointPending: undefined, checkpointAttempts: undefined })
      logEvent("checkpoint.abandoned", { attempts })
      return false
    }
    const saved = await this.checkpoint()
    if (saved) {
      await this.store.patch({ checkpointPending: undefined, checkpointAttempts: undefined })
      logEvent("checkpoint.recovered", { attempts })
      return false
    }
    await this.store.patch({ checkpointAttempts: attempts + 1 })
    logEvent("checkpoint.retry", { attempts: attempts + 1 })
    return false
  }

  private async checkpoint(): Promise<boolean> {
    // The control server archives the workspace without stopping OpenCode, so
    // the cached port stays valid across a checkpoint.
    const key = `${this.checkpointPrefix()}${Date.now()}.tar.gz`
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
            void this.count("checkpoint.skipped")
            logEvent("checkpoint.skipped")
            return
          }
          if (!response.ok || !response.body) throw new Error(`checkpoint returned ${response.status}`)
          // From here on a failure is a failed upload, not a paused server.
          const length = Number(response.headers.get("content-length"))
          if (Number.isFinite(length) && length > 0) {
            // R2 needs a stream of known length; the control server sends one.
            const counted = countedStream(response.body)
            const fixed = new FixedLengthStream(length)
            const piping = counted.stream.pipeTo(fixed.writable).catch(() => {})
            await this.env.CHECKPOINTS.put(key, fixed.readable)
            await piping
            void this.count("checkpoint.saved")
            logEvent("checkpoint.saved", { bytes: counted.bytes() })
            await this.store.patch({ checkpointSize: counted.bytes() })
          } else {
            // Older control servers streamed without a length.
            const bytes = await response.arrayBuffer()
            await this.env.CHECKPOINTS.put(key, bytes)
            void this.count("checkpoint.saved")
            logEvent("checkpoint.saved", { bytes: bytes.byteLength })
            await this.store.patch({ checkpointSize: bytes.byteLength })
          }
          const fingerprint = response.headers.get("x-workspace-fingerprint")
          if (fingerprint) await this.store.patch({ checkpointFingerprint: fingerprint })
          await this.pruneCheckpoints()
        },
        { attempts: 3, delayMs: 1000 },
      )
      await this.store.patch({
        checkpointPending: undefined,
        checkpointAttempts: undefined,
      })
      await this.captureSnapshot()
      return true
    } catch (err) {
      console.warn("checkpoint failed", err)
      void this.count("checkpoint.failed")
      logEvent("checkpoint.failed")
      // Keep the failure visible and retry from the alarm instead of losing the
      // turn's work silently.
      await this.store.patch({ checkpointPending: true })
      await this.ctx.storage.setAlarm(Date.now() + CHECKPOINT_RETRY_MS)
      return false
    }
  }

  /** Drop the cached port so the next call re-checks and restarts OpenCode. */
  private invalidateOpenCode(): void {
    this.ready = false
    this.opencodePort = undefined
    this.opencodePassword = undefined
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
