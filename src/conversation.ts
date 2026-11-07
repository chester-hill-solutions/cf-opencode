import { DurableObject } from "cloudflare:workers"
import { makeClient, portFetch, type ContainerPort } from "./opencode"
import { opencodeViaControl } from "./opencode-proxy"
import {
  ConversationStore,
  type CheckpointManifest,
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
  toMillis,
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
import { withSpan } from "./telemetry"
import type { HarnessSettings } from "./settings"
import { staleAction } from "./lifecycle"
import { budgetExceeded, nextBudgetReset } from "./budget"
import { CAPACITY_RETRY_MS, isCapacityRejection } from "./queue"
import { GITHUB_TOKEN_KEY, workspaceID } from "./vault"
import { accountStateKey, LEGACY_ACCOUNT_STATE_KEY, parseConversationKey } from "./tenancy"
import {
  decryptTransform,
  encryptBytes,
  encryptTransform,
  encryptedLength,
} from "./archive-crypto"
import { deriveWorkspaceKey } from "@chester-hill-solutions/vault/core"
import { plaintextArchivesAllowed } from "./archive-policy"

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
/** Container lease lifetime for the concurrency cap, refreshed per turn. */
const LEASE_TTL_MS = 10 * 60_000
/** Keep a warm container between quick follow-up turns. */
const INACTIVITY_TIMEOUT_MS = 10 * 60_000
/** Admin key exempt from the container cap so onboarding is always reachable. */
const ONBOARDING_KEY = "onboarding"

/** R2 key holding the account's OpenCode state (config + provider credentials). */
export const ACCOUNT_STATE_KEY = LEGACY_ACCOUNT_STATE_KEY

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
  /** Bearer token the container control server requires. */
  private controlTokenValue?: string
  /** Event names seen on the warm stream, for diagnostics. */
  private seenEvents = new Map<string, number>()
  /** Last state of the warm stream: opened, an error, or idle. */
  private streamState = "idle"
  /** How the current container was started, for diagnostics. */
  private startMode: "image" | "snapshot" | "none" = "none"
  /** An admission is in flight in this instance; alarms must not reset it. */
  private admitting = false
  /** This instance holds a container lease from the Settings DO. */
  private leaseHeld = false
  /** The inactivity timeout was applied to the current container. */
  private inactivitySet = false
  /** Conversation key, sent by the Worker; admin traffic skips the cap. */
  private key?: string

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.store = new ConversationStore(ctx.storage)
  }

  async fetch(request: Request): Promise<Response> {
    this.key = request.headers.get("x-conversation-key") ?? this.key
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
    if (url.pathname === "/debug/messages" && request.method === "GET") {
      const state = await this.store.get()
      if (!state.sessionID) return Response.json({ messages: [] })
      const messages = await this.withClient((client) =>
        client.session.context({ sessionID: state.sessionID as string }),
      ).catch((error) => ({ error: errorMessage(error) }))
      return Response.json({ messages })
    }
    if (url.pathname === "/debug/snapshot/invalidate" && request.method === "POST") {
      // Ops/test seam: poison the stored handle so the next start must fall
      // back to the image and the R2 archive.
      const existing = await this.ctx.storage.get<ContainerSnapshot>("snapshot")
      if (!existing) return Response.json({ ok: false, error: "no snapshot" }, { status: 404 })
      await this.ctx.storage.put("snapshot", { id: "invalid-snapshot", size: 0 })
      return Response.json({ ok: true })
    }
    if (url.pathname === "/delete" && request.method === "DELETE") return this.onDelete()
    return new Response("not found", { status: 404 })
  }

  // --------------------------------------------------------------- HTTP adapter

  private async onMessage(input: MessageRequest): Promise<Response> {
    // Body shape is not guaranteed by the route; reject anything non-string
    // before calling string methods on it.
    const text = typeof input.text === "string" ? input.text.trim() : ""
    if (!text) return Response.json({ ok: false, error: "empty message" }, { status: 400 })

    const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey : undefined
    if (input.idempotencyKey !== undefined && idempotencyKey === undefined) {
      return Response.json({ ok: false, error: "invalid idempotencyKey" }, { status: 400 })
    }
    if (idempotencyKey) {
      if (!/^[A-Za-z0-9:_-]{1,128}$/.test(idempotencyKey)) {
        return Response.json({ ok: false, error: "invalid idempotencyKey" }, { status: 400 })
      }
      if (!(await this.store.claimEvent(`msg:${idempotencyKey}`))) {
        const current = await this.store.get()
        return Response.json({ ok: true, duplicate: true, sessionID: current.sessionID })
      }
    }
    // Only a message that was accepted (prompted or queued) may consume the
    // key; otherwise a retry must be able to prompt.
    const releaseClaim = async (): Promise<void> => {
      if (!idempotencyKey) return
      await this.store.releaseEvent(`msg:${idempotencyKey}`).catch(() => {})
    }

    const prompt = input.user ? `${input.user}: ${text}` : text

    const spent = await this.budgetBlocked()
    if (spent !== undefined) {
      await releaseClaim()
      return Response.json(
        { ok: false, error: "daily budget reached", spentUSD: spent },
        { status: 429 },
      )
    }

    if (!(await this.claimAdmission())) {
      const queued = await this.enqueue(prompt, undefined)
      if (!queued) {
        await releaseClaim()
        return Response.json({ ok: false, error: "busy" }, { status: 503 })
      }
      return Response.json({ ok: true, queued: true }, { status: 202 })
    }
    let sessionID = ""
    let baseline: string | undefined
    try {
      sessionID = await this.ensureSession(text, input.transport ?? "http", input.slack)
      baseline = await this.turnBaseline(sessionID)
      // Once this call returns, the prompt has been accepted by OpenCode.
      await this.withClient((client) => client.session.prompt({ sessionID, text: prompt }))
    } catch (err) {
      this.admitting = false
      void this.count("admission.failed")
      logEvent("admission.failed", { transport: "http" })
      const queued = await this.enqueue(prompt, undefined)
      if (!queued) {
        await this.store.advance("idle")
        await releaseClaim()
        return Response.json({ ok: false, error: "busy" }, { status: 503 })
      }
      return Response.json({ ok: true, queued: true, error: errorMessage(err) }, { status: 202 })
    }
    // The prompt is accepted; a bookkeeping or stream failure must not
    // re-enqueue it, or the model would be charged twice for one message.
    await this.recordAcceptedTurn(baseline)
    const settings = await this.settings().catch(() => undefined)
    if (settings?.streaming) this.ctx.waitUntil(this.startStream(sessionID))
    return Response.json({ ok: true, sessionID })
  }

  /**
   * Record a turn whose prompt OpenCode has already accepted. Bookkeeping
   * failures must never cause the prompt to be sent again, so a failure is
   * reported and the turn is made visible on a best-effort basis.
   */
  private async recordAcceptedTurn(baseline: string | undefined): Promise<void> {
    try {
      await this.startRun(baseline)
    } catch (err) {
      logEvent("turn.record_failed", { error: errorMessage(err) })
      await this.store.patch({ phase: "running", turnBaseline: baseline }).catch(() => {})
      await this.ctx.storage.setAlarm(Date.now() + POLL_MS).catch(() => {})
    }
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
    await this.releaseLease()
    this.ready = false
    this.opencodePort = undefined
    // A reset must not leave a checkpoint that the next cold start would
    // restore over the freshly cleared conversation.
    await this.deleteCheckpoints()
    await this.ctx.storage.deleteAll()
    return Response.json({ ok: true })
  }

  /** Remove every archived workspace for this conversation, including legacy keys. */
  private async deleteCheckpoints(): Promise<void> {
    const prefix = this.checkpointPrefix()
    let cursor: string | undefined
    do {
      const page = await this.env.CHECKPOINTS.list({ prefix, cursor })
      for (const object of page.objects) await this.env.CHECKPOINTS.delete(object.key)
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    await this.env.CHECKPOINTS.delete(`workspaces/${this.ctx.id.toString()}.tar.gz`)
  }

  /**
   * Recycle the container so the next call starts the current image. State is
   * kept: this is what a long-lived conversation needs after an image deploy.
   */
  private async onRecycle(): Promise<Response> {
    // Capture a snapshot before stopping so the next start is fast. The R2
    // archive is the portable source of truth, so make sure it is current
    // before the image snapshot can be invalidated. A failed checkpoint must
    // stop the recycle: an image change makes the snapshot stale, so the next
    // start would restore an older archive and lose the latest turn.
    const saved = await this.checkpoint()
    if (!saved) {
      return Response.json(
        { ok: false, error: "checkpoint failed; not recycling" },
        { status: 503 },
      )
    }
    await this.captureSnapshot()
    try {
      await this.ctx.container?.destroy()
    } catch {
      /* already stopped */
    }
    await this.releaseLease()
    this.ready = false
    this.opencodePort = undefined
    return Response.json({ ok: true })
  }

  /** Remove the workspace archives and this conversation's stored state. */
  private async onDelete(): Promise<Response> {
    try {
      await this.ctx.container?.destroy()
    } catch {
      /* already stopped */
    }
    await this.releaseLease()
    this.ready = false
    this.opencodePort = undefined
    await this.deleteCheckpoints()
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

  /**
   * Load or create the control-plane token. It is persisted so a restarted DO
   * instance can still drive the container the previous instance started.
   */
  private async controlToken(): Promise<string> {
    if (this.controlTokenValue) return this.controlTokenValue
    const stored = await this.ctx.storage.get<string>("controlToken")
    if (stored) {
      this.controlTokenValue = stored
      return stored
    }
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
    await this.ctx.storage.put("controlToken", token)
    this.controlTokenValue = token
    return token
  }

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
      ...(this.controlTokenValue ? { env: { CONTROL_TOKEN: this.controlTokenValue } } : {}),
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
    return withSpan("container.snapshot", async (span) => {
      try {
        const snapshot = await this.ctx.container?.snapshotContainer({ name: "turn" })
        if (!snapshot) return
        await this.ctx.storage.put("snapshot", snapshot)
        span.setAttribute("snapshot.bytes", snapshot.size)
        logEvent("snapshot.saved", { bytes: snapshot.size })
        await this.count("snapshot.saved")
      } catch (error) {
        span.recordException(error as Error)
        logEvent("snapshot.failed")
        void this.count("snapshot.failed")
      }
    })
  }

  private async acquireLease(): Promise<void> {
    // Onboarding is admin work and must not be blocked by warm conversations.
    if (this.key === ONBOARDING_KEY) return
    const response = await this.env.SETTINGS.getByName("global").fetch(
      "https://settings/leases/acquire",
      {
        method: "POST",
        body: JSON.stringify({ id: this.ctx.id.toString(), ttlMs: LEASE_TTL_MS }),
      },
    )
    if (response.ok) {
      this.leaseHeld = true
      return
    }
    void this.count("capacity.rejected")
    throw new Error("container capacity reached")
  }

  private async releaseLease(): Promise<void> {
    if (!this.leaseHeld) return
    this.leaseHeld = false
    try {
      await this.env.SETTINGS.getByName("global").fetch("https://settings/leases/release", {
        method: "POST",
        body: JSON.stringify({ id: this.ctx.id.toString() }),
      })
    } catch {
      /* the lease expires on its own */
    }
  }

  private applyInactivity(container: NonNullable<typeof this.ctx.container>): void {
    if (this.inactivitySet) return
    this.inactivitySet = true
    void container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS).catch(() => {})
  }

  /** Start the container, preferring a snapshot when one is available. */
  private async startContainer(): Promise<boolean> {
    const container = this.ctx.container
    if (!container) throw new Error("no container bound")
    // The token must exist before the container process starts, because it is
    // passed in the container environment.
    await this.controlToken()
    await this.acquireLease()
    try {
      return await this.startBoundContainer(container)
    } catch (error) {
      // A failed start must not hold a slot for the lease's full lifetime.
      await this.releaseLease()
      throw error
    }
  }

  /** Start a bound container from the snapshot when possible, else the image. */
  private async startBoundContainer(container: NonNullable<typeof this.ctx.container>): Promise<boolean> {
    return withSpan("container.start", async (span) => {
      const snapshot = await this.snapshotHandle()
      if (snapshot) {
      try {
        container.start({ ...this.startOptions(), image: undefined, containerSnapshot: snapshot } as ContainerStartupOptions)
        this.startMode = "snapshot"
        this.applyInactivity(container)
        span.setAttribute("container.start_mode", "snapshot")
        logEvent("snapshot.restored")
        void this.count("snapshot.restored")
        return true
      } catch {
        logEvent("snapshot.stale")
        void this.count("snapshot.stale")
        span.setAttribute("container.snapshot_stale", true)
        await this.clearSnapshot()
      }
      }
      container.start(this.startOptions())
      this.startMode = "image"
      this.applyInactivity(container)
      span.setAttribute("container.start_mode", "image")
      return false
    })
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

    // The daily budget is a ceiling for every transport, not just HTTP.
    const spent = await this.budgetBlocked()
    if (spent !== undefined) {
      await this.postChunked(
        target.channel,
        `⚠️ Daily budget reached (spent $${spent.toFixed(2)}). Raise the budget in settings or wait for the daily reset.`,
        target.replyTs,
      ).catch(() => {})
      return Response.json({ ok: true })
    }

    let prompt = text
    let sessionID = ""
    let baseline: string | undefined
    let accepted = false
    try {
      prompt = await this.buildPrompt(event.channel, event.ts, event.thread_ts, text)
      if (!(await this.claimAdmission())) {
        const queued = await this.enqueue(prompt, target)
        accepted = queued
        if (!queued) {
          await this.postChunked(
            target.channel,
            "⚠️ Container busy and a message is already queued.",
            target.replyTs,
          ).catch(() => {})
        }
        return Response.json({ ok: true, queued })
      }
      sessionID = await this.ensureSession(text, "slack", target)
      baseline = await this.turnBaseline(sessionID)
      // Once this call returns, the prompt has been accepted by OpenCode.
      await this.withClient((client) => client.session.prompt({ sessionID, text: prompt }))
      accepted = true
    } catch (err) {
      this.admitting = false
      logEvent("admission.failed", { transport: "slack" })
      const queued = await this.enqueue(prompt, target)
      accepted = queued
      if (!queued) {
        await this.store.advance("idle")
        await this.postChunked(
          target.channel,
          `⚠️ Container busy and a message is already queued: ${errorMessage(err)}`,
          target.replyTs,
        ).catch(() => {})
      }
      return Response.json({ ok: true, queued })
    } finally {
      // Only a message we could not accept is released for a Slack redelivery.
      if (!accepted && input.eventID) await this.store.releaseEvent(input.eventID).catch(() => {})
    }

    // The prompt is accepted; bookkeeping and stream failures must not re-send it.
    await this.recordAcceptedTurn(baseline)
    const settings = await this.settings().catch(() => undefined)
    if (settings?.streaming) this.ctx.waitUntil(this.startStream(sessionID))
    return Response.json({ ok: true, sessionID })
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
    // A failed turn, timeout or checkpoint must not leave the thread silent.
    if (event.type === "error") {
      await this.postChunked(state.slack.channel, `⚠️ ${event.message}`, state.slack.replyTs)
    }
  }

  // ------------------------------------------------------------------- prompt

  private async ensureSession(text: string, transport: Transport, slack?: SlackTarget): Promise<string> {
    const state = await this.store.get()
    if (state.sessionID && (await this.sessionUsable(state.sessionID))) {
      if (slack && (state.slack?.channel !== slack.channel || state.slack?.replyTs !== slack.replyTs)) {
        await this.store.patch({ slack })
      }
      return state.sessionID
    }
    if (state.sessionID) {
      // The OpenCode database was reset or restored without this session.
      // Create a replacement before clearing the old one, so a transient
      // container failure cannot erase a session that still exists.
      logEvent("session.stale", { sessionID: state.sessionID })
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
    await this.store.patch({
      sessionID,
      transport,
      ...(slack ? { slack } : {}),
      // A replacement session has no history: baseline, pending requests and
      // per-session usage all belong to the session that disappeared.
      ...(state.sessionID
        ? {
            pending: {},
            turnBaseline: undefined,
            lastReply: undefined,
            lastSlackReply: undefined,
            reportedError: undefined,
            usage: undefined,
            usageError: undefined,
          }
        : {}),
    })
    return sessionID
  }

  /** Is this session still present in OpenCode? */
  private async sessionUsable(sessionID: string): Promise<boolean> {
    try {
      return await this.withClient(async (client) => {
        try {
          await client.session.get({ sessionID })
          return true
        } catch {
          // A missing session is an expected outcome, not a container failure:
          // handle it here so it does not trip the readiness breaker.
          return false
        }
      })
    } catch {
      return false
    }
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
      await this.store.patch({ phase: "running" })
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
      // A long turn can outlive the lease; the poll keeps the slot reserved.
      void this.acquireLease().catch(() => {})

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
      // Settlement never hides a failure: a step that errored still completes,
      // but with an empty body, so report the error rather than going quiet.
      const failure = turnFailure(messages, state.turnBaseline, state.runStartedAt)

      if (reply && reply !== state.lastReply) {
        // SSE streams every change; Slack gets one message per turn, at settle.
        await this.deliver({ type: "assistant", text: reply }, { slack: false })
        await this.store.patch({ lastReply: reply })
      }

      await this.pollPermissions(sessionID, pending)

      if (settled || failure) {
        await this.finishTurn(state, reply, failure, messages)
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
    messages?: MessageInfo[],
  ): Promise<void> {
    return withSpan(
      "conversation.settle",
      async (span) => {
        span.setAttributes({
          "conversation.failed": Boolean(failure),
          ...(state.runStartedAt ? { "conversation.turn_ms": Date.now() - state.runStartedAt } : {}),
          "conversation.reply_chars": reply.length,
        })
        await this.settleTurn(state, reply, failure, messages)
      },
      { "conversation.key": this.key ?? "unknown" },
    )
  }

  /** End-of-turn bookkeeping; runs inside the settle span. */
  private async settleTurn(
    state: ConversationState,
    reply: string,
    failure?: TurnFailure,
    messages?: MessageInfo[],
  ): Promise<void> {
    await this.store.advance("settling")
    void this.count(failure ? "turn.failed" : "turn.settled")
    logEvent(failure ? "turn.failed" : "turn.settled", {
      ...(state.runStartedAt ? { durationMs: Date.now() - state.runStartedAt } : {}),
      ...(failure ? { error: failure.message.slice(0, 200) } : {}),
      queued: Boolean(state.queued),
    })
    // Usage must not depend on the warm event stream: a deployment with
    // streaming off still has to feed the daily ledger. The context carries
    // each step's cost, and the report is absolute per conversation per day.
    if (messages) await this.recordContextUsage(messages).catch(() => {})
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

  /**
   * Record today's spend for this conversation from the message context. This
   * is the streaming-independent path: it runs at settle time and writes an
   * absolute per-conversation entry, so a retry or a later poll overwrites
   * instead of double counting.
   */
  private async recordContextUsage(messages: MessageInfo[]): Promise<void> {
    const date = new Date().toISOString().slice(0, 10)
    const startOfDay = Date.parse(`${date}T00:00:00.000Z`)
    let costUSD = 0
    let input = 0
    let output = 0
    for (const message of messages) {
      if (message.type !== "assistant") continue
      const created = message.time?.created
      if (typeof created === "number" && toMillis(created) < startOfDay) continue
      costUSD += Number(message.cost ?? 0) || 0
      input += Number(message.tokens?.input ?? 0) || 0
      output += Number(message.tokens?.output ?? 0) || 0
    }
    if (costUSD === 0 && input === 0 && output === 0) return
    const usage = { date, costUSD, input, output }
    await this.store.patch({ usage, usageError: undefined })
    await this.env.SETTINGS.getByName("global").fetch("https://settings/usage", {
      method: "POST",
      body: JSON.stringify({ conversationID: this.ctx.id.toString(), ...usage }),
    })
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
    if (number === OPENCODE_PORT) {
      // The test seam replaces the container port directly. In production the
      // DO has no OpenCode password, so it goes through the control server,
      // which authenticates to OpenCode on loopback.
      if (this.transport) return this.rawPort(number)
      return opencodeViaControl(await this.controlPort())
    }
    const base = await this.rawPort(number)
    if (number !== CONTROL_PORT) return base
    return this.withControlAuth(base)
  }

  private async controlPort(): Promise<ContainerPort> {
    return this.port(CONTROL_PORT)
  }

  private async withControlAuth(base: ContainerPort): Promise<ContainerPort> {
    const token = await this.controlToken()
    return {
      fetch: (input, init) => {
        const request = new Request(input as any, init)
        request.headers.set("authorization", `Bearer ${token}`)
        return base.fetch(request)
      },
    }
  }

  private async rawPort(number: number): Promise<ContainerPort> {
    if (this.transport) return this.transport(number)
    if (this.env.CONTAINER_URL) {
      const host = new URL(this.env.CONTAINER_URL).hostname
      return {
        fetch: (input, init) => {
          const original = input instanceof Request ? input : new Request(input as any, init)
          const url = new URL(original.url)
          url.hostname = host
          url.port = String(number)
          return fetch(url.toString(), {
            method: original.method,
            headers: original.headers,
            body: original.body,
          })
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
    const path = "/health"
    const ready = async (limit: number): Promise<boolean> => {
      for (let attempt = 0; attempt < limit; attempt++) {
        try {
          const res = await port.fetch(`http://container${path}`, {
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
      void this.count("snapshot.stale")
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
      const client = makeClient(portFetch(port))
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
        await this.releaseLease()
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
    if (this.leaseHeld) void this.acquireLease().catch(() => {})
    if (this.ctx.container?.running) this.applyInactivity(this.ctx.container)
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
      if (checkpoint) {
        const workspace = await this.decryptCheckpointBody(
          checkpoint.workspace.body,
          checkpoint.workspace.customMetadata?.encrypted === "1",
        )
        const workspaceQuery = checkpoint.split
          ? `?part=workspace${checkpoint.state ? "" : "&final=1"}`
          : ""
        const restoredWorkspace = await control.fetch(
          `http://container/restore${workspaceQuery}`,
          {
            method: "POST",
            body: workspace,
            signal: AbortSignal.timeout(60_000),
          },
        )
        if (!restoredWorkspace.ok) {
          logEvent("checkpoint.restore.failed", {
            part: "workspace",
            status: restoredWorkspace.status,
          })
          throw new Error(`workspace restore failed: ${restoredWorkspace.status}`)
        }
        if (checkpoint.state) {
          const state = await this.decryptCheckpointBody(
            checkpoint.state.body,
            checkpoint.state.customMetadata?.encrypted === "1",
          )
          const restoredState = await control.fetch("http://container/restore?part=state", {
            method: "POST",
            body: state,
            signal: AbortSignal.timeout(60_000),
          })
          if (!restoredState.ok) {
            logEvent("checkpoint.restore.failed", { part: "state", status: restoredState.status })
            throw new Error(`state restore failed: ${restoredState.status}`)
          }
        }
        await this.store.patch({
          checkpointFingerprint: undefined,
          checkpointStateFingerprint: undefined,
        })
      } else {
        // A fresh conversation inherits the account's provider credentials, so
        // onboarding only has to happen once. A namespaced agent uses its own
        // seed and never falls back to the legacy global one.
        const seed = await this.env.CHECKPOINTS.get(
          accountStateKey(parseConversationKey(this.key)),
        )
        if (seed?.body) {
          const body =
            seed.customMetadata?.encrypted === "1"
              ? await this.decryptCheckpointBody(seed.body, true)
              : seed.body
          const seeded = await control.fetch("http://container/seed-state", {
            method: "POST",
            body,
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
    // The control server keeps the OpenCode password; /start returns no secret.
    await this.store.increment("containerStarts")

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
    const nextAttemptAt = Date.now() + 5000
    const claimed = await this.store.enqueue({
      text,
      ...(slack ? { slack } : {}),
      attempts: 0,
      nextAttemptAt,
    })
    if (!claimed) return false
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

    // A queued message is still subject to the same ceiling as a live one.
    // Keep it queued and retry after the ledger rolls over instead of dropping it.
    const spent = await this.budgetBlocked()
    if (spent !== undefined) {
      this.admitting = false
      const retryAt = nextBudgetReset(Date.now())
      const notice = "daily budget reached"
      if (queued.slack && queued.lastError !== notice) {
        await this.postChunked(
          queued.slack.channel,
          `⚠️ Daily budget reached (spent $${spent.toFixed(2)}). I'll retry this queued message after the daily reset.`,
          queued.slack.replyTs,
        ).catch(() => {})
      }
      await this.store.patch({ queued: { ...queued, lastError: notice, nextAttemptAt: retryAt } })
      await this.store.advance("queued")
      await this.ctx.storage.setAlarm(retryAt)
      return false
    }

    let sessionID = ""
    let baseline: string | undefined
    try {
      sessionID = await this.ensureSession(queued.text, queued.slack ? "slack" : "http", queued.slack)
      baseline = await this.turnBaseline(sessionID)
      // Once this call returns, the prompt has been accepted by OpenCode.
      await this.withClient((client) => client.session.prompt({ sessionID, text: queued.text }))
    } catch (err) {
      this.admitting = false
      // Capacity pressure is temporary: keep the message queued until a lease
      // frees up instead of burning the prompt-retry budget and dropping it.
      if (isCapacityRejection(err)) {
        const retryAt = Date.now() + CAPACITY_RETRY_MS
        await this.store.patch({
          queued: { ...queued, lastError: "container capacity reached", nextAttemptAt: retryAt },
        })
        await this.store.advance("queued")
        logEvent("queue.capacity", { attempts: queued.attempts })
        await this.ctx.storage.setAlarm(retryAt)
        return false
      }
      const attempts = queued.attempts + 1
      if (attempts >= 5) {
        await this.store.patch({ queued: undefined, lastTurnError: errorMessage(err) })
        await this.store.advance("idle")
        void this.count("queue.failed")
        logEvent("queue.failed", { attempts })
        await this.deliver(
          { type: "error", message: `queued message could not start: ${errorMessage(err)}` },
          { slack: false },
        )
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

    // The prompt is accepted. Clear the queue before recording the turn, so a
    // bookkeeping failure cannot cause the same message to be prompted again.
    await this.store.patch({ queued: undefined })
    void this.count("queue.drained")
    logEvent("queue.drained", { attempts: queued.attempts })
    await this.recordAcceptedTurn(baseline)
    const settings = await this.settings().catch(() => undefined)
    if (settings?.streaming) this.ctx.waitUntil(this.startStream(sessionID))
    return true
  }

  private checkpointPrefix(): string {
    return `workspaces/${this.ctx.id.toString()}/`
  }

  /**
   * Newest checkpoint. A manifest describes two independent objects; the
   * pre-split layout is a single object and stays read-only during migration.
   */
  private async latestCheckpoint(): Promise<{
    workspace: R2ObjectBody
    state: R2ObjectBody | null
    split: boolean
  } | null> {
    const manifest = (await this.store.get()).checkpointManifest
    if (manifest?.workspace) {
      const workspace = await this.env.CHECKPOINTS.get(manifest.workspace.key)
      if (workspace) {
        const state = manifest.state
          ? await this.env.CHECKPOINTS.get(manifest.state.key)
          : null
        return { workspace, state, split: true }
      }
      logEvent("checkpoint.manifest.missing", { key: manifest.workspace.key })
    }
    const list = await this.env.CHECKPOINTS.list({ prefix: this.checkpointPrefix() })
    const newest = list.objects
      .map((object) => object.key)
      // Do not mistake a split state archive for a legacy workspace archive.
      .filter((key) => !/\/state-[^/]*\.tar\.gz$/.test(key))
      .sort()
      .at(-1)
    const legacy = await this.env.CHECKPOINTS.get(
      newest ?? `workspaces/${this.ctx.id.toString()}.tar.gz`,
    )
    return legacy ? { workspace: legacy, state: null, split: false } : null
  }

  /** Drop old versions, keeping the most recent few of each part. */
  private async pruneCheckpoints(): Promise<void> {
    const list = await this.env.CHECKPOINTS.list({ prefix: this.checkpointPrefix() })
    const keys = list.objects
      .map((object) => object.key)
      // A split checkpoint pairs a workspace and a state object. Pruning by
      // total count could delete one half of a pair; prune per part instead.
      .sort()
    const workspaceKeys = keys.filter((key) => /-workspace-/.test(key))
    const stateKeys = keys.filter((key) => /-state-/.test(key))
    const legacyKeys = keys.filter((key) => !/-(workspace|state)-/.test(key))
    const stale = [
      ...workspaceKeys.slice(0, Math.max(0, workspaceKeys.length - CHECKPOINT_KEEP)),
      ...stateKeys.slice(0, Math.max(0, stateKeys.length - CHECKPOINT_KEEP)),
      ...legacyKeys.slice(0, Math.max(0, legacyKeys.length - CHECKPOINT_KEEP)),
    ]
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
      await this.deliver({
        type: "error",
        message: "workspace checkpoint failed repeatedly; recent changes may not be recoverable",
      }).catch(() => {})
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

  /** Tenant-scoped archive key, or undefined when plaintext storage is allowed. */
  private async checkpointCryptoKey(): Promise<CryptoKey | undefined> {
    const master = this.env.VAULT_MASTER_KEY
    if (!master) {
      // Provider credentials live in the state archive, so a missing key must
      // not silently downgrade to plaintext R2 objects.
      if (plaintextArchivesAllowed(this.env)) return undefined
      throw new Error(
        "VAULT_MASTER_KEY is required to encrypt checkpoints; set it or explicitly allow plaintext archives",
      )
    }
    return deriveWorkspaceKey(master, workspaceID(this.env))
  }

  /** Decrypt a stored archive before handing it to the restore endpoint. */
  private async decryptCheckpointBody(
    body: ReadableStream,
    encrypted: boolean,
  ): Promise<ReadableStream> {
    if (!encrypted) return body
    const key = await this.checkpointCryptoKey()
    if (!key) {
      throw new Error("checkpoint is encrypted but VAULT_MASTER_KEY is not configured")
    }
    return body.pipeThrough(decryptTransform(key))
  }

  /** Stream one checkpoint part into R2 and prove the object is complete. */
  private async uploadCheckpointPart(
    key: string,
    response: Response,
    cryptoKey: CryptoKey | undefined,
  ): Promise<number> {
    if (!response.body) throw new Error("checkpoint part has no body")
    const encrypted = Boolean(cryptoKey)
    const length = Number(response.headers.get("content-length"))
    const metadata = { customMetadata: { encrypted: encrypted ? "1" : "0" } }
    let bytes: number
    if (cryptoKey) {
      if (Number.isFinite(length) && length > 0) {
        // Encrypt as the body streams; the framed format has a deterministic
        // length, so R2 still gets a fixed-length stream.
        const sealed = response.body.pipeThrough(encryptTransform(cryptoKey))
        const cipherLength = encryptedLength(length)
        const fixed = new FixedLengthStream(cipherLength)
        const piping = sealed.pipeTo(fixed.writable)
        await Promise.all([this.env.CHECKPOINTS.put(key, fixed.readable, metadata), piping])
        bytes = cipherLength
      } else {
        const plain = new Uint8Array(await response.arrayBuffer())
        const sealed = await encryptBytes(plain, cryptoKey)
        await this.env.CHECKPOINTS.put(key, sealed, metadata)
        bytes = sealed.byteLength
      }
    } else if (Number.isFinite(length) && length > 0) {
      // R2 needs a stream of known length; the control server sends one.
      const counted = countedStream(response.body)
      const fixed = new FixedLengthStream(length)
      const piping = counted.stream.pipeTo(fixed.writable)
      // Await both: a stream error must fail the checkpoint, not be silently
      // swallowed while R2 keeps a truncated object.
      await Promise.all([this.env.CHECKPOINTS.put(key, fixed.readable, metadata), piping])
      bytes = counted.bytes()
    } else {
      // Older control servers streamed without a length.
      const buffer = await response.arrayBuffer()
      await this.env.CHECKPOINTS.put(key, buffer, metadata)
      bytes = buffer.byteLength
    }
    const stored = await this.env.CHECKPOINTS.head(key)
    if (!stored) throw new Error("checkpoint upload disappeared")
    if (stored.size !== bytes) {
      await this.env.CHECKPOINTS.delete(key)
      throw new Error(`checkpoint size mismatch: ${stored.size} != ${bytes}`)
    }
    return bytes
  }

  /** Verify a part that the control server reported as unchanged. */
  private async requireCheckpointPart(
    part: { key: string } | undefined,
    kind: "workspace" | "state",
  ): Promise<void> {
    if (!part) return
    const head = await this.env.CHECKPOINTS.head(part.key)
    if (head) return
    logEvent("checkpoint.missing", { key: part.key })
    await this.store.patch(
      kind === "workspace"
        ? { checkpointFingerprint: undefined, checkpointKey: undefined }
        : { checkpointStateFingerprint: undefined },
    )
    throw new Error("checkpoint was skipped but the archive is missing")
  }

  private async checkpoint(): Promise<boolean> {
    // The control server archives the workspace without stopping OpenCode, so
    // the cached port stays valid across a checkpoint.
    return withSpan("conversation.checkpoint", async (span) => {
      const stamp = Date.now()
      const prefix = this.checkpointPrefix()
      const workspaceKey = `${prefix}workspace-${stamp}.tar.gz`
      const stateKey = `${prefix}state-${stamp}.tar.gz`
      try {
        // Fail fast on a missing key instead of retrying a configuration error.
        await this.checkpointCryptoKey()
        await withRetries(
          async () => {
            const state = await this.store.get()
            const cryptoKey = await this.checkpointCryptoKey()
            const encrypted = Boolean(cryptoKey)
            // Toggling encryption must not be skipped by a matching fingerprint.
            const matching = state.checkpointEncrypted === encrypted
            const workspaceSince = matching ? state.checkpointFingerprint ?? "" : ""
            const stateSince = matching ? state.checkpointStateFingerprint ?? "" : ""
            const control = await this.port(CONTROL_PORT)
            const response = await control.fetch(
              `http://container/checkpoint?part=workspace&since=${encodeURIComponent(workspaceSince)}`,
              { signal: AbortSignal.timeout(120_000) },
            )
            const split = response.headers.get("x-aboiteau-checkpoint") === "split"

            if (!split) {
              // Legacy control server: one archive, one key. Kept for rolling
              // deploys so an older image still checkpoints.
              if (response.status === 204) {
                await this.requireCheckpointPart(
                  state.checkpointKey ? { key: state.checkpointKey } : undefined,
                  "workspace",
                )
                void this.count("checkpoint.skipped")
                logEvent("checkpoint.skipped")
                return
              }
              if (!response.ok) throw new Error(`checkpoint returned ${response.status}`)
              const bytes = await this.uploadCheckpointPart(workspaceKey, response, cryptoKey)
              span.setAttribute("checkpoint.bytes", bytes)
              void this.count("checkpoint.saved")
              logEvent("checkpoint.saved", { bytes })
              await this.store.patch({
                checkpointSize: bytes,
                checkpointKey: workspaceKey,
                checkpointEncrypted: encrypted,
              })
              const fingerprint = response.headers.get("x-workspace-fingerprint")
              if (fingerprint) await this.store.patch({ checkpointFingerprint: fingerprint })
              await this.pruneCheckpoints()
              return
            }

            let manifest = state.checkpointManifest
            let workspacePart = manifest?.workspace
            let statePart = manifest?.state
            let uploaded = false

            if (response.status === 204) {
              if (!workspacePart) {
                // No archive to reuse: retry as a full checkpoint.
                await this.store.patch({ checkpointFingerprint: undefined })
                throw new Error("checkpoint was skipped but no manifest exists")
              }
              await this.requireCheckpointPart(workspacePart, "workspace")
            } else if (response.ok) {
              const bytes = await this.uploadCheckpointPart(workspaceKey, response, cryptoKey)
              workspacePart = { key: workspaceKey, size: bytes, encrypted }
              uploaded = true
            } else {
              throw new Error(`checkpoint returned ${response.status}`)
            }

            const stateResponse = await control.fetch(
              `http://container/checkpoint?part=state&since=${encodeURIComponent(stateSince)}`,
              { signal: AbortSignal.timeout(120_000) },
            )
            let stateFingerprint = manifest?.stateFingerprint
            if (stateResponse.status === 204) {
              if (!statePart) {
                // The control server says "unchanged" but we hold no archive to
                // restore from. Force a full state archive on the retry.
                await this.store.patch({ checkpointStateFingerprint: undefined })
                throw new Error("state checkpoint was skipped but no archive exists")
              }
              await this.requireCheckpointPart(statePart, "state")
              stateFingerprint =
                stateResponse.headers.get("x-state-fingerprint") ?? stateFingerprint
            } else if (stateResponse.status === 404) {
              // Fresh conversation: no state root yet.
              statePart = undefined
              stateFingerprint = undefined
            } else if (stateResponse.ok) {
              const bytes = await this.uploadCheckpointPart(stateKey, stateResponse, cryptoKey)
              statePart = { key: stateKey, size: bytes, encrypted }
              stateFingerprint =
                stateResponse.headers.get("x-state-fingerprint") ?? stateFingerprint
              uploaded = true
            } else {
              throw new Error(`state checkpoint returned ${stateResponse.status}`)
            }

            const fingerprint =
              response.headers.get("x-workspace-fingerprint") ?? manifest?.fingerprint

            if (!uploaded) {
              // Both parts unchanged and both objects verified.
              void this.count("checkpoint.skipped")
              logEvent("checkpoint.skipped")
              return
            }

            const next: CheckpointManifest = {
              workspace: workspacePart!,
              ...(statePart ? { state: statePart } : {}),
              ...(fingerprint ? { fingerprint } : {}),
              ...(stateFingerprint ? { stateFingerprint } : {}),
              createdAt: Date.now(),
            }
            const bytes = next.workspace.size + (next.state?.size ?? 0)
            span.setAttribute("checkpoint.bytes", bytes)
            void this.count("checkpoint.saved")
            logEvent("checkpoint.saved", { bytes })
            await this.store.patch({
              checkpointManifest: next,
              checkpointKey: next.workspace.key,
              checkpointSize: bytes,
              checkpointEncrypted: encrypted,
              ...(fingerprint ? { checkpointFingerprint: fingerprint } : {}),
              ...(stateFingerprint ? { checkpointStateFingerprint: stateFingerprint } : {}),
            })
            await this.pruneCheckpoints()
          },
          { attempts: 3, delayMs: 1000 },
        )
        await this.store.patch({
          checkpointPending: undefined,
          checkpointAttempts: undefined,
        })
        return true
      } catch (err) {
        span.recordException(err as Error)
        console.warn("checkpoint failed", err)
        void this.count("checkpoint.failed")
        logEvent("checkpoint.failed")
        // Keep the failure visible and retry from the alarm instead of losing the
        // turn's work silently.
        await this.store.patch({ checkpointPending: true })
        await this.ctx.storage.setAlarm(Date.now() + CHECKPOINT_RETRY_MS)
        return false
      }
    })
  }

  /** Drop the cached port so the next call re-checks and restarts OpenCode. */
  private invalidateOpenCode(): void {
    this.ready = false
    this.opencodePort = undefined
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
            button("Approve once", "primary", "oc_perm_once", key, event.requestID, target.channel),
            button("Always allow", undefined, "oc_perm_always", key, event.requestID, target.channel),
            button("Deny", "danger", "oc_perm_reject", key, event.requestID, target.channel),
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
  channel: string,
): Record<string, unknown> {
  return {
    type: "button",
    text: { type: "plain_text", text: label },
    ...(style ? { style } : {}),
    action_id: actionID,
    value: JSON.stringify({ key, requestID, channel }),
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
