import { DurableObject } from "cloudflare:workers"
import { Lifecycle } from "agents/lifecycle"
import { ClientError } from "@opencode/client"
import { makeClient, portFetch, type ContainerPort } from "./opencode"
import {
  ConversationStore,
  type BudgetReservation,
  type ConversationPhase,
  type ConversationState,
} from "./state"
import {
  isSettled,
  turnMessages,
  toMillis,
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
import { ConversationAdmissions } from "./conversation/admissions"
import { ConversationRuntimeUpgrades } from "./conversation/runtime-upgrades"
import { isFreshLegacyAlarmMigration } from "./conversation/job-state"
import type { PermissionRequest, SlackFormRequest } from "./conversation/control-plane"
export type { PermissionRequest, SlackFormRequest } from "./conversation/control-plane"
import type { Env } from "./env"
import { logEvent } from "./log"
import type { HarnessSettings } from "./settings"
import { staleAction } from "./lifecycle"
import { GITHUB_TOKEN_KEY, workspaceID } from "./vault"
import { LEGACY_ACCOUNT_STATE_KEY, parseConversationKey } from "./tenancy"
import { AccountingPolicyError } from "./accounting-policy"
import { IdleClosePendingError } from "./conversation/idle-close"
import { parseOperatorReconciliationProposal } from "./operator-reconciliation"
import { hasConnectedProvider } from "./onboarding"
import type { ConversationJobPayload } from "./conversation/jobs"
import { ConversationScheduler } from "./conversation/scheduler"
import { ConversationSessions } from "./conversation/sessions"
import { ConversationSlackAdapter } from "./conversation/slack-adapter"
import { ConversationProviderOnboarding } from "./conversation/provider-onboarding"
import type { MessageRequest, SlackEventRequest } from "./conversation/requests"
export type { MessageRequest, SlackEventRequest } from "./conversation/requests"

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
  private readonly sessions: ConversationSessions
  private readonly slackAdapter: ConversationSlackAdapter
  private readonly providerOnboarding: ConversationProviderOnboarding
  private consecutiveFailures = 0
  /** Canonical name when named; forwarded key is only a validated fallback. */
  private key?: string

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
    this.providerOnboarding = new ConversationProviderOnboarding({
      identity: { key: () => this.key },
      runtime: this.runtime,
      access: this.runtimeAccess,
      withClient: (fn, recoverOnRejection) => this.withClient(fn, recoverOnRejection),
      store: this.store,
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
        toSlack: (event) => this.slackAdapter.deliverToSlack(event),
        slack: (method, body) => this.slackAdapter.slack(method, body),
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
        onboardingOperations: () => this.providerOnboarding.activeOperations,
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
    this.sessions = new ConversationSessions({
      store: this.store,
      runtime: this.runtime,
      upgrades: this.runtimeUpgrades,
      prepare: () => this.ensureReady(),
      leases: this.leases,
      usage: this.usage,
      settings: () => this.settings(),
      withClient: (fn, recoverOnRejection) => this.withClient(fn, recoverOnRejection),
    })
    this.admissions = new ConversationAdmissions({
      conversationID: ctx.id.toString(),
      storage: ctx.storage,
      store: this.store,
      budgetReservations: this.budgetReservations,
      session: {
        ensure: (text, transport, slack) => this.sessions.ensure(text, transport, slack),
        baseline: (sessionID) => this.sessions.baseline(sessionID),
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
        postChunked: (channel, text, threadTs) => this.slackAdapter.postChunked(channel, text, threadTs),
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
        this.recoveryActions.active || this.providerOnboarding.activeOperations > 0 ||
        this.scheduler.hasActiveOtherThan("container:idle") || await this.runtimeUpgrades.hasPending(),
      withAdmissionLock: (task) => this.admissions.withLock(task),
      stopStream: () => this.turnExecution.stopStream(),
      prove: (client, sessionID) => this.runtimeUpgrades.proveSession(client, sessionID),
      jobs: {
        schedule: (at, payload) => this.scheduler.schedule("container:idle", at, { ...payload, reason: "unused-runtime" }),
        cancel: () => this.scheduler.cancel("container:idle"),
      },
    })

    this.slackAdapter = new ConversationSlackAdapter({
      store: this.store,
      sessions: this.sessions,
      admissions: this.admissions,
      budget: {
        acquire: () => this.acquireBudgetReservation(),
        markDispatched: (reservation, baseline) => this.markBudgetReservationDispatched(reservation, baseline),
      },
      controlPlane: this.controlPlane,
      upgrades: this.runtimeUpgrades,
      turnExecution: this.turnExecution,
      scheduler: this.scheduler,
      recovery: this.recoveryActions,
      withClient: (fn, recoverOnRejection) => this.withClient(fn, recoverOnRejection),
      withUsageLifecycle: (cleanup) => this.withUsageLifecycle(cleanup),
      settings: () => this.settings(),
      usageToday: async () => {
        const response = await this.env.SETTINGS.getByName("global").fetch("https://settings/usage/today")
        if (!response.ok) throw new Error("Usage is temporarily unavailable")
        return await response.json() as {
          date: string; costUSD: number; reservedUSD: number; input: number; output: number
          historicalUsageUnreconciled?: boolean; unknownReconciliationCount?: number
        }
      },
      deliver: (event, options) => this.deliver(event, options),
      waitUntil: (promise) => this.ctx.waitUntil(promise),
      conversationKey: () => this.key ?? this.ctx.id.name ?? this.ctx.id.toString(),
      env: () => ({ SLACK_BOT_TOKEN: this.env.SLACK_BOT_TOKEN, SLACK_BOT_USER_ID: this.env.SLACK_BOT_USER_ID }),
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
    if (url.pathname === "/slack") return this.slackAdapter.onEvent((await request.json()) as SlackEventRequest)
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
    if (url.pathname === "/provider-credentials") return this.providerOnboarding.providerCredentials(request)
    if (url.pathname === "/provider-status") {
      if (this.key !== ONBOARDING_KEY || request.method !== "GET") return Response.json({ error: "forbidden" }, { status: 403 })
      try {
        const providers = await this.withClient((client) => client.integration.list(), false)
        return Response.json({ connected: hasConnectedProvider(providers.data) })
      } catch {
        return Response.json({ error: "provider status unavailable", retryable: true }, { status: 503 })
      }
    }
    if (url.pathname.startsWith("/onboarding")) return this.providerOnboarding.onboarding(url.pathname, request)
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
      return this.providerOnboarding.debugProviders()
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
      sessionID = await this.sessions.ensure(text, input.transport ?? "http", input.slack)
      baseline = await this.sessions.baseline(sessionID)
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
    await this.slackAdapter.deliverToSlack(event)
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
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
