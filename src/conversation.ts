import { DurableObject } from "cloudflare:workers"
import { Lifecycle } from "agents/lifecycle"
import { ClientError } from "@opencode/client"
import { makeClient, portFetch, type ContainerPort } from "./opencode"
import {
  ConversationStore,
  type BudgetReservation,
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
  isSettled,
  turnMessages,
  toMillis,
  type MessageInfo,
} from "./messages"
import type { ConversationEvent } from "./events"
import { ConversationEventStream } from "./conversation/event-stream"
import { ConversationCheckpoints } from "./conversation/checkpoints"
import { ConversationRuntime } from "./conversation/runtime"
import { ConversationIdleClose } from "./conversation/idle-close"
import { ConversationRuntimeAccess } from "./conversation/runtime-access"
import { ConversationUsage } from "./conversation/usage"
import { ConversationRecoveryActions } from "./conversation/recovery-actions"
import { ConversationControlPlane } from "./conversation/control-plane"
import { ConversationImages } from "./conversation/images"
import { ConversationLease } from "./conversation/lease"
import { ConversationBudgetReservations, type BudgetReservationResult } from "./conversation/budget-reservations"
import { ConversationTurnExecution } from "./conversation/turn-execution"
import { ConversationReadiness } from "./conversation/readiness"
import { ConversationReconciliation } from "./conversation/reconciliation"
import { ConversationAccountingCutover } from "./conversation/accounting-cutover"
import { ConversationAdmissions, isBusyPhase } from "./conversation/admissions"
import { ConversationRuntimeUpgrades } from "./conversation/runtime-upgrades"
import { isFreshLegacyAlarmMigration } from "./conversation/job-state"
import type { PermissionRequest, SlackFormRequest } from "./conversation/control-plane"
export type { PermissionRequest, SlackFormRequest } from "./conversation/control-plane"
import { parseModelRef, type Env } from "./env"
import { retryAfterSeconds } from "./backoff"
import { logEvent } from "./log"
import type { HarnessSettings } from "./settings"
import { staleAction } from "./lifecycle"
import { GITHUB_TOKEN_KEY, workspaceID } from "./vault"
import { LEGACY_ACCOUNT_STATE_KEY, parseConversationKey } from "./tenancy"
import { AccountingPolicyError } from "./accounting-policy"
import { IdleClosePendingError } from "./conversation/idle-close"
import { parseOperatorReconciliationProposal } from "./operator-reconciliation"
import { handleSlackCommand } from "./slack-commands"
import { hasConnectedProvider } from "./onboarding"
import { parseSlackCommand } from "./slack-command-format"
import {
  checkSlackImageModel,
  downloadSlackImage,
  formatSlackImageModelSuggestions,
  type ImageModelCheck,
  type SlackImageAttachment,
} from "./slack-images"
import type { ConversationJobPayload } from "./conversation/jobs"
import { ConversationScheduler } from "./conversation/scheduler"

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const OPENCODE_PORT = 4000
const CONTROL_PORT = 4001
const POLL_MS = 2000
/** Delay before retrying a checkpoint that failed after a turn. */
const CHECKPOINT_RETRY_MS = 30_000
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
  appUrl?: string
  event: NonNullable<SlackEventEnvelope["event"]>
}

export type { BudgetReservationResult } from "./conversation/budget-reservations"

/**
 * One Durable Object per conversation. Transport-neutral: every event is
 * emitted to SSE subscribers, and delivered to Slack when a Slack target is set.
 */
export class Conversation extends DurableObject<Env> {
  private readonly lifecycle: Lifecycle<Env>
  private readonly runtime: ConversationRuntime
  private readonly idleClose: ConversationIdleClose
  private readonly runtimeAccess: ConversationRuntimeAccess
  private readonly scheduler: ConversationScheduler
  private readonly store: ConversationStore
  private readonly eventStream: ConversationEventStream
  private readonly checkpoints: ConversationCheckpoints
  private readonly usage: ConversationUsage
  private readonly recoveryActions: ConversationRecoveryActions
  private readonly controlPlane: ConversationControlPlane
  private readonly images: ConversationImages
  private readonly leases: ConversationLease
  private readonly budgetReservations: ConversationBudgetReservations
  private readonly turnExecution: ConversationTurnExecution
  private readonly readiness: ConversationReadiness
  private readonly reconciliation: ConversationReconciliation
  private readonly accountingCutover: ConversationAccountingCutover
  private readonly admissions: ConversationAdmissions
  private readonly runtimeUpgrades: ConversationRuntimeUpgrades
  private consecutiveFailures = 0
  /** Canonical name when named; forwarded key is only a validated fallback. */
  private key?: string
  /** Source onboarding work must finish before its runtime can be restarted. */
  private onboardingOperations = 0

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.key = ctx.id.name
    this.store = new ConversationStore(ctx.storage)
    this.usage = new ConversationUsage({
      conversationID: ctx.id.toString(),
      store: this.store,
      settings: { fetch: (input, init) => this.env.SETTINGS.getByName("global").fetch(input, init) },
      withClient: (fn, recoverOnRejection) => this.withClient(fn, recoverOnRejection),
    })
    this.runtime = new ConversationRuntime({
      conversationID: ctx.id.toString(),
      network: {
        transport: () => this.transport,
        containerURL: () => this.env.CONTAINER_URL,
      },
      binding: {
        get: () => this.ctx.container,
      },
      startup: {
        start: () => this.startContainer(),
        prepareImage: (container) => this.images.prepareContainerImageVariant(container),
        options: () => this.images.startOptions(),
      },
      snapshots: {
        snapshotHandle: () => this.images.snapshotHandle(),
        clearSnapshot: () => this.images.clearSnapshot(),
      },
      authorization: { controlToken: () => this.controlPlane.token() },
      lifecycle: { beforeStop: () => this.turnExecution.cancelStream() },
      observations: {
        snapshotStale: () => {
          logEvent("snapshot.stale")
          void this.count("snapshot.stale")
        },
        count: (name) => { void this.count(name) },
      },
    })
    this.runtimeAccess = new ConversationRuntimeAccess({
      prepareOwned: () => this.ensureReadyOwned(),
      onUseComplete: () => this.idleClose.touch().then(() => undefined).catch(() => {}),
      identity: () => ({
        port: this.runtime.apiPort,
        generation: this.runtime.generation,
        ready: this.runtime.ready,
        running: Boolean(this.transport || this.env.CONTAINER_URL || this.ctx.container?.running === true),
      }),
    })
    this.lifecycle = new Lifecycle(this)
    this.eventStream = new ConversationEventStream(this.store)
    this.lifecycle.use(this.eventStream)
    this.scheduler = new ConversationScheduler({
      storage: ctx.storage,
      store: this.store,
      waitUntil: (promise) => ctx.waitUntil(promise),
      adoptLeaseIfNeeded: () => this.scheduleLeaseAdoptionIfNeeded(),
      work: {
        turnObserve: (payload) => this.processTurnObservation(payload),
        admissionRetry: (payload) => this.processAdmissionRetry(payload),
        checkpointRetry: (payload) => this.processCheckpointRetry(payload),
        recoveryWake: (payload) => this.processRecoveryWake(payload),
        leaseRenew: (payload) => this.processLeaseRenew(payload),
        idleClose: (payload) => this.idleClose.run(payload),
      },
    })
    this.lifecycle.use(this.scheduler.capability)
    this.recoveryActions = new ConversationRecoveryActions({
      conversationID: ctx.id.toString(),
      storage: ctx.storage,
      store: this.store,
      usage: this.usage,
      settings: {
        fetch: (input, init) => this.env.SETTINGS.getByName("global").fetch(input, init),
      },
      withAdmissionLock: (task) => this.admissions.withLock(task),
      live: () => ({ admitting: this.admissions.active, pumping: this.turnExecution.isPumping, activeJobs: this.scheduler.activeCount }),
      jobs: {
        epoch: () => this.scheduler.epoch(),
        evidence: () => this.scheduler.evidence(),
        resumeSealedIdle: (evidence, state) => this.scheduler.resumeSealedIdle(evidence, state),
        scheduleRecovery: (at, payload, allowSealed) => this.scheduler.schedule("recovery:wake", at, payload, allowSealed),
      },
    })
    this.controlPlane = new ConversationControlPlane({
      conversationID: ctx.id.toString(),
      storage: ctx.storage,
      store: this.store,
      withClient: (fn, recoverOnRejection) => this.withClient(fn, recoverOnRejection),
      withAdmissionLock: (task) => this.admissions.withLock(task),
      hasPendingRuntimeUpgrade: () => this.runtimeUpgrades.hasPending(),
      scheduleObservation: (at, payload) => this.scheduler.schedule("turn:observe", at, payload),
    })
    this.images = new ConversationImages({
      storage: ctx.storage,
      runtime: this.runtime,
      container: () => this.ctx.container,
      key: () => this.key,
      env: () => ({
        EVENTED_CANARY_KEY: this.env.EVENTED_CANARY_KEY,
        EVENTED_FRESH_CONVERSATIONS: this.env.EVENTED_FRESH_CONVERSATIONS,
      }),
      cachedToken: () => this.controlPlane.cachedToken,
      count: (name) => this.count(name),
    })
    this.leases = new ConversationLease({
      storage: ctx.storage,
      count: (name) => this.count(name),
      settings: () => this.env.SETTINGS.getByName("global"),
      identity: {
        id: ctx.id.toString(),
        enabled: () => this.nativeLeaseEnabled(),
        confirmedStopped: () => this.runtime.confirmedStopped,
      },
      jobs: {
        schedule: (at, reason) => this.scheduler.schedule("lease:renew", at, { reason }),
        cancel: () => this.scheduler.cancel("lease:renew"),
      },
    })
    this.budgetReservations = new ConversationBudgetReservations({
      conversationID: ctx.id.toString(),
      storage: ctx.storage,
      store: this.store,
      settings: () => this.env.SETTINGS.getByName("global"),
      jobs: {
        cancelQueuedAdmission: () => this.scheduler.cancel("admission:retry"),
        observe: (at, payload) => this.scheduler.schedule("turn:observe", at, payload),
      },
      beforeDispatch: () => this.leases.ensureHeld(),
    })
    this.checkpoints = new ConversationCheckpoints({
      conversationID: ctx.id.toString(),
      workspaceID: workspaceID(env),
      store: this.store,
      storage: ctx.storage,
      bucket: env.CHECKPOINTS,
      archiveEnv: env,
      getControl: () => this.runtime.port(CONTROL_PORT),
      retry: {
        schedule: (at, reason) => this.scheduler.schedule("checkpoint:retry", at, { reason }),
        cancel: () => this.scheduler.cancel("checkpoint:retry"),
      },
      count: (name) => this.count(name),
      deliverError: (message) => this.deliver({ type: "error", message }),
      withRuntimeUse: (task) => this.runtimeAccess.useReady(() => task()),
    })
    this.turnExecution = new ConversationTurnExecution({
      conversationID: ctx.id.toString(),
      storage: ctx.storage,
      store: this.store,
      usage: this.usage,
      checkpoints: this.checkpoints,
      controlPlane: this.controlPlane,
      runtime: {
        openStream: (open) => this.runtimeAccess.useReady(open),
        withClient: (fn, recoverOnRejection) => this.withClient(fn, recoverOnRejection),
      },
      guards: {
        recovering: () => this.recoveryActions.active,
        hasPendingUpgrade: () => this.runtimeUpgrades.hasPending(),
      },
      delivery: {
        event: (event, options) => this.deliver(event, options),
        toSlack: (event) => this.deliverToSlack(event),
        slack: (method, body) => this.slack(method, body),
        count: (name) => this.count(name),
        slackBotToken: () => this.env.SLACK_BOT_TOKEN,
      },
      conversationKey: () => this.key ?? this.ctx.id.name ?? this.ctx.id.toString(),
      jobs: { schedule: (kind, at, payload) => this.scheduler.schedule(kind, at, payload) },
      settings: () => this.settings(),
      releaseBudgetReservation: (reservation) => this.releaseBudgetReservation(reservation),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    })
    this.readiness = new ConversationReadiness({
      storage: ctx.storage,
      store: this.store,
      runtime: this.runtime,
      images: this.images,
      checkpoints: this.checkpoints,
      leases: this.leases,
      identity: { id: ctx.id.toString(), key: () => this.key },
      platform: {
        container: () => this.ctx.container,
        transportEnabled: () => Boolean(this.transport),
      },
      env: () => this.env,
      configuration: {
        settings: () => this.settings(),
        githubToken: () => this.secret(GITHUB_TOKEN_KEY),
      },
      activity: {
        pumping: () => this.turnExecution.isPumping,
        onboardingOperations: () => this.onboardingOperations,
        upgradeResuming: () => this.runtimeUpgrades.resuming,
      },
      upgrade: {
        pending: () => this.runtimeUpgrades.pending(),
        checkpoint: (pending) => this.runtimeUpgrades.checkpoint(pending),
        proveSession: (client, sessionID) => this.runtimeUpgrades.proveSession(client, sessionID),
      },
      adoptLeaseIfNeeded: () => this.scheduleLeaseAdoptionIfNeeded(),
    })
    this.runtimeUpgrades = new ConversationRuntimeUpgrades({
      storage: ctx.storage,
      store: this.store,
      usage: this.usage,
      recoveryActions: this.recoveryActions,
      runtime: this.runtime,
      images: this.images,
      checkpoints: this.checkpoints,
      leases: this.leases,
      id: ctx.id.toString(),
      container: () => this.ctx.container,
      archives: { bucket: env.CHECKPOINTS, policyEnv: env },
      withAdmissionLock: (task) => this.admissions.withLock(task),
      live: () => ({ admitting: this.admissions.active, pumping: this.turnExecution.isPumping }),
      withClient: (fn, recoverOnRejection) => this.withClient(fn, recoverOnRejection),
      withRuntimeUse: (task) => this.runtimeAccess.useReady(() => task()),
      withRuntimeExclusive: (task) => this.runtimeAccess.exclusive(task),
      prepareOwned: () => this.ensureReadyOwned(),
      stopStream: () => this.turnExecution.stopStream(),
    })
    this.admissions = new ConversationAdmissions({
      conversationID: ctx.id.toString(),
      storage: ctx.storage,
      store: this.store,
      budgetReservations: this.budgetReservations,
      session: {
        ensure: (text, transport, slack) => this.ensureSession(text, transport, slack),
        baseline: (sessionID) => this.turnBaseline(sessionID),
      },
      recovery: {
        active: () => this.recoveryActions.active,
        pumping: () => this.turnExecution.isPumping,
        pendingUpgrade: () => this.runtimeUpgrades.hasPending(),
      },
      jobs: { schedule: (kind, at, payload) => this.scheduler.schedule(kind, at, payload) },
      prompt: async (sessionID, text) => {
        await this.withClient((client) => client.session.prompt({ sessionID, text }))
      },
      settings: async () => ({ streaming: (await this.settings()).streaming }),
      delivery: {
        event: (event, options) => this.deliver(event, options),
        postChunked: (channel, text, threadTs) => this.postChunked(channel, text, threadTs),
        count: (name) => this.count(name),
      },
      startStream: (sessionID) => this.turnExecution.startStream(sessionID),
      waitUntil: (promise) => ctx.waitUntil(promise),
    })
    const runtime = this.runtime
    this.idleClose = new ConversationIdleClose({
      storage: ctx.storage,
      store: this.store,
      id: ctx.id.toString(),
      runtime: {
        get apiPort() { return runtime.apiPort },
        get generation() { return runtime.generation },
        get confirmedStopped() { return runtime.confirmedStopped },
        port: (number) => runtime.port(number),
        stop: () => runtime.stop(),
        nativeRunning: () => ctx.container?.running === true,
      },
      access: this.runtimeAccess,
      usage: this.usage,
      checkpoints: this.checkpoints,
      images: this.images,
      leases: this.leases,
      eligibleNative: () => this.nativeLeaseEnabled(),
      locallyBusy: async () => this.admissions.active || this.turnExecution.isPumping ||
        this.recoveryActions.active || this.onboardingOperations > 0 ||
        this.scheduler.hasActiveOtherThan("container:idle") || await this.runtimeUpgrades.hasPending(),
      withAdmissionLock: (task) => this.admissions.withLock(task),
      stopStream: () => this.turnExecution.stopStream(),
      prove: (client, sessionID) => this.runtimeUpgrades.proveSession(client, sessionID),
      jobs: {
        schedule: (at, payload) => this.scheduler.schedule("container:idle", at, { ...payload, reason: "unused-runtime" }),
        cancel: () => this.scheduler.cancel("container:idle"),
      },
    })

    this.reconciliation = new ConversationReconciliation({
      storage: ctx.storage,
      store: this.store,
      usage: this.usage,
      recoveryActions: this.recoveryActions,
      runtime: this.runtime,
      conversationID: ctx.id.toString(),
      settings: () => ({
        fetch: (input, init) => this.env.SETTINGS.getByName("global").fetch(input, init),
      }),
      withAdmissionLock: (task) => this.admissions.withLock(task),
      live: () => ({ admitting: this.admissions.active, pumping: this.turnExecution.isPumping }),
      withClient: (fn, recoverOnRejection) => this.withClient(fn, recoverOnRejection),
      ensureReady: () => this.ensureReady(),
    })
    this.accountingCutover = new ConversationAccountingCutover({
      storage: ctx.storage,
      store: this.store,
      usage: this.usage,
      runtime: this.runtime,
      conversationID: ctx.id.toString(),
      dynamicSettings: {
        fetch: (input, init) => this.env.SETTINGS.getByName("global").fetch(input, init),
      },
      withAdmissionLock: (task) => this.admissions.withLock(task),
      withClient: (fn, recoverOnRejection) => this.withClient(fn, recoverOnRejection),
      ensureReady: () => this.ensureReady(),
    })
  }

  private nativeLeaseEnabled(): boolean {
    return Boolean(this.ctx.container && !this.transport && !this.env.CONTAINER_URL && (this.key ?? this.ctx.id.name) !== ONBOARDING_KEY)
  }

  /** Old native containers may predate the durable lease intent and renewal job. */
  private async scheduleLeaseAdoptionIfNeeded(): Promise<void> {
    if (!this.nativeLeaseEnabled() || !this.ctx.container?.running || await this.leases.status()) return
    if (!this.scheduler.has("lease:renew")) {
      await this.scheduler.schedule("lease:renew", Date.now(), { reason: "adopt-running-lease" })
    }
  }

  async fetch(request: Request): Promise<Response> {
    const identityError = this.acceptForwardedIdentity(request)
    if (identityError) return identityError
    await this.scheduler.captureLegacyAlarmMigration(false)
    return this.lifecycle.fetch(request)
  }

  async onRequest(request: Request): Promise<Response> {
    const identityError = this.acceptForwardedIdentity(request)
    if (identityError) return identityError
    try {
      return await this.routeRequest(request)
    } catch (error) {
      if (error instanceof IdleClosePendingError) {
        return Response.json({ error: "container close is pending; retry after stop recovery", retryable: true }, { status: 503 })
      }
      throw error
    }
  }

  private async routeRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/message") return this.onMessage((await request.json()) as MessageRequest)
    if (url.pathname === "/slack") return this.onSlackEvent((await request.json()) as SlackEventRequest)
    if (url.pathname === "/permission") return this.controlPlane.onPermission((await request.json()) as PermissionRequest)
    if (url.pathname === "/form" && request.method === "POST") return this.controlPlane.onSlackForm((await request.json()) as SlackFormRequest)
    if (url.pathname === "/events") return this.onEvents(request)
    if (url.pathname === "/context") return this.onContext()
    if (url.pathname === "/accounting/cutover" && request.method === "GET") return this.accountingCutover.preview()
    if (url.pathname === "/accounting/cutover" && request.method === "POST") {
      let parsed: unknown
      try {
        parsed = await request.json()
      } catch {
        return Response.json({ error: "valid JSON is required" }, { status: 400 })
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        typeof (parsed as Record<string, unknown>).expectedPlanID !== "string" ||
        !/^[a-f0-9]{64}$/.test((parsed as Record<string, string>).expectedPlanID)) {
        return Response.json({ error: "expectedPlanID must be a SHA-256 plan id" }, { status: 400 })
      }
      return this.accountingCutover.apply((parsed as { expectedPlanID: string }).expectedPlanID)
    }
    if (url.pathname === "/accounting/reconciliation" && request.method === "GET") {
      const kind = url.searchParams.get("kind")
      if (kind !== "observed_actual" && kind !== "acknowledged_unknown") {
        return Response.json({ error: "kind must be observed_actual or acknowledged_unknown" }, { status: 400 })
      }
      return this.reconciliation.preview(kind)
    }
    if (url.pathname === "/accounting/reconciliation" && request.method === "POST") {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return Response.json({ error: "valid JSON is required" }, { status: 400 })
      }
      const parsed = parseOperatorReconciliationProposal(body)
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 })
      return this.reconciliation.apply(parsed.value)
    }
    if (url.pathname === "/runtime/upgrade" && request.method === "GET") return this.runtimeUpgrades.preview()
    if (url.pathname === "/runtime/upgrade" && request.method === "POST") {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return Response.json({ error: "valid JSON is required" }, { status: 400 })
      }
      if (!isRecord(body) || Object.keys(body).length !== 1 ||
        typeof body.expectedPlanID !== "string" || !/^[a-f0-9]{64}$/.test(body.expectedPlanID)) {
        return Response.json({ error: "expectedPlanID must be a SHA-256 plan id" }, { status: 400 })
      }
      return this.runtimeUpgrades.apply(body.expectedPlanID)
    }
    if (url.pathname === "/recovery" && request.method === "GET") return this.recoveryActions.inspect()
    if (url.pathname === "/recovery" && request.method === "POST") {
      let parsed: unknown
      try {
        parsed = await request.json()
      } catch {
        return Response.json({ error: "valid JSON is required" }, { status: 400 })
      }
      if (!isRecord(parsed) || Object.keys(parsed).some((key) => key !== "action" && key !== "expectedSnapshotID") ||
        (parsed.action !== "retry" && parsed.action !== "cancel_before_dispatch") ||
        typeof parsed.expectedSnapshotID !== "string" || !/^[a-f0-9]{64}$/.test(parsed.expectedSnapshotID)) {
        return Response.json({ error: "action and SHA-256 expectedSnapshotID are required" }, { status: 400 })
      }
      return this.recoveryActions.act(parsed.action, parsed.expectedSnapshotID)
    }
    if (url.pathname === "/state") return Response.json(await this.store.get())
    if (url.pathname === "/health") return Response.json({ ok: true })
    if (url.pathname === "/provider-credentials") return this.onProviderCredentials(request)
    if (url.pathname === "/provider-status") {
      if (this.key !== ONBOARDING_KEY || request.method !== "GET") return Response.json({ error: "forbidden" }, { status: 403 })
      try {
        const providers = await this.withClient((client) => client.integration.list(), false)
        return Response.json({ connected: hasConnectedProvider(providers.data) })
      } catch {
        return Response.json({ error: "provider status unavailable", retryable: true }, { status: 503 })
      }
    }
    if (url.pathname.startsWith("/onboarding")) return this.onOnboarding(url.pathname, request)
    if (url.pathname === "/reset" && request.method === "POST") return this.onReset()
    if (url.pathname === "/recycle" && request.method === "POST") return this.onRecycle()
    if (url.pathname === "/debug" && request.method === "GET") {
      return Response.json({
        streamState: this.turnExecution.currentStreamState,
        streaming: this.turnExecution.isStreaming,
        ready: this.runtime.ready,
        containerRunning: this.transport || this.env.CONTAINER_URL || !this.ctx.container
          ? undefined
          : this.ctx.container.running,
        runtimeGeneration: this.runtime.generation,
        startMode: this.runtime.startMode,
        snapshot: Boolean(await this.images.snapshotHandle()),
        events: Object.fromEntries(this.turnExecution.observedEvents),
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
    if (url.pathname === "/debug/providers" && request.method === "GET") {
      return this.onDebugProviders()
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

  private acceptForwardedIdentity(request: Request): Response | undefined {
    const forwardedKey = request.headers.get("x-conversation-key") ?? undefined
    const canonicalKey = this.ctx.id.name
    if ((canonicalKey && forwardedKey && forwardedKey !== canonicalKey) ||
      (this.key && forwardedKey && forwardedKey !== this.key)) {
      return Response.json({ error: "conversation identity mismatch" }, { status: 400 })
    }
    if (!this.key && forwardedKey) this.key = forwardedKey
    return undefined
  }

  // --------------------------------------------------------------- HTTP adapter

  private async onMessage(input: MessageRequest): Promise<Response> {
    // Body shape is not guaranteed by the route; reject anything non-string
    // before calling string methods on it.
    const text = typeof input.text === "string" ? input.text.trim() : ""
    if (!text) return Response.json({ ok: false, error: "empty message" }, { status: 400 })
    if (await this.runtimeUpgrades.hasPending()) return Response.json({ ok: false, error: "runtime upgrade is pending; no message was queued" }, { status: 409 })

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

    if (!(await this.admissions.claim())) {
      const queued = await this.admissions.enqueue(prompt, undefined)
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
    } catch (err) {
      this.admissions.finishLocal()
      void this.count("admission.failed")
      logEvent("admission.failed", { transport: "http" })
      const queued = await this.admissions.enqueue(prompt, undefined)
      if (!queued) {
        await this.store.advance("idle")
        await releaseClaim()
        return Response.json({ ok: false, error: "busy" }, { status: 503 })
      }
      return Response.json({ ok: true, queued: true, error: errorMessage(err) }, { status: 202 })
    }

    const reservation = await this.acquireBudgetReservation()
    if (reservation.kind === "denied") {
      this.admissions.finishLocal()
      await this.store.advance("idle")
      await releaseClaim()
      return Response.json(
        {
          ok: false,
          error: reservation.message,
          spentUSD: reservation.spentUSD,
          reservedUSD: reservation.reservedUSD,
          budgetUSD: reservation.budgetUSD,
        },
        { status: 429 },
      )
    }
    if (reservation.kind === "conflict" || reservation.kind === "unavailable") {
      this.admissions.finishLocal()
      await this.store.advance("idle")
      await releaseClaim()
      return Response.json(
        { ok: false, error: reservation.message, reservation: reservation.kind },
        { status: 503 },
      )
    }
    if (reservation.kind === "already-dispatched") {
      await this.admissions.resumeDispatched()
      return Response.json(
        { ok: false, error: reservation.message, reservation: reservation.kind },
        { status: 503 },
      )
    }
    if (!(await this.markBudgetReservationDispatched(reservation.reservation, baseline))) {
      this.admissions.finishLocal()
      await this.store.advance("idle")
      await releaseClaim()
      return Response.json(
        { ok: false, error: "could not persist budget dispatch state", reservation: "unavailable" },
        { status: 503 },
      )
    }
    try {
      // Once the durable dispatched marker is written, any transport error is
      // ambiguous: keep the hold and never turn it into queueable work.
      await this.withClient((client) => client.session.prompt({ sessionID, text: prompt }))
    } catch (err) {
      await this.admissions.recordAccepted(baseline, "ambiguous")
      if (idempotencyKey) await this.store.markTombstone(`msg:${idempotencyKey}`).catch(() => {})
      await this.deliver({
        type: "error",
        message: `prompt dispatch outcome is unknown; reservation retained: ${errorMessage(err)}`,
      }).catch(() => {})
      return Response.json(
        { ok: false, error: "prompt dispatch outcome is unknown; reservation retained" },
        { status: 502 },
      )
    }
    // The prompt is accepted; a bookkeeping or stream failure must not
    // re-enqueue it, or the model would be charged twice for one message.
    await this.admissions.recordAccepted(baseline, "acknowledged")
    if (idempotencyKey) {
      await this.store.markTombstone(`msg:${idempotencyKey}`).catch(() => {})
    }
    const settings = await this.settings().catch(() => undefined)
    if (settings?.streaming) this.ctx.waitUntil(this.turnExecution.startStream(sessionID))
    return Response.json({ ok: true, sessionID })
  }

  private async settings(): Promise<HarnessSettings> {
    const res = await this.env.SETTINGS.getByName("global").fetch("https://settings/get")
    return (await res.json()) as HarnessSettings
  }

  /** Internal-only source for a new legacy conversation's provider credentials. */
  private async onProviderCredentials(request: Request): Promise<Response> {
    if (this.key !== ONBOARDING_KEY) return Response.json({ error: "forbidden" }, { status: 403 })
    if (request.method !== "GET") return Response.json({ error: "method not allowed" }, { status: 405 })
    try {
      const credentials = await this.withClient((client) => client.credential.list(), false)
      return Response.json(credentials.filter((credential) => credential.active && credential.value.type === "key"))
    } catch {
      return Response.json({ error: "provider credentials unavailable" }, { status: 503 })
    }
  }

  /** Read-only, secret-free provider diagnostics for the current session location. */
  private async onDebugProviders(): Promise<Response> {
    const state = await this.store.get()
    if (!state.sessionID) {
      return Response.json({ session: null, integrations: [], providers: [], models: [] })
    }
    // Diagnostics must never cold-start, configure, sync credentials, or recycle a container.
    if (!this.runtime.ready || !this.runtime.apiPort || !this.runtime.generation || (this.ctx.container && !this.ctx.container.running)) {
      return Response.json({ error: "provider diagnostics unavailable" }, { status: 503 })
    }
    try {
      const client = makeClient(portFetch(this.runtime.apiPort))
      const session = await client.session.get({ sessionID: state.sessionID })
      const location = { directory: session.location.directory }
      const [integrations, providers, models] = await Promise.all([
        client.integration.list({ location }),
        client.provider.list({ location }),
        client.model.list({ location }),
      ])
      const result = {
        session: {
          id: session.id,
          location,
          ...(session.model
            ? {
                model: {
                  providerID: session.model.providerID,
                  id: session.model.id,
                  ...(session.model.variant === undefined ? {} : { variant: session.model.variant }),
                },
              }
            : {}),
        },
        integrations: integrations.data.map((integration) => ({
          id: integration.id,
          connections: integration.connections.map((connection, index) => ({
            type: connection.type,
            ...(connection.type === "credential" ? { id: connection.id, method: connection.method } : {}),
            ...(index === 0 ? { selected: true } : {}),
          })),
        })),
        providers: providers.data.map((provider) => ({
          id: provider.id,
          activation: provider.activation,
          ...(provider.integrationID ? { integrationID: provider.integrationID } : {}),
        })),
        models: models.data.map((model) => ({
          providerID: model.providerID,
          id: model.id,
          enabled: model.enabled,
          type: model.type ?? "chat",
        })),
      }
      return Response.json(result)
    } catch {
      return Response.json({ error: "provider diagnostics unavailable" }, { status: 503 })
    }
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
    const blocksSettingsRestart = this.key === ONBOARDING_KEY
    if (blocksSettingsRestart) this.onboardingOperations++
    try {
      const path = pathname.slice("/onboarding".length) || "/"
      try {
        // Return provider/model catalogues through the same authenticated SDK
        // path used elsewhere in the harness. Forwarding the control server's
        // special integration response can cross two Workers with stale
        // compression metadata and lose its body at the service-binding edge.
        if (request.method === "GET" && path === "/integrations") {
          const integrations = await this.withClient((client) => client.integration.list(), false)
          return Response.json(integrations)
        }
        if (request.method === "GET" && path === "/models") {
          const models = await this.withClient(
            (client) => client.model.list({ location: { directory: "/workspace" } }),
            false,
          )
          return Response.json(models)
        }
        const body =
          request.method === "GET" || request.method === "HEAD" ? undefined : await request.text()
        return await this.runtimeAccess.useReady(async () => {
          const control = await this.runtime.port(CONTROL_PORT)
          const res = await control.fetch(`http://container${path}`, {
            method: request.method,
            ...(body === undefined ? {} : { body }),
            signal: AbortSignal.timeout(120_000),
          })
          // Consume the complete control response while this runtime generation
          // is borrowed. Returning a live body stream would outlive the gate.
          const bytes = await res.arrayBuffer()
          // The state snapshot pauses OpenCode; the next call must start it again.
          if (path === "/state-checkpoint" && res.ok) this.runtime.pauseServer()
          const headers = new Headers(res.headers)
          headers.delete("content-encoding")
          headers.delete("content-length")
          return new Response(bytes.byteLength ? bytes : null, { status: res.status, headers })
        })
      } catch (error) {
        // A cold start can outlast the port wait. Report it so the wizard can
        // retry instead of surfacing an opaque Worker exception.
        return Response.json(
          { error: errorMessage(error), retryable: true },
          { status: 503 },
        )
      }
    } finally {
      if (blocksSettingsRestart) this.onboardingOperations--
    }
  }

  /** Hard reset: drop the container and this conversation's stored state. */
  private async onReset(): Promise<Response> {
    return this.admissions.withLock(async () => {
      if (await this.runtimeUpgrades.hasPending()) return Response.json({ error: "runtime upgrade is pending; resume it before reset" }, { status: 409 })
      const blocked = await this.blockLifecycleDuringActiveTurn()
      if (blocked) return blocked
      if (!await this.turnExecution.stopStream()) {
        return Response.json({ ok: false, error: "runtime stream did not drain; state was kept" }, { status: 503 })
      }
      return this.withUsageLifecycle(async () => {
        if (!(await this.runtime.stop())) {
          return Response.json({ ok: false, error: "container stop was not confirmed; state was kept" }, { status: 503 })
        }
        if (!(await this.leases.releaseAfterStop())) {
          return Response.json({ ok: false, error: "container lease release is pending; state was kept" }, { status: 503 })
        }
        // A reset must not leave a checkpoint that the next cold start would
        // restore over the freshly cleared conversation.
        await this.checkpoints.deleteAll()
        await this.scheduler.reset()
        this.controlPlane.clearCache()
        this.readiness.resetProviderSync()
        return Response.json({ ok: true })
      })
    })
  }

  /**
   * Recycle the container so the next call starts the current image. State is
   * kept: this is what a long-lived conversation needs after an image deploy.
   */
  private async onRecycle(): Promise<Response> {
    return this.admissions.withLock(async () => {
      if (await this.runtimeUpgrades.hasPending()) return Response.json({ error: "runtime upgrade is pending; resume it before recycling" }, { status: 409 })
      const blocked = await this.blockLifecycleDuringActiveTurn()
      if (blocked) return blocked
      if (!await this.turnExecution.stopStream()) {
        return Response.json({ ok: false, error: "runtime stream did not drain; not recycling" }, { status: 503 })
      }
      return this.withUsageLifecycle(async () => {
        // R2 checkpoints are portable across image versions. Capture the
        // current runtime under exclusive ownership before stopping it.
        const saved = await this.checkpoints.captureOwned()
        if (!saved) return Response.json({ ok: false, error: "checkpoint failed; not recycling" }, { status: 503 })
        if (!(await this.runtime.stop())) {
          return Response.json({ ok: false, error: "container stop was not confirmed; not recycling" }, { status: 503 })
        }
        if (!(await this.leases.releaseAfterStop())) {
          return Response.json({ ok: false, error: "container lease release is pending; not recycling" }, { status: 503 })
        }
        await this.images.clearSnapshot()
        return Response.json({ ok: true })
      })
    })
  }

  /** Remove the workspace archives and this conversation's stored state. */
  private async onDelete(): Promise<Response> {
    return this.admissions.withLock(async () => {
      if (await this.runtimeUpgrades.hasPending()) return Response.json({ error: "runtime upgrade is pending; resume it before deleting this conversation" }, { status: 409 })
      const blocked = await this.blockLifecycleDuringActiveTurn()
      if (blocked) return blocked
      if (!await this.turnExecution.stopStream()) {
        return Response.json({ ok: false, error: "runtime stream did not drain; state was kept" }, { status: 503 })
      }
      return this.withUsageLifecycle(async () => {
        if (!(await this.runtime.stop())) {
          return Response.json({ ok: false, error: "container stop was not confirmed; state was kept" }, { status: 503 })
        }
        if (!(await this.leases.releaseAfterStop())) {
          return Response.json({ ok: false, error: "container lease release is pending; state was kept" }, { status: 503 })
        }
        await this.checkpoints.deleteAll()
        await this.scheduler.reset()
        this.controlPlane.clearCache()
        this.readiness.resetProviderSync()
        logEvent("conversation.deleted")
        return Response.json({ ok: true })
      })
    })
  }

  /** Do not destroy state or archives while a turn or owned hold is unresolved. */
  private async blockLifecycleDuringActiveTurn(): Promise<Response | undefined> {
    if (await this.ctx.storage.get<boolean>("lifecycleJobsSealed")) {
      return Response.json({ ok: false, error: "lifecycle jobs are sealed; inspect recovery and retry before cleanup" }, { status: 409 })
    }
    const state = await this.store.get()
    const phase = state.phase ?? "idle"
    const active = phase === "admitting" || phase === "running" || phase === "settling" || phase === "queued"
    if (state.budgetReservation || active || this.recoveryActions.active || this.scheduler.activeCount > 0 || state.checkpointPending) {
      return Response.json(
        { ok: false, error: "conversation has unresolved work; wait for it to settle before reset or delete" },
        { status: 409 },
      )
    }
    return undefined
  }

  /** Keep the usage queue locked through cleanup so a late replay cannot resurrect state. */
  private withUsageLifecycle(cleanup: () => Promise<Response>): Promise<Response> {
    return this.usage.serialize(async () => {
      try {
        const state = await this.store.get()
        if (state.sessionID) {
          await this.usage.replayLogLocked(state.sessionID)
          const refreshed = await this.store.get()
          const execution = refreshed.usageExecution
          if (execution?.sessionID === state.sessionID &&
            (execution.startedSeq > execution.terminalSeq || execution.latestStepSeq > execution.terminalSeq)) {
            throw new Error("provider execution is not terminal; lifecycle cleanup is unsafe")
          }
        }
      } catch (error) {
        const message = errorMessage(error)
        await this.store.patch({ usageError: message }).catch(() => {})
        return Response.json({ ok: false, error: `usage replay failed: ${message}`, retryable: true }, { status: 503 })
      }
      return this.runtimeAccess.exclusive(cleanup)
    })
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

  /** Protected seams retained for qualification and subclass tests. */
  protected startOptions(): ContainerStartupOptions {
    return this.images.startOptions()
  }

  protected snapshotHandle(): Promise<ContainerSnapshot | undefined> {
    return this.images.snapshotHandle()
  }

  protected clearSnapshot(): Promise<boolean> {
    return this.images.clearSnapshot()
  }

  protected captureSnapshot(): Promise<void> {
    return this.images.captureSnapshot()
  }

  /** Start the container, preferring a snapshot when one is available. */
  private async startContainer(): Promise<boolean> {
    const container = this.ctx.container
    if (!container) throw new Error("no container bound")
    const imageBinding = await this.ctx.storage.get<unknown>("containerImageVariant")
    if (imageBinding !== undefined && imageBinding !== "evented") {
      throw new Error("unknown container image binding; refusing to fall back")
    }
    if (imageBinding === "evented") this.runtime.bindImage("evented")
    // Resolve and durably bind the selected image before token creation or
    // lease acquisition. A canary capacity retry then reuses this binding.
    await this.images.prepareContainerImageVariant(container)
    // The token and lease must exist before the process starts.
    await this.controlPlane.token()
    await this.leases.ensureHeld()
    try {
      return await this.startBoundContainer(container)
    } catch (error) {
      if (await this.runtime.stop()) await this.leases.releaseAfterStop()
      throw error
    }
  }

  /** Start a bound container from the snapshot when possible, else the image. */
  private async startBoundContainer(container: NonNullable<typeof this.ctx.container>): Promise<boolean> {
    return this.runtime.startBoundContainer(container)
  }

  // -------------------------------------------------------------- Slack adapter

  private async handleSlackControl(text: string, input: SlackEventRequest, target: SlackTarget): Promise<void> {
    await handleSlackCommand(text, {
      getState: () => this.store.get(),
      getDefaultModel: async () => (await this.settings()).model,
      getModels: async () => (await this.withClient((client) => client.model.list({ location: { directory: "/workspace" } }), false)).data,
      getSession: (sessionID) => this.withClient((client) => client.session.get({ sessionID }), false),
      listSessions: async () => (await this.withClient((client) => client.session.list({ limit: 100, order: "desc" }), false)).data,
      switchModel: (ref) => this.changeSlackModel(ref),
      selectSession: (sessionID) => this.changeSlackSession(sessionID, target),
      newSession: () => this.changeSlackSession(undefined, target),
      stop: () => this.stopSlackWork(),
      leave: async () => {
        if (input.event.channel_type === "im") return "This is a DM; use `!new` for a fresh session or `!stop` to interrupt work."
        await this.store.patch({ slackEngaged: false })
        return "Stopped following this thread. Mention me to re-engage; use `!stop` to interrupt current work."
      },
      listForms: (sessionID) => this.controlPlane.pendingForms(sessionID),
      answerForm: (sessionID, formID, answer) => this.controlPlane.replyToForm(sessionID, formID, answer),
      cancelForm: (sessionID, formID) => this.controlPlane.replyToForm(sessionID, formID),
      usageText: async () => {
        const response = await this.env.SETTINGS.getByName("global").fetch("https://settings/usage/today")
        if (!response.ok) throw new Error("Usage is temporarily unavailable")
        const usage = await response.json() as {
          date: string; costUSD: number; reservedUSD: number; input: number; output: number
          historicalUsageUnreconciled?: boolean; unknownReconciliationCount?: number
        }
        const settings = await this.settings()
        const historyNote = usage.historicalUsageUnreconciled
          ? `\n⚠ Historical usage remains unreconciled${usage.unknownReconciliationCount ? ` (${usage.unknownReconciliationCount} unknown amount${usage.unknownReconciliationCount === 1 ? "" : "s"} acknowledged)` : ""}.`
          : ""
        return `*Workspace usage — ${usage.date} (UTC)*\nReported spend: $${usage.costUSD.toFixed(4)}\nReserved: $${usage.reservedUSD.toFixed(4)}\nTokens: ${usage.input} in / ${usage.output} out\nDaily budget: ${settings.dailyBudgetUSD > 0 ? `$${settings.dailyBudgetUSD.toFixed(2)}` : "unlimited"}\nProvider quota and billing may differ from reported usage.${historyNote}`
      },
      reply: (message) => this.postChunked(target.channel, message, target.replyTs),
      setupUrl: input.appUrl ? `${new URL(input.appUrl).origin}/onboarding/` : "the web app's /onboarding/ page",
    })
  }

  private async checkSlackImageModel(sessionID: string): Promise<ImageModelCheck> {
    const models = (await this.withClient(
      (client) => client.model.list({ location: { directory: "/workspace" } }),
      false,
    )).data

    let selected: { providerID: string; id: string } | undefined
    try {
      const session = await this.withClient((client) => client.session.get({ sessionID }), false)
      const model = (session as { model?: { providerID?: unknown; id?: unknown } }).model
      if (typeof model?.providerID === "string" && typeof model.id === "string") {
        selected = { providerID: model.providerID, id: model.id }
      }
    } catch {
      // Missing session metadata is unknown; do not guess from a stale override.
    }
    return checkSlackImageModel(selected, models)
  }

  private slackImageCompatibilityMessage(check: ImageModelCheck, catalogueUnavailable = false): string {
    if (catalogueUnavailable) {
      return "⚠️ I couldn't check image support right now, so nothing was sent or reserved. Please resend the image when the bot is ready."
    }
    if (check.status === "compatible") return ""
    if (check.status === "unknown") {
      const candidates = formatSlackImageModelSuggestions(check.suggestions)
      return candidates
        ? `⚠️ I couldn't confirm that the selected model can read images, so nothing was sent or reserved. Compatible connected models: ${mrkdwnEscape(candidates)}. Choose one with !model provider/model, then resend the image.`
        : "⚠️ I couldn't confirm that the selected model can read images, so nothing was sent or reserved. Use `!model` to check available models or `!setup` to connect a provider, then resend the image."
    }
    const candidates = formatSlackImageModelSuggestions(check.suggestions)
    return candidates
      ? `⚠️ The selected model can't read images, so nothing was sent or reserved. Compatible connected models: ${mrkdwnEscape(candidates)}. Switch with !model provider/model, then resend the image.`
      : "⚠️ No connected model reports image input support, so nothing was sent or reserved. Use `!setup` to connect a compatible provider, then resend the image."
  }

  /** Model/session changes share the admission lock, so a prompt cannot race them. */
  private async requireSlackIdle(): Promise<ConversationState> {
    const state = await this.store.get()
    if (await this.runtimeUpgrades.hasPending()) throw new Error("A runtime upgrade is pending. Resume it before changing the model or session.")
    if (this.admissions.active || this.turnExecution.isPumping || this.recoveryActions.active || isBusyPhase(state.phase) || state.queued || state.budgetReservation) {
      throw new Error("This conversation has unfinished work. Use `!stop`, then wait for settlement; `!status` shows any retained usage hold.")
    }
    return state
  }

  private async changeSlackModel(ref: string): Promise<void> {
    await this.admissions.withLock(async () => {
      const state = await this.requireSlackIdle()
      const model = parseModelRef(ref)
      if (!model) throw new Error("Use a provider/model reference from `!model`.")
      if (state.sessionID) await this.withClient((client) => client.session.switchModel({ sessionID: state.sessionID!, model }), false)
      await this.store.patch({ modelOverride: ref })
    })
  }

  /** Change only the session mapping; archives, sources and historical sessions survive. */
  private async changeSlackSession(sessionID: string | undefined, target: SlackTarget): Promise<void> {
    await this.admissions.withLock(async () => {
      const current = await this.requireSlackIdle()
      let selectedModel = current.modelOverride
      if (sessionID) {
        const detail = await this.withClient((client) => client.session.get({ sessionID }), false)
        if (detail.id !== sessionID || detail.parentID || detail.location?.directory !== "/workspace") {
          throw new Error("That session does not belong to this conversation's workspace.")
        }
        selectedModel = detail.model ? `${detail.model.providerID}/${detail.model.id}${detail.model.variant ? `#${detail.model.variant}` : ""}` : undefined
      }
      const response = await this.withUsageLifecycle(async () => {
        await this.store.patch({
          sessionID, modelOverride: selectedModel, transport: "slack", slack: target,
          turnBaseline: undefined, runStartedAt: undefined, pending: {}, announcedForms: [],
          lastReply: undefined, lastSlackReply: undefined, reportedError: undefined, lastTurnError: undefined,
          usage: undefined, usageAux: undefined, usageCursor: undefined, usageTerminal: undefined,
          usageExecution: undefined, usageError: undefined, settlementError: undefined,
        })
        return Response.json({ ok: true })
      })
      if (!response.ok) {
        const body = await response.json() as { error?: string }
        throw new Error(body.error ?? "Cannot change sessions while usage is unresolved.")
      }
    })
  }

  private async stopSlackWork(): Promise<string> {
    return this.admissions.withLock(async () => {
      const state = await this.store.get()
      if (this.admissions.active || state.phase === "admitting") return "A message is being admitted. Retry `!stop` once startup finishes."
      if (state.queued && !state.budgetReservation && state.phase === "queued") {
        await this.store.patch({ queued: undefined, phase: "idle" })
        return "Stopped the queued message before dispatch."
      }
      if (!state.sessionID) return "No session mapped here yet."
      if (!isBusyPhase(state.phase) && !state.budgetReservation) return "This session is already idle."
      await this.withClient((client) => client.session.interrupt({ sessionID: state.sessionID!, resume: false }), false)
      // Interrupting proves neither zero spend nor successful settlement. The
      // normal log/context reconciliation retains and eventually releases holds.
      await this.store.patch({ queued: undefined })
      await this.scheduler.schedule("turn:observe", Date.now() + 1000, {
        reservationID: state.budgetReservation?.reservationID,
        reservationDate: state.budgetReservation?.date,
        sessionID: state.sessionID,
        reason: "slack-stop-settlement",
      })
      return "Stop requested; queued follow-ups cleared. Usage settlement will finish before the next turn."
    })
  }

  private async onSlackEvent(input: SlackEventRequest): Promise<Response> {
    const event = input.event
    if (!event.channel || !event.ts) return Response.json({ ok: true })
    const files = event.files ?? []
    const hasImage = files.length > 0
    const isFileShare = event.subtype === "file_share" && hasImage
    if (event.bot_id || (event.subtype && !isFileShare)) return Response.json({ ok: true })
    if (!event.text && !hasImage) return Response.json({ ok: true })
    const strippedText = this.stripMention(event.text ?? "")
    const text = strippedText || (hasImage ? "Describe the attached image." : "")
    if (!text) return Response.json({ ok: true })
    if (await this.runtimeUpgrades.hasPending()) {
      const target = { channel: event.channel, ...(input.replyTs ? { replyTs: input.replyTs } : {}) }
      await this.postChunked(target.channel, "Runtime upgrade is pending. No message was queued; an operator must resume the upgrade first.", target.replyTs).catch(() => {})
      return Response.json({ error: "runtime upgrade pending" }, { status: 409 })
    }
    const isDm = event.channel_type === "im"
    const state = await this.store.get()
    // Channel message subscriptions exist only to carry replies in engaged
    // threads. A regular channel message must never become a model turn.
    if (!isDm && event.type !== "app_mention" &&
      (!event.thread_ts || !state.slackEngaged)) return Response.json({ ok: true })
    if (input.eventID && !(await this.store.claimEvent(input.eventID))) return Response.json({ ok: true })
    if (!isDm && event.type === "app_mention") await this.store.patch({ slackEngaged: true })
    const target: SlackTarget = { channel: event.channel, ...(input.replyTs ? { replyTs: input.replyTs } : {}) }

    // Management commands must bypass prompt admission, provider quota and
    // budgets, including unknown commands and failures in their handlers.
    if (parseSlackCommand(text)) {
      // A reply can fail after a command has already changed the model/session.
      // Preserve at-most-once execution even if delivery or the DO then fails.
      // A user can issue a new command, but a Slack retry cannot repeat an old
      // mutation against a newer session or a differently ordered session list.
      if (input.eventID) await this.store.markTombstone(input.eventID)
      await this.handleSlackControl(text, input, target)
      return Response.json({ ok: true, command: true })
    }

    let prompt = text
    let sessionID = ""
    let baseline: string | undefined
    let imageAttachment: SlackImageAttachment | undefined
    let accepted = false
    try {
      prompt = await this.buildPrompt(event.channel, event.ts, event.thread_ts, text)
    } catch (err) {
      logEvent("admission.failed", { transport: "slack", stage: "context" })
      if (hasImage) {
        await this.postChunked(
          target.channel,
          "⚠️ I couldn't prepare that image message. Nothing was sent or reserved; please resend the image.",
          target.replyTs,
        ).catch(() => {})
        if (input.eventID) await this.store.releaseEvent(input.eventID).catch(() => {})
        return Response.json({ ok: true })
      }
      const queued = await this.admissions.enqueue(prompt, target)
      accepted = queued
      if (!queued) {
        await this.postChunked(
          target.channel,
          `⚠️ Container busy and a message is already queued: ${errorMessage(err)}`,
          target.replyTs,
        ).catch(() => {})
      }
      if (!accepted && input.eventID) await this.store.releaseEvent(input.eventID).catch(() => {})
      return Response.json({ ok: true, queued })
    }

    if (!(await this.admissions.claim())) {
      if (hasImage) {
        await this.postChunked(
          target.channel,
          "⏳ I'm busy with another turn, so I didn't send or queue this image. Please resend it when I'm ready.",
          target.replyTs,
        ).catch(() => {})
        if (input.eventID) await this.store.releaseEvent(input.eventID).catch(() => {})
        return Response.json({ ok: true, queued: false })
      }
      const queued = await this.admissions.enqueue(prompt, target)
      accepted = queued
      if (!queued) {
        await this.postChunked(
          target.channel,
          "⚠️ Container busy and a message is already queued.",
          target.replyTs,
        ).catch(() => {})
      }
      if (!accepted && input.eventID) await this.store.releaseEvent(input.eventID).catch(() => {})
      return Response.json({ ok: true, queued })
    }

    if (hasImage) {
      try {
        // Establish or switch the session first. ensureSession reapplies the
        // current override/default after a restore, so preflight must inspect
        // the model this prompt will actually use.
        sessionID = await this.ensureSession(text, "slack", target)
      } catch {
        this.admissions.finishLocal()
        await this.store.advance("idle")
        await this.postChunked(
          target.channel,
          "⚠️ I couldn't start the session, so I didn't send or queue this image. No usage hold was created; please resend it later.",
          target.replyTs,
        ).catch(() => {})
        if (input.eventID) await this.store.releaseEvent(input.eventID).catch(() => {})
        return Response.json({ ok: true, queued: false })
      }

      let check: ImageModelCheck
      let catalogueUnavailable = false
      try {
        check = await this.checkSlackImageModel(sessionID)
      } catch {
        catalogueUnavailable = true
        check = checkSlackImageModel(undefined, undefined)
      }
      if (check.status !== "compatible") {
        this.admissions.finishLocal()
        await this.store.advance("idle")
        await this.postChunked(target.channel, this.slackImageCompatibilityMessage(check, catalogueUnavailable), target.replyTs).catch(() => {})
        if (input.eventID) await this.store.releaseEvent(input.eventID).catch(() => {})
        return Response.json({ ok: true, image: "model-incompatible" })
      }
      try {
        imageAttachment = await downloadSlackImage(files, this.env.SLACK_BOT_TOKEN ?? "")
      } catch (error) {
        this.admissions.finishLocal()
        await this.store.advance("idle")
        const message = error instanceof Error ? error.message : "That image could not be validated."
        await this.postChunked(target.channel, `⚠️ ${message} Nothing was sent or reserved; please resend the image.`, target.replyTs).catch(() => {})
        if (input.eventID) await this.store.releaseEvent(input.eventID).catch(() => {})
        return Response.json({ ok: true, image: "invalid" })
      }
    }

    try {
      if (!sessionID) sessionID = await this.ensureSession(text, "slack", target)
      baseline = await this.turnBaseline(sessionID)
    } catch (err) {
      this.admissions.finishLocal()
      logEvent("admission.failed", { transport: "slack", stage: "readiness" })
      if (hasImage) {
        imageAttachment = undefined
        await this.store.advance("idle")
        await this.postChunked(
          target.channel,
          "⚠️ I couldn't start the session, so I didn't send or queue this image. No usage hold was created; please resend it later.",
          target.replyTs,
        ).catch(() => {})
        if (input.eventID) await this.store.releaseEvent(input.eventID).catch(() => {})
        return Response.json({ ok: true, queued: false })
      }
      const queued = await this.admissions.enqueue(prompt, target)
      accepted = queued
      if (!queued) {
        await this.store.advance("idle")
        await this.postChunked(
          target.channel,
          `⚠️ Container busy and a message is already queued: ${errorMessage(err)}`,
          target.replyTs,
        ).catch(() => {})
      }
      if (!accepted && input.eventID) await this.store.releaseEvent(input.eventID).catch(() => {})
      return Response.json({ ok: true, queued })
    }

    const reservation = await this.acquireBudgetReservation()
    if (reservation.kind === "denied") {
      imageAttachment = undefined
      this.admissions.finishLocal()
      await this.store.advance("idle")
      await this.postChunked(
        target.channel,
        `⚠️ ${reservation.message}. Raise the budget in settings or wait for the daily reset.`,
        target.replyTs,
      ).catch(() => {})
      if (input.eventID) await this.store.releaseEvent(input.eventID).catch(() => {})
      return Response.json({ ok: true })
    }
    if (reservation.kind === "conflict" || reservation.kind === "unavailable") {
      imageAttachment = undefined
      this.admissions.finishLocal()
      await this.store.advance("idle")
      await this.postChunked(
        target.channel,
        `⚠️ ${reservation.message}. No prompt was sent; please try again shortly.`,
        target.replyTs,
      ).catch(() => {})
      if (input.eventID) await this.store.releaseEvent(input.eventID).catch(() => {})
      return Response.json({ ok: true })
    }
    if (reservation.kind === "already-dispatched") {
      imageAttachment = undefined
      await this.admissions.resumeDispatched()
      await this.postChunked(
        target.channel,
        "⚠️ A previous prompt has an unresolved dispatch result. This message was not sent; please retry after it settles.",
        target.replyTs,
      ).catch(() => {})
      if (input.eventID) await this.store.releaseEvent(input.eventID).catch(() => {})
      return Response.json({ ok: true })
    }
    if (!(await this.markBudgetReservationDispatched(reservation.reservation, baseline))) {
      imageAttachment = undefined
      this.admissions.finishLocal()
      await this.store.advance("idle")
      await this.postChunked(
        target.channel,
        "⚠️ Could not persist dispatch state. No prompt was sent; please retry shortly.",
        target.replyTs,
      ).catch(() => {})
      if (input.eventID) await this.store.releaseEvent(input.eventID).catch(() => {})
      return Response.json({ ok: true })
    }
    try {
      await this.withClient((client) => client.session.prompt({
        sessionID,
        text: prompt,
        ...(imageAttachment ? { files: [imageAttachment] } : {}),
      }))
    } catch (err) {
      imageAttachment = undefined
      await this.admissions.recordAccepted(baseline, "ambiguous")
      if (input.eventID) await this.store.markTombstone(input.eventID).catch(() => {})
      await this.deliver({
        type: "error",
        message: `prompt dispatch outcome is unknown; reservation retained: ${errorMessage(err)}`,
      }).catch(() => {})
      return Response.json({ ok: true })
    }
    accepted = true
    imageAttachment = undefined

    // The prompt is accepted; bookkeeping and stream failures must not re-send it.
    await this.admissions.recordAccepted(baseline, "acknowledged")
    if (input.eventID) {
      // Mark event as processed so it stays blocked beyond the 200-event window
      await this.store.markTombstone(input.eventID).catch(() => {})
    }
    const settings = await this.settings().catch(() => undefined)
    if (settings?.streaming) this.ctx.waitUntil(this.turnExecution.startStream(sessionID))
    return Response.json({ ok: true, sessionID })
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
    return this.eventStream.open(request)
  }

  /** Emit to SSE and, when the conversation has a Slack target, post there too. */
  private async deliver(event: ConversationEvent, options: { slack?: boolean } = {}): Promise<void> {
    const seq = await this.store.appendEvent(event)
    await this.eventStream.publish(event, seq)
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
    if (await this.runtimeUpgrades.hasPending()) throw new Error("runtime upgrade is pending; an operator must resume it before a session can change")
    await this.ensureReady()
    await this.leases.ensureHeld()
    if (this.runtime.eventPersistence !== true || !this.runtime.generation ||
      this.runtime.eventPersistenceGeneration !== this.runtime.generation) {
      throw new AccountingPolicyError("runtime cannot retain usage events; upgrade pending")
    }
    const state = await this.store.get()
    if (state.sessionID && (await this.sessionUsable(state.sessionID))) {
      // Drain the durable log before admission. The verified foreground policy
      // disables title generation and background compaction, so settled
      // sessions have no permitted auxiliary writer after their terminal fence.
      await this.usage.refresh(state.sessionID)
      // The durable choice is authoritative even if a cold start restored an
      // archive captured before !model. Switching models makes no model call.
      const override = parseModelRef(state.modelOverride ?? (await this.settings()).model)
      if (override) await this.withClient((client) => client.session.switchModel({ sessionID: state.sessionID!, model: override }))
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
    const model = parseModelRef(state.modelOverride ?? settings.model)
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
            announcedForms: [],
            turnBaseline: undefined,
            lastReply: undefined,
            lastSlackReply: undefined,
            reportedError: undefined,
            usage: undefined,
            usageAux: undefined,
            usageCursor: undefined,
            usageTerminal: undefined,
            usageExecution: undefined,
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
    const messages = (await this.withClient((client) =>
      client.session.context({ sessionID }),
    )) as MessageInfo[]
    if (!Array.isArray(messages)) throw new Error("session context is unreadable while establishing turn baseline")
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message?.type === "assistant" && message.id) return message.id
    }
    return undefined
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

  async acquireBudgetReservation(): Promise<BudgetReservationResult> {
    await this.scheduler.captureLegacyAlarmMigration(false)
    await this.lifecycle.start()
    return await this.budgetReservations.acquire()
  }

  /** Persist dispatch ambiguity immediately before making a provider request. */
  async markBudgetReservationDispatched(
    reservation: BudgetReservation,
    turnBaseline: string | undefined,
    fromQueue = false,
  ): Promise<boolean> {
    await this.scheduler.captureLegacyAlarmMigration(false)
    await this.lifecycle.start()
    return await this.budgetReservations.markDispatched(reservation, turnBaseline, fromQueue)
  }

  /** Release a known hold; keep local ownership unless Settings acknowledges it. */
  async releaseBudgetReservation(reservation: BudgetReservation): Promise<boolean> {
    await this.scheduler.captureLegacyAlarmMigration(false)
    await this.lifecycle.start()
    return await this.budgetReservations.release(reservation)
  }

  /** Platform alarms are dispatched only by the Lifecycle-owned SQLite queue. */
  async alarm(): Promise<void> {
    await this.scheduler.captureLegacyAlarmMigration(true)
    await this.lifecycle.alarm()
  }

  private async processTurnObservation(payload: ConversationJobPayload): Promise<{ rescheduleAt: number } | undefined> {
    if (!(await this.scheduler.isCurrent(payload)) || await this.runtimeUpgrades.hasPending()) return undefined
    const before = await this.store.get()
    const reservation = before.budgetReservation
    if (payload.reservationID && (!reservation?.dispatched || reservation.reservationID !== payload.reservationID ||
      reservation.date !== payload.reservationDate)) return undefined
    if (!reservation?.dispatched && !["running", "settling"].includes(before.phase ?? "idle")) return undefined
    if (this.recoveryActions.active || this.admissions.active || this.turnExecution.isPumping) return { rescheduleAt: Date.now() + POLL_MS }

    const phase = before.phase ?? "idle"
    if (reservation?.dispatched && phase !== "running" && phase !== "settling") {
      await this.admissions.resumeDispatched(false)
    }
    const state = await this.store.get()
    const action = staleAction(state, Date.now(), false)
    if (action === "settlement") {
      logEvent("settlement.stale", {
        ...(state.runStartedAt ? { durationMs: Date.now() - state.runStartedAt } : {}),
      })
      if (state.budgetReservation?.dispatched) {
        await this.store.patch({ phase: "running" })
      } else {
        await this.store.advance("idle")
        return undefined
      }
    }
    if (action === "timeout") {
      if (state.budgetReservation?.dispatched) {
        await this.turnExecution.pauseSettlement("turn exceeded its time limit; dispatched reservation retained while context is checked")
      } else {
        void this.count("turn.timedout")
        logEvent("turn.timedout", {
          ...(state.runStartedAt ? { durationMs: Date.now() - state.runStartedAt } : {}),
        })
        await this.turnExecution.finishTimedOutTurn(state, state.lastReply ?? "", { message: "turn timed out" })
        return undefined
      }
    }
    const settled = await this.turnExecution.pumpOnce()
    if (settled) {
      const after = await this.store.get()
      if (!after.budgetReservation?.dispatched) return undefined
    }
    const settings = await this.settings().catch(() => undefined)
    return { rescheduleAt: Date.now() + (this.turnExecution.isStreaming ? 30_000 : (settings?.pollSeconds ?? 2) * 1000) }
  }

  private async processAdmissionRetry(payload: ConversationJobPayload): Promise<{ rescheduleAt: number } | undefined> {
    if (!(await this.scheduler.isCurrent(payload)) || await this.runtimeUpgrades.hasPending()) return undefined
    const state = await this.store.get()
    if (payload.queueID) {
      if (!state.queued || state.queued.id !== payload.queueID) return undefined
      const due = state.queued.nextAttemptAt ?? 0
      if (Date.now() < due) return { rescheduleAt: due }
      if (this.admissions.active || this.turnExecution.isPumping || this.recoveryActions.active) return { rescheduleAt: Date.now() + POLL_MS }
      await this.admissions.drainQueue()
      const after = await this.store.get()
      if (!after.queued || after.queued.id !== payload.queueID) return undefined
      return { rescheduleAt: Math.max(after.queued.nextAttemptAt ?? 0, Date.now() + POLL_MS) }
    }
    return undefined
  }

  private async processCheckpointRetry(payload: ConversationJobPayload): Promise<{ rescheduleAt: number } | undefined> {
    if (!(await this.scheduler.isCurrent(payload)) || await this.runtimeUpgrades.hasPending()) return undefined
    const state = await this.store.get()
    if (!state.checkpointPending) return undefined
    const due = state.checkpointRetryAt ?? Date.now() + CHECKPOINT_RETRY_MS
    if (!state.checkpointRetryAt) await this.store.patch({ checkpointRetryAt: due })
    if (Date.now() < due) return { rescheduleAt: due }
    if ((state.phase ?? "idle") !== "idle" || this.admissions.active || this.turnExecution.isPumping || this.recoveryActions.active) {
      return { rescheduleAt: Date.now() + POLL_MS }
    }
    await this.recoveryActions.runAction(() => this.checkpoints.retry())
    return undefined
  }

  private async processRecoveryWake(payload: ConversationJobPayload): Promise<{ rescheduleAt: number } | undefined> {
    if (!(await this.scheduler.isCurrent(payload)) || await this.runtimeUpgrades.hasPending()) return undefined
    const state = await this.store.get()
    if (payload.reason === "stale-admission-recovery") {
      if ((state.phase ?? "idle") !== "admitting" || state.budgetReservation?.dispatched ||
        (payload.admissionID && state.admissionID !== payload.admissionID)) return undefined
      if (this.recoveryActions.active || this.admissions.active || this.turnExecution.isPumping) return { rescheduleAt: Date.now() + POLL_MS }
      if (staleAction(state, Date.now(), false) !== "admission") return undefined
      const queueID = state.queued?.id ?? (state.queued ? crypto.randomUUID() : undefined)
      const retryAt = state.queued ? Math.max(state.queued.nextAttemptAt ?? 0, Date.now()) : undefined
      await this.ctx.storage.transaction(async () => {
        const current = await this.store.get()
        if ((current.phase ?? "idle") !== "admitting" || current.budgetReservation?.dispatched ||
          (payload.admissionID && current.admissionID !== payload.admissionID)) return
        await this.store.patch({
          admissionID: undefined,
          admissionStartedAt: undefined,
          phase: current.queued ? "queued" : "idle",
          ...(current.queued && queueID ? { queued: { ...current.queued, id: queueID, nextAttemptAt: retryAt } } : {}),
        })
        if (current.queued && queueID && retryAt !== undefined) await this.scheduler.schedule("admission:retry", retryAt, {
          queueID,
          reason: "queued-after-stale-admission",
        })
      })
      logEvent("admission.stale")
      return undefined
    }
    const reservation = state.budgetReservation
    if (!reservation?.dispatched || reservation.reservationID !== payload.reservationID ||
      reservation.date !== payload.reservationDate) return undefined
    if (this.recoveryActions.active || this.admissions.active || this.turnExecution.isPumping) return { rescheduleAt: Date.now() + POLL_MS }
    // This wake only observes/reconciles the already dispatched prompt.
    if (!(["running", "settling"].includes(state.phase ?? "idle"))) await this.admissions.resumeDispatched(false)
    await this.scheduler.schedule("turn:observe", Date.now() + POLL_MS, {
      reservationID: reservation.reservationID,
      reservationDate: reservation.date,
      sessionID: state.sessionID,
      reason: "recovery-wake-observation",
    })
    return undefined
  }

  private async processLeaseRenew(payload: ConversationJobPayload): Promise<undefined> {
    const record = await this.leases.status()
    if (!record) {
      if (payload.reason === "adopt-running-lease" && this.nativeLeaseEnabled() && this.ctx.container?.running) {
        await this.leases.ensureHeld()
      }
      return undefined
    }
    await this.leases.maintain()
    return undefined
  }

  // ---------------------------------------------------------------- container

  /** Test seam: replaces the container port for a given number. */
  transport?: (number: number) => ContainerPort

  private async withClient<T>(fn: (client: ReturnType<typeof makeClient>) => Promise<T>, recoverOnRejection = true): Promise<T> {
    let used: { port: ContainerPort; generation?: string } | undefined
    try {
      const result = await this.runtimeAccess.useReady(async (port) => {
        used = { port, generation: this.runtime.generation }
        return await this.withClientOwned(fn, port)
      })
      this.consecutiveFailures = 0
      return result
    } catch (error) {
      if (error instanceof AccountingPolicyError || error instanceof IdleClosePendingError) throw error
      // An invalid command/form or an unsupported optional endpoint does not
      // prove the container is wedged. Never recycle live work for that. Real
      // transport failures keep the existing recovery behavior.
      if (!recoverOnRejection && !(error instanceof ClientError && error.reason === "Transport")) throw error
      // A cold start that outlasts the wait is slow, not wedged: do not count
      // it as a failure or recycle the container out from under itself.
      if (error instanceof Error && error.message.includes("did not become ready")) throw error
      this.consecutiveFailures++
      // Two consecutive failures: assume the container is wedged and recycle it.
      const recycle = this.consecutiveFailures >= 2
      if (recycle) {
        this.consecutiveFailures = 0
        void this.count("container.recycled")
        logEvent("container.recycled")
      }
      if (used) {
        await this.runtimeAccess.exclusive(async () => {
          // A newer prepare may have replaced this generation after the read
          // borrow ended. Never invalidate or destroy that newer runtime.
          if (this.runtime.apiPort !== used!.port || this.runtime.generation !== used!.generation) return
          this.runtime.invalidate()
          if (recycle && await this.runtime.stop()) await this.leases.releaseAfterStop()
        })
      }
      throw error
    }
  }

  /** Invoke a client on a port already owned by an exclusive/runtime borrower. */
  private async withClientOwned<T>(
    fn: (client: ReturnType<typeof makeClient>) => Promise<T>,
    port: ContainerPort = this.runtime.apiPort!,
  ): Promise<T> {
    if (!port) throw new Error("runtime port is unavailable")
    return await fn(makeClient(portFetch(port)))
  }

  /** Prepare the runtime without acquiring a second RuntimeAccess borrow. */
  private async ensureReadyOwned(): Promise<ContainerPort> {
    if (!this.key) throw new Error("conversation identity unavailable; runtime preparation is blocked")
    await this.idleClose.beforePrepareOwned()
    return this.runtime.ensureReady(() => this.readiness.prepare())
  }

  /** Start the container, restore the checkpoint on first boot, start OpenCode. */
  private ensureReady(): Promise<ContainerPort> {
    return this.runtimeAccess.prepare()
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
