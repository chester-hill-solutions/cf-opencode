import { DurableObject } from "cloudflare:workers"
import { Lifecycle } from "agents/lifecycle"
import { ClientError } from "@opencode/client"
import { makeClient, portFetch, type ContainerPort } from "./opencode"
import {
  ConversationStore,
  isBenignSlackControlTombstones,
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
import { ConversationIdleClose, IdleClosePendingError, parseIdleCloseMs } from "./conversation/idle-close"
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
import { ConversationDeliveryControls } from "./conversation/delivery-controls"
import { ConversationMessagePipeline } from "./conversation/message-pipeline"
import { passiveReadRoute } from "./conversation/turn-replies"
import { queueCapacity } from "./queue"
import { projectTurnObservation, type PersistedTurnTimeout } from "./turn-observation"
import { ConversationAdmissions } from "./conversation/admissions"
import { ConversationRuntimeUpgrades } from "./conversation/runtime-upgrades"
import { ConversationWorkspaceChecks } from "./conversation/workspace-checks"
import { ConversationWorkspaceCheckDispatcher } from "./conversation/workspace-check-dispatcher"
import { checkCollectorConfig } from "./workspace-check-collector"
import { LEGACY_ALARM_MIGRATION_KEY, isFreshLegacyAlarmMigration } from "./conversation/job-state"
import type { PermissionRequest, SlackFormRequest } from "./conversation/control-plane"
export type { PermissionRequest, SlackFormRequest } from "./conversation/control-plane"
import type { Env } from "./env"
import { logEvent } from "./log"
import type { HarnessSettings } from "./settings"
import { staleAction } from "./lifecycle"
import { GITHUB_TOKEN_KEY, workspaceID } from "./vault"
import { LEGACY_ACCOUNT_STATE_KEY, parseConversationKey } from "./tenancy"
import { AccountingPolicyError } from "./accounting-policy"
import { parseWorkspaceRepositorySelection, parseWorkspaceRepositoryBinding, WorkspaceRepositoryConflictError } from "./workspace-repository"
import { parseOperatorReconciliationProposal } from "./operator-reconciliation"
import { hasConnectedProvider } from "./onboarding"
import type { ConversationJobPayload } from "./conversation/jobs"
import { ConversationScheduler } from "./conversation/scheduler"
import { ConversationSessions } from "./conversation/sessions"
import { ConversationSlackAdapter } from "./conversation/slack-adapter"
import { ConversationProviderOnboarding } from "./conversation/provider-onboarding"
import { ConversationProviderRepair, ProviderRepairError } from "./conversation/provider-repair"
import { ConversationWorkspaceLifecycle, WorkspaceMaintenanceError } from "./conversation/workspace-lifecycle"
import { isWorkspaceLifecycleMetadata } from "./workspace-profile"
import { ConversationFinalReplies } from "./conversation/final-replies"
import { readWorkspaceCheckBytes } from "./conversation/workspace-checks"
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
  private readonly workspaceChecks: ConversationWorkspaceChecks
  private readonly checkDispatcher: ConversationWorkspaceCheckDispatcher
  private readonly sessions: ConversationSessions
  private readonly deliveryControls: ConversationDeliveryControls
  private messages?: ConversationMessagePipeline
  private readonly slackAdapter: ConversationSlackAdapter
  private readonly providerOnboarding: ConversationProviderOnboarding
  private readonly providerRepair: ConversationProviderRepair
  private readonly finalReplies: ConversationFinalReplies
  private readonly workspaceLifecycle: ConversationWorkspaceLifecycle
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
        get: () => this.runtimeContainer(),
      },
      startup: {
        start: () => this.startContainer(),
        prepareImage: (container) => this.images.prepareContainerImageVariant(container),
        options: () => this.startOptions(),
      },
      snapshots: {
        snapshotHandle: () => this.snapshotHandle(),
        clearSnapshot: () => this.clearSnapshot(),
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
      assertAvailable: async () => { if (await this.workspaceLifecycle.hasPending()) throw new WorkspaceMaintenanceError() },
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
        checkNotify: () => this.checkDispatcher.notify(),
        replyDeliver: () => this.finalReplies.deliver(),
      },
      replyWake: () => this.finalReplies.nextAt(),
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
        CONTAINER_INSTANCE_PROFILE: this.env.CONTAINER_INSTANCE_PROFILE,
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
      finalReply: (state, text, assistantID) => this.finalReplies.prepare(state, text, assistantID),
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
      queueLimit: queueCapacity(env.QUEUE_LIMIT),
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
        pendingMaintenance: async () => await this.providerRepair.hasPending() || await this.workspaceLifecycle.hasPending(),
      },
      jobs: { schedule: (kind, at, payload) => this.scheduler.schedule(kind, at, payload) },
      prompt: async (sessionID, text) => {
        await this.withClient((client) => client.session.prompt({ sessionID, text, delivery: "queue" }))
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
      idleCloseMs: parseIdleCloseMs(this.env.IDLE_CLOSE_SECONDS),
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
        this.scheduler.hasActiveOtherThan("container:idle") || await this.runtimeUpgrades.hasPending() || await this.providerRepair.hasPending(),
      withAdmissionLock: (task) => this.admissions.withLock(task),
      stopStream: () => this.turnExecution.stopStream(),
      prove: (client, sessionID) => this.runtimeUpgrades.proveSession(client, sessionID),
      jobs: {
        schedule: (at, payload) => this.scheduler.schedule("container:idle", at, { ...payload, reason: "unused-runtime" }),
        cancel: () => this.scheduler.cancel("container:idle"),
      },
    })

    this.deliveryControls = new ConversationDeliveryControls({
      storage: ctx.storage,
      store: this.store,
      withLock: (task) => this.admissions.withLock(task),
      unavailable: async () => this.recoveryActions.active || await this.runtimeUpgrades.hasPending(),
      admitting: () => this.admissions.active,
      queueLimit: queueCapacity(env.QUEUE_LIMIT),
      steer: async (sessionID, text) => { await this.withClient((client) => client.session.prompt({ sessionID, text, delivery: "steer", resume: false }), false) },
      interrupt: async (sessionID) => { await this.withClient((client) => client.session.interrupt({ sessionID, resume: false }), false) },
      schedule: async () => {
        const state = await this.store.get()
        if (state.sessionID && (state.phase === "running" || state.phase === "settling")) await this.scheduler.schedule("turn:observe", Date.now() + POLL_MS, {
          reservationID: state.budgetReservation?.reservationID, reservationDate: state.budgetReservation?.date,
          sessionID: state.sessionID, reason: "manual-interrupt",
        })
        const head = state.queue?.[0]
        if (head) await this.scheduler.schedule("admission:retry", Date.now() + POLL_MS, { queueID: head.id, reason: "manual-follow-up" })
      },
      event: (event) => this.deliver(event, { slack: false }),
    })
    this.slackAdapter = new ConversationSlackAdapter({
      workspaceCommands: {
        enabled: target => Boolean(env.CHECK_SLACK_CHANNEL_ID && target.channel === env.CHECK_SLACK_CHANNEL_ID),
        repository: request => this.workspaceRepository(request),
        workspace: request => this.workspaceLifecycle.fetch(request),
        check: async (argv, target, eventID) => {
          try { return await this.checkDispatcher.queue(argv, target, eventID) }
          catch (error) {
            if (error instanceof Error && "code" in error && error.code === "WORKSPACE_CHECK_RUNTIME_NOT_WARM") {
              return "Check not queued: the workspace is not warm. Use the existing normal message/start workflow first, then retry !check after the agent is idle. This command did not start a runtime or model."
            }
            return "Check could not be queued. A bound, idle, warm workspace and the configured trusted collector are required. Inspect !repo and !checks; no check execution was authorized by this refusal."
          }
        },
        checks: () => this.checkDispatcher.status(),
      },
      observation: () => this.turnObservation(),
      controls: {
        steer: async (text) => {
          const result = await this.deliveryControls.steer(text)
          if (result.error === "no_active_turn") return "No running turn to steer. Send a normal message to start or queue work."
          return result.ok ? "Guidance accepted; the running turn may use it at its next step. No new budget hold was created." : `Steering ${result.outcome === "ambiguous" ? "outcome is unknown; do not resend automatically" : "was refused"}: ${result.error}`
        },
        stop: async (followUp, target) => {
          const result = await this.deliveryControls.stop(followUp, { replaceQueue: true, slack: target })
          if (!result.ok) return `Stop ${result.outcome === "ambiguous" ? "outcome is unknown; the hold and follow-up are retained" : "was refused"}: ${result.error}`
          return result.stopRequested
            ? `Stop requested; runtime stop is unconfirmed. Usage settlement must finish before ${followUp ? "the queued follow-up" : "another turn"}.`
            : followUp ? "Follow-up queued; no active turn needed interruption." : "Queued follow-ups cleared; no active turn needed interruption."
        },
      },
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
    this.workspaceChecks = new ConversationWorkspaceChecks({
      id: ctx.id.toString(), storage: ctx.storage, store: this.store,
      bucket: env.CHECKPOINTS, checkpoints: this.checkpoints,
      admission: (task) => this.admissions.withLock(task),
      usage: (task) => this.usage.serialize(task),
      isWarm: () => Boolean(this.runtime.ready && this.runtime.apiPort && this.runtime.generation && this.controlPlane.cachedToken &&
        (this.transport || this.env.CONTAINER_URL || this.ctx.container?.running === true)),
      useWarmRuntime: (task) => this.runtimeAccess.useWarm(task),
      control: () => this.runtime.warmControlPort(this.controlPlane.cachedToken ?? ""),
      blocked: async () => this.admissions.active || this.turnExecution.isPumping || this.recoveryActions.active || await this.runtimeUpgrades.hasPending(),
    })
    this.checkDispatcher = new ConversationWorkspaceCheckDispatcher({
      id: ctx.id.toString(), key: () => this.key ?? ctx.id.name ?? ctx.id.toString(), storage: ctx.storage,
      checks: this.workspaceChecks, checkpoints: this.checkpoints, bucket: env.CHECKPOINTS,
      admission: task => this.admissions.withLock(task),
      config: () => checkCollectorConfig(env),
      register: async () => {
        const result = await env.SETTINGS.getByName("global").fetch("https://settings/conversations", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: this.key ?? ctx.id.name ?? ctx.id.toString() }),
        })
        if (!result.ok) throw new Error("check registry unavailable")
      },
      schedule: at => this.scheduler.schedule("check:notify", at),
      notify: async (target, text) => {
        if (!env.SLACK_BOT_TOKEN) return false
        const result = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST", headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ channel: target.channel, thread_ts: target.replyTs, text, unfurl_links: false, unfurl_media: false, parse: "none" }),
          signal: AbortSignal.timeout(10_000), redirect: "manual",
        })
        return result.ok && (await result.json() as { ok?: boolean }).ok === true
      },
    })
    this.providerRepair = new ConversationProviderRepair({
      id: ctx.id.toString(), storage: ctx.storage, store: this.store, bucket: env.CHECKPOINTS, checkpoints: this.checkpoints,
      enabled: () => Boolean(env.SLACK_CANARY_CHANNEL === "C0A5YNXLP6C" && this.key && /^C0A5YNXLP6C:\d+\.\d+$/.test(this.key)),
      admission: task => this.admissions.withLock(task), usage: task => this.usage.serialize(task), exclusive: task => this.runtimeAccess.exclusive(task),
      warmPort: () => this.runtime.ready && this.runtime.generation && (this.transport || env.CONTAINER_URL || this.ctx.container?.running === true) ? this.runtime.apiPort : undefined,
      prepareOwned: () => this.ensureReadyOwned(), stopStream: () => this.turnExecution.stopStream(),
      blocked: async () => this.admissions.active || this.turnExecution.isPumping || this.recoveryActions.active || this.scheduler.activeCount > 0 || await this.runtimeUpgrades.hasPending(),
      source: async () => {
        const response = await env.CONVERSATION.getByName("onboarding").fetch("https://conversation/provider-credentials", { headers: { "x-conversation-key": "onboarding" } })
        if (!response.ok) throw new Error("Provider source unavailable")
        return JSON.parse(new TextDecoder().decode(await readWorkspaceCheckBytes(response.body, 64 * 1024)))
      },
    })
    this.workspaceLifecycle = new ConversationWorkspaceLifecycle({
      id: ctx.id.toString(), storage: ctx.storage, admission: task => this.admissions.withLock(task),
      cleanupOwned: (operation, beforeCleanup, resume) => this.cleanupWorkspaceOwned(operation, beforeCleanup, resume),
    })
    this.finalReplies = new ConversationFinalReplies({
      storage: ctx.storage, store: this.store, schedule: at => this.scheduler.schedule("reply:deliver", at),
      send: async (target, text) => {
        if (!env.SLACK_BOT_TOKEN) throw new Error("Slack delivery is unavailable")
        const response = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST", headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ channel: target.channel, ...(target.replyTs ? { thread_ts: target.replyTs } : {}), text, parse: "none", unfurl_links: false, unfurl_media: false }),
          signal: AbortSignal.timeout(10000), redirect: "manual",
        })
        if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error("Slack delivery was not acknowledged") }
        const body = JSON.parse(new TextDecoder().decode(await readWorkspaceCheckBytes(response.body, 32 * 1024, 10000))) as { ok?: boolean }
        if (body.ok !== true) throw new Error("Slack delivery was not acknowledged")
      },
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
    // Passive inspection cannot start lifecycle recovery, jobs or lease adoption.
    if (new URL(request.url).pathname === "/workspace/preflight") return this.workspacePreflight(request)
    if (["/workspace/profile", "/workspace/discard"].includes(new URL(request.url).pathname)) return this.workspaceLifecycle.fetch(request)
    if (new URL(request.url).pathname === "/workspace/repository") return this.workspaceRepository(request)
    if (new URL(request.url).pathname === "/providers/repair") return this.providerRepair.fetch(request)
    if (/^\/workspace\/check-collector(?:\/|$)/.test(new URL(request.url).pathname)) return this.checkDispatcher.fetch(request)
    if (/^\/workspace\/checks(?:\/|$)/.test(new URL(request.url).pathname)) return this.workspaceCheckRequest(request)
    // Status and questions are passive reads: neither starts lifecycle recovery or jobs.
    const passive = await passiveReadRoute(request, this.store, () => this.controlPlane.onQuestions(), (id, body) => this.controlPlane.answerQuestion(id, body))
    if (passive) return passive
    await this.scheduler.captureLegacyAlarmMigration(false)
    return this.lifecycle.fetch(request)
  }

  async onRequest(request: Request): Promise<Response> {
    const identityError = this.acceptForwardedIdentity(request)
    if (identityError) return identityError
    try {
      return await this.routeRequest(request)
    } catch (error) {
      if (error instanceof WorkspaceRepositoryConflictError) {
        return Response.json({ error: "workspace repository conflicts with the selected task; use a new conversation", code: "WORKSPACE_REPOSITORY_CONFLICT" }, { status: 409 })
      }
      if (error instanceof IdleClosePendingError) {
        return Response.json({ error: "container close is pending; retry after stop recovery", retryable: true }, { status: 503 })
      }
      throw error
    }
  }

  private async routeRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/workspace/preflight") return this.workspacePreflight(request)
    if (url.pathname === "/workspace/profile" || url.pathname === "/workspace/discard") return this.workspaceLifecycle.fetch(request)
    if (url.pathname === "/workspace/repository") return this.workspaceRepository(request)
    if (url.pathname === "/providers/repair") return this.providerRepair.fetch(request)
    if (/^\/workspace\/check-collector(?:\/|$)/.test(url.pathname)) return this.checkDispatcher.fetch(request)
    if (/^\/workspace\/checks(?:\/|$)/.test(url.pathname)) return this.workspaceCheckRequest(request)
    if (url.pathname === "/message") return this.onMessage((await request.json()) as MessageRequest)
    if (url.pathname === "/slack") {
      const input = await request.json() as SlackEventRequest
      if (await this.workspaceLifecycle.hasPending() && !/^\s*(?:<@[^>]+>\s*)?!workspace(?:\s|$)/i.test(input.event.text ?? "")) {
        if (input.event.channel) await this.slackAdapter.postChunked(input.event.channel, "Workspace cleanup is pending. Use !workspace to inspect or resume the same discard; no message was queued.", input.replyTs).catch(() => {})
        return Response.json({ error: "workspace maintenance pending", code: "WORKSPACE_DISCARD_PENDING" }, { status: 409 })
      }
      if (await this.providerRepair.hasPending()) {
        if (input.event.channel) await this.slackAdapter.postChunked(input.event.channel, "Provider credential repair is pending. No message was queued; an operator must finish the same repair first.", input.replyTs).catch(() => {})
        return Response.json({ error: "provider repair pending", code: "PROVIDER_REPAIR_PENDING" }, { status: 409 })
      }
      return this.slackAdapter.onEvent(input)
    }
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
    if (url.pathname === "/state") return Response.json({ ...await this.store.get(), turnObservation: await this.turnObservation(), stop: await this.stopObservation() })
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
        turnObservation: await this.turnObservation(),
        stop: await this.stopObservation(),
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

  /** Export intent and collector execution retain their separate provenance. */
  private async workspaceCheckRequest(request: Request): Promise<Response> {
    const response = await this.workspaceChecks.fetch(request)
    const match = /^\/workspace\/checks\/([a-f0-9-]+)$/.exec(new URL(request.url).pathname)
    if (request.method !== "GET" || !match || !response.ok) return response
    try {
      const body = await response.json() as { workspaceCheck: unknown }
      return Response.json({ ...body, execution: await this.checkDispatcher.get(match[1]!) ?? null }, { headers: { "cache-control": "no-store" } })
    } catch { return Response.json({ error: "Workspace check status is unavailable." }, { status: 503, headers: { "cache-control": "no-store" } }) }
  }

  /** Select a fresh task without preparing Linux, sessions or accounting. */
  private async workspaceRepository(request: Request): Promise<Response> {
    const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } })
    if (request.method === "GET") {
      try {
        const value = (await this.store.get()).workspaceRepository
        return reply({ workspaceRepository: value === undefined ? null : parseWorkspaceRepositoryBinding(value) })
      } catch {
        return reply({ error: "workspace repository state is unavailable", code: "WORKSPACE_REPOSITORY_UNAVAILABLE" }, 503)
      }
    }
    if (request.method !== "PUT") {
      return Response.json({ error: "method not allowed" }, { status: 405, headers: { allow: "GET, PUT", "cache-control": "no-store" } })
    }
    let input: unknown
    try { input = await request.json() } catch { return reply({ error: "valid JSON is required" }, 400) }
    if (!isRecord(input) || Object.keys(input).some((key) => !["repository", "baseBranch", "workingBranch"].includes(key)) ||
      typeof input.workingBranch !== "string" ||
      (input.repository !== undefined && typeof input.repository !== "string") ||
      (input.baseBranch !== undefined && typeof input.baseBranch !== "string")) {
      return reply({ error: "repository selection requires a workingBranch and optional repository/baseBranch" }, 400)
    }
    const body = input
    return this.admissions.withLock(async () => {
      let selection: ReturnType<typeof parseWorkspaceRepositorySelection>
      try {
        const existing = (await this.store.get()).workspaceRepository
        const defaults = existing ? parseWorkspaceRepositoryBinding(existing) :
          (body.repository === undefined || body.baseBranch === undefined ? await this.settings() : undefined)
        selection = parseWorkspaceRepositorySelection({
          repository: body.repository ?? (defaults && ("repository" in defaults ? defaults.repository : defaults.workspaceRepo)),
          baseBranch: body.baseBranch ?? (defaults && ("baseBranch" in defaults ? defaults.baseBranch : defaults.workspaceBranch)),
          workingBranch: body.workingBranch,
        })
      } catch {
        return reply({ error: "invalid repository selection" }, 400)
      }
      const conflict = () => reply({ error: "workspace is already bound or has accepted work; use a new conversation", code: "WORKSPACE_REPOSITORY_CONFLICT" }, 409)
      const current = (await this.store.get()).workspaceRepository
      if (current) {
        const result = await this.store.selectWorkspaceRepository(selection, crypto.randomUUID())
        return result.kind === "existing" ? reply({ workspaceRepository: result.binding }) : conflict()
      }
      return this.runtimeAccess.exclusive(async () => {
        if (this.admissions.active || this.turnExecution.isPumping || this.recoveryActions.active ||
          this.runtime.ready || this.runtime.generation || this.ctx.container?.running || await this.runtimeUpgrades.hasPending()) return conflict()
        const stored = await this.ctx.storage.list()
        for (const [key, value] of stored) {
          if (key === "state") continue
          if (isWorkspaceLifecycleMetadata(key, value)) continue
          if (key === "conversationJobEpoch" && Number.isSafeInteger(value) && (value as number) > 0) continue
          if (key === LEGACY_ALARM_MIGRATION_KEY && isFreshLegacyAlarmMigration(value)) continue
          if (/^tombstones:\d{4}-\d{2}-\d{2}$/.test(key) && isBenignSlackControlTombstones(value, await this.store.get())) continue
          return conflict()
        }
        const result = await this.store.selectWorkspaceRepository(selection, crypto.randomUUID())
        if (result.kind === "selected") return reply({ workspaceRepository: result.binding }, 201)
        if (result.kind === "existing") return reply({ workspaceRepository: result.binding })
        return conflict()
      })
    })
  }

  /** Read only an already verified runtime, without preparation or idle renewal. */
  private async workspacePreflight(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return Response.json({ error: "method not allowed" }, { status: 405, headers: { allow: "GET" } })
    }
    const notRunning = () => Response.json({
      error: "WORKSPACE_NOT_RUNNING",
      code: "WORKSPACE_NOT_RUNNING",
      message: "Workspace inspection requires an already running workspace. Use the existing message/start workflow first.",
    }, { status: 409, headers: { "cache-control": "no-store" } })
    // A verified warm runtime already has its control token; never create one here.
    if (!this.runtime.ready || !this.runtime.generation || !this.controlPlane.cachedToken) return notRunning()
    try {
      return await this.runtimeAccess.useWarm(async () => {
        const control = this.runtime.warmControlPort(this.controlPlane.cachedToken ?? "")
        const response = await control.fetch("http://container/workspace/preflight", {
          method: "GET",
          signal: AbortSignal.timeout(10_000),
          redirect: "manual",
        })
        // Retain the runtime borrow through the bounded response, so a stop or
        // workspace handoff cannot overlap an inspection still producing output.
        const reader = response.body?.getReader()
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          if (reader) for (;;) {
            const next = await reader.read()
            if (next.done) break
            size += next.value.byteLength
            if (size > 256 * 1024) throw new Error("workspace preflight response exceeds limit")
            chunks.push(next.value)
          }
        } catch (error) {
          await reader?.cancel().catch(() => {})
          throw error
        } finally {
          reader?.releaseLock()
        }
        const body = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
        const headers = new Headers(response.headers)
        headers.set("cache-control", "no-store")
        return new Response(response.body === null ? null : body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        })
      })
    } catch {
      if (!this.runtime.ready || !this.runtime.generation ||
        (!this.transport && !this.env.CONTAINER_URL && this.ctx.container?.running !== true)) return notRunning()
      return Response.json({ error: "WORKSPACE_PREFLIGHT_UNAVAILABLE", code: "WORKSPACE_PREFLIGHT_UNAVAILABLE", message: "Workspace inspection is unavailable; retry later." }, {
        status: 503, headers: { "cache-control": "no-store" },
      })
    }
  }

  // --------------------------------------------------------------- HTTP adapter

  private async onMessage(input: MessageRequest): Promise<Response> {
    return this.messagePipeline.handle(input)
  }

  /** Built on first use: the constructor only wires collaborators. */
  private get messagePipeline(): ConversationMessagePipeline {
    return this.messages ??= new ConversationMessagePipeline({
      store: this.store,
      admissions: this.admissions,
      deliveryControls: this.deliveryControls,
      sessions: this.sessions,
      recovery: {
        providerRepairPending: () => this.providerRepair.hasPending(),
        workspacePending: () => this.workspaceLifecycle.hasPending(),
        upgradePending: () => this.runtimeUpgrades.hasPending(),
      },
      budget: {
        acquire: () => this.acquireBudgetReservation(),
        dispatch: (reservation, baseline) => this.markBudgetReservationDispatched(reservation, baseline),
      },
      prompt: async (sessionID, text) => {
        await this.withClient((client) => client.session.prompt({ sessionID, text, delivery: "queue" }))
      },
      deliver: (event) => this.deliver(event),
      count: (name) => this.count(name),
      settings: () => this.settings(),
      startStream: (sessionID) => { this.ctx.waitUntil(this.turnExecution.startStream(sessionID)) },
    })
  }

  private async stopObservation() {
    const intent = await this.ctx.storage.get<{ sessionID: string; runStartedAt?: number; reservationID?: string; status: string; requestedAt: number }>("interruptIntent")
    if (!intent) return null
    const state = await this.store.get()
    const current = intent.sessionID === state.sessionID && intent.runStartedAt === (state.runStartedAt ?? null)
    return { ...intent, current, requested: true, observedStop: null,
      settled: current && !state.budgetReservation && (state.phase === "idle" || state.phase === "queued") ? true : null }
  }

  private async turnObservation() {
    return projectTurnObservation(await this.store.get(), Date.now(), await this.ctx.storage.get<PersistedTurnTimeout>("turnTimeout"))
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
  private async onReset(): Promise<Response> { return this.workspaceLifecycle.legacyCleanup("reset") }

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
  private async onDelete(): Promise<Response> { return this.workspaceLifecycle.legacyCleanup("delete") }

  /** Caller holds admission. Publication runs after safety/accounting preflight,
   * before any stop/archive deletion. A frozen retry needs no runtime startup. */
  private async cleanupWorkspaceOwned(operation: "reset" | "delete", beforeCleanup: () => Promise<void>, resume: boolean): Promise<Response> {
    if (await this.runtimeUpgrades.hasPending()) return Response.json({ error: "runtime upgrade is pending" }, { status: 409 })
    const blocked = await this.blockLifecycleDuringActiveTurn()
    if (blocked) return blocked
    if (!await this.turnExecution.stopStream()) return Response.json({ ok: false, error: "runtime stream did not drain; state was kept" }, { status: 503 })
    return this.withUsageLifecycle(async () => {
      const blocked = await this.blockLifecycleDuringActiveTurn()
      if (blocked) return blocked
      await beforeCleanup()
      if (!(await this.runtime.stop())) return Response.json({ ok: false, error: "container stop was not confirmed; state was kept" }, { status: 503 })
      if (!(await this.leases.releaseAfterStop())) return Response.json({ ok: false, error: "container lease release is pending; state was kept" }, { status: 503 })
      await this.checkpoints.deleteAll()
      await this.workspaceChecks.clear()
      await this.checkDispatcher.clear()
      await this.providerRepair.clear()
      await this.finalReplies.clear()
      await this.scheduler.reset()
      this.controlPlane.clearCache()
      this.readiness.resetProviderSync()
      if (operation === "delete") logEvent("conversation.deleted")
      return Response.json({ ok: true })
    }, resume)
  }

  /** Do not destroy state or archives while a turn or owned hold is unresolved. */
  private async blockLifecycleDuringActiveTurn(): Promise<Response | undefined> {
    if (!this.workspaceLifecycle.cleanupActive && await this.workspaceLifecycle.hasPending()) return Response.json({ error: "workspace cleanup pending", code: "WORKSPACE_DISCARD_PENDING" }, { status: 409 })
    if (await this.finalReplies.hasPending()) return Response.json({ error: "final reply delivery is pending", code: "FINAL_REPLY_PENDING" }, { status: 409 })
    if (await this.providerRepair.hasPending()) return Response.json({ error: "provider repair pending", code: "PROVIDER_REPAIR_PENDING" }, { status: 409 })
    if (await this.checkDispatcher.hasUnresolved()) return Response.json({ error: "workspace check execution or delivery is unresolved; reconcile the collector before reset/delete", code: "CHECK_EXECUTION_UNRESOLVED" }, { status: 409 })
    if (await this.ctx.storage.get<boolean>("lifecycleJobsSealed")) {
      return Response.json({ ok: false, error: "lifecycle jobs are sealed; inspect recovery and retry before cleanup" }, { status: 409 })
    }
    const state = await this.store.get()
    const phase = state.phase ?? "idle"
    const active = phase === "admitting" || phase === "running" || phase === "settling" || phase === "queued" || Boolean(state.queue?.length)
    if (Object.keys(state.pending).length || state.budgetReservation || active || this.recoveryActions.active || this.scheduler.activeCount > 0 || state.checkpointPending) {
      return Response.json(
        { ok: false, error: "conversation has unresolved work; wait for it to settle before reset or delete" },
        { status: 409 },
      )
    }
    return undefined
  }

  /** Keep the usage queue locked through cleanup so a late replay cannot resurrect state. */
  private withUsageLifecycle(cleanup: () => Promise<Response>, cleanupAlreadyFenced = false): Promise<Response> {
    return this.usage.serialize(async () => {
      try {
        const state = await this.store.get()
        if (state.sessionID && !cleanupAlreadyFenced) {
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
  protected runtimeContainer(): DurableObjectState["container"] {
    return this.ctx.container
  }

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
    queueID?: string,
  ): Promise<boolean> {
    await this.scheduler.captureLegacyAlarmMigration(false)
    await this.lifecycle.start()
    return await this.budgetReservations.markDispatched(reservation, turnBaseline, queueID)
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
      const reported = await this.ctx.storage.get<PersistedTurnTimeout>("turnTimeout")
      if (!reported || reported.sessionID !== state.sessionID || reported.runStartedAt !== state.runStartedAt) {
        await this.ctx.storage.put("turnTimeout", { sessionID: state.sessionID, runStartedAt: state.runStartedAt, observedAt: Date.now() })
        await this.count("turn.timedout")
        logEvent("turn.timedout", {
          conversationID: this.ctx.id.toString(),
          sessionID: state.sessionID,
          ...(state.runStartedAt ? { durationMs: Date.now() - state.runStartedAt } : {}),
        })
      }
      if (state.budgetReservation?.dispatched) {
        await this.turnExecution.pauseSettlement("turn exceeded its time limit; dispatched reservation retained while context is checked")
      } else {
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
      if (!state.queue?.[0] || state.queue?.[0].id !== payload.queueID) return undefined
      const due = state.queue?.[0].nextAttemptAt ?? 0
      if (Date.now() < due) return { rescheduleAt: due }
      if (this.admissions.active || this.turnExecution.isPumping || this.recoveryActions.active) return { rescheduleAt: Date.now() + POLL_MS }
      await this.admissions.drainQueue()
      const after = await this.store.get()
      if (!after.queue?.[0] || after.queue?.[0].id !== payload.queueID) return undefined
      return { rescheduleAt: Math.max(after.queue?.[0].nextAttemptAt ?? 0, Date.now() + POLL_MS) }
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
      const queueID = state.queue?.[0]?.id
      const retryAt = state.queue?.[0] ? Math.max(state.queue?.[0].nextAttemptAt ?? 0, Date.now()) : undefined
      await this.ctx.storage.transaction(async () => {
        const current = await this.store.get()
        if ((current.phase ?? "idle") !== "admitting" || current.budgetReservation?.dispatched ||
          (payload.admissionID && current.admissionID !== payload.admissionID)) return
        await this.store.patch({
          admissionID: undefined,
          admissionStartedAt: undefined,
          phase: current.queue?.[0] ? "queued" : "idle",

        })
        if (current.queue?.[0] && queueID && retryAt !== undefined) await this.scheduler.schedule("admission:retry", retryAt, {
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
      if (error instanceof AccountingPolicyError || error instanceof IdleClosePendingError || error instanceof WorkspaceRepositoryConflictError || error instanceof ProviderRepairError || error instanceof WorkspaceMaintenanceError) throw error
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
    if (await this.workspaceLifecycle.hasPending()) throw new WorkspaceMaintenanceError()
    if (!this.providerRepair.active && await this.providerRepair.hasPending()) throw new ProviderRepairError("PROVIDER_REPAIR_PENDING")
    await this.idleClose.beforePrepareOwned()
    const port = await this.runtime.ensureReady(() => this.readiness.prepare())
    if (!this.providerRepair.active) await this.providerRepair.verifyPrepared(port)
    return port
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
