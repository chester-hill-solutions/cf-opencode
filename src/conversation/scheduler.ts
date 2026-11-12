import { isContainerIdleRecord } from "./idle-state"
import type { RecoverySchedulerEvidence } from "../recovery"
import type { MemoryLimitContext, LifecycleJobOutcome } from "agents/lifecycle"
import { ConversationJobs, type ConversationJobKind, type ConversationJobPayload } from "./jobs"
import { ConversationStore, type ConversationState } from "../state"
import { LEGACY_ALARM_MIGRATION_KEY, type LegacyAlarmMigration } from "./job-state"

const POLL_MS = 2000
const CHECKPOINT_RETRY_MS = 30_000

type DomainOutcome = { rescheduleAt: number } | undefined
type DomainWork = (payload: ConversationJobPayload) => Promise<DomainOutcome>

export interface ConversationSchedulerOptions {
  storage: DurableObjectStorage
  store: ConversationStore
  waitUntil(promise: Promise<unknown>): void
  adoptLeaseIfNeeded(): Promise<void>
  work: {
    turnObserve: DomainWork
    admissionRetry: DomainWork
    checkpointRetry: DomainWork
    recoveryWake: DomainWork
    leaseRenew: DomainWork
    idleClose?: DomainWork
  }
}

/** Owns the Lifecycle job capability and conversation-side durable job fences. */
export class ConversationScheduler {
  readonly capability: ConversationJobs
  private jobEpoch = 0
  private readonly active = new Set<ConversationJobKind>()

  constructor(private readonly options: ConversationSchedulerOptions) {
    this.capability = new ConversationJobs({
      onStart: () => this.installLegacyAlarmBootstrap(),
      turnObserve: (payload) => this.handoff("turn:observe", payload, () => options.work.turnObserve(payload)),
      admissionRetry: (payload) => this.handoff("admission:retry", payload, () => options.work.admissionRetry(payload)),
      checkpointRetry: (payload) => this.handoff("checkpoint:retry", payload, () => options.work.checkpointRetry(payload)),
      recoveryWake: (payload) => this.handoff("recovery:wake", payload, () => options.work.recoveryWake(payload)),
      legacyBootstrap: (payload) => this.runLegacyAlarmBootstrap(payload),
      leaseRenew: (payload) => this.handoff("lease:renew", payload, () => options.work.leaseRenew(payload)),
      idleClose: (payload) => this.handoff("container:idle", payload, () => options.work.idleClose?.(payload) ?? Promise.resolve(undefined)),
      onJobError: (kind, payload, error) => this.handleJobError(kind, payload, error),
      onMemoryLimit: (context) => this.onMemoryLimit(context),
    })
  }

  get activeCount(): number {
    return this.active.size
  }

  hasActiveOtherThan(kind: ConversationJobKind): boolean {
    return [...this.active].some((active) => active !== kind)
  }

  async epoch(): Promise<number> {
    if (this.jobEpoch > 0) return this.jobEpoch
    const stored = await this.options.storage.get<number>("conversationJobEpoch")
    this.jobEpoch = Number.isSafeInteger(stored) && (stored as number) > 0 ? stored as number : 1
    if (stored === undefined) await this.options.storage.put("conversationJobEpoch", this.jobEpoch)
    return this.jobEpoch
  }

  async schedule(
    kind: ConversationJobKind,
    at: number,
    payload: Omit<ConversationJobPayload, "epoch" | "dueAt"> = {},
    allowSealed = false,
  ): Promise<void> {
    const epoch = await this.epoch()
    if (!allowSealed && await this.options.storage.get<boolean>("lifecycleJobsSealed")) {
      throw new Error("conversation recovery jobs are sealed after an alarm memory limit")
    }
    await this.capability.schedule(kind, at, { ...payload, epoch, dueAt: at })
  }

  cancel(kind: ConversationJobKind): Promise<void> {
    return this.capability.cancel(kind)
  }

  has(kind: ConversationJobKind): boolean {
    return this.capability.has(kind)
  }

  isCurrent(payload: ConversationJobPayload): Promise<boolean> {
    return this.epoch().then((epoch) => payload.epoch === epoch)
  }

  /** Capture the old physical alarm before Lifecycle can replace its alarm source. */
  async captureLegacyAlarmMigration(alarmEntry: boolean): Promise<void> {
    await this.options.storage.transaction(async (txn) => {
      if (await txn.get<LegacyAlarmMigration>(LEGACY_ALARM_MIGRATION_KEY)) return
      // Read and write under one local transaction so SDK startup cannot
      // replace an old alarm between observing it and publishing the marker.
      const physicalAlarm = await txn.getAlarm()
      const dueAt = physicalAlarm ?? (alarmEntry ? Date.now() : null)
      await txn.put<LegacyAlarmMigration>(LEGACY_ALARM_MIGRATION_KEY, {
        version: 1,
        dueAt,
        scheduled: false,
        consumed: dueAt === null,
      })
    })
  }

  private async installLegacyAlarmBootstrap(): Promise<void> {
    await this.epoch()
    await this.options.storage.transaction(async (txn) => {
      const migration = await txn.get<LegacyAlarmMigration>(LEGACY_ALARM_MIGRATION_KEY)
      if (!migration || migration.version !== 1 || migration.dueAt === null ||
        migration.scheduled || migration.consumed || await txn.get<boolean>("lifecycleJobsSealed")) return
      const dueAt = Math.max(Date.now(), migration.dueAt)
      await this.schedule("legacy:bootstrap", dueAt, { reason: "legacy-alarm-bootstrap" })
      await txn.put<LegacyAlarmMigration>(LEGACY_ALARM_MIGRATION_KEY, { ...migration, dueAt, scheduled: true })
    })
    await this.options.adoptLeaseIfNeeded()
  }

  private async runLegacyAlarmBootstrap(payload: ConversationJobPayload): Promise<LifecycleJobOutcome> {
    if (!(await this.isCurrent(payload))) return undefined
    await this.options.storage.transaction(async (txn) => {
      const migration = await txn.get<LegacyAlarmMigration>(LEGACY_ALARM_MIGRATION_KEY)
      if (!migration || migration.version !== 1 || !migration.scheduled || migration.consumed) return
      if (await txn.get<boolean>("lifecycleJobsSealed")) {
        await txn.put<LegacyAlarmMigration>(LEGACY_ALARM_MIGRATION_KEY, {
          ...migration,
          scheduled: false,
          consumed: true,
        })
        return
      }
      await this.rehydrateConversationJobs()
      await txn.put<LegacyAlarmMigration>(LEGACY_ALARM_MIGRATION_KEY, {
        ...migration,
        scheduled: false,
        consumed: true,
      })
    })
  }

  /** Recreate lost SDK wake rows from durable domain state; no external I/O. */
  private async rehydrateConversationJobs(): Promise<void> {
    const epoch = await this.epoch()
    if (await this.options.storage.get<boolean>("lifecycleJobsSealed")) return
    const state = await this.options.store.get()
    const phase = state.phase ?? "idle"
    if (!this.capability.has("turn:observe") &&
      (state.budgetReservation?.dispatched || phase === "running" || phase === "settling")) {
      await this.schedule("turn:observe", Date.now(), {
        reservationID: state.budgetReservation?.reservationID,
        reservationDate: state.budgetReservation?.date,
        sessionID: state.sessionID,
        reason: "startup-rehydrate",
      })
    }
    if (!this.capability.has("recovery:wake") && phase === "admitting" && !state.budgetReservation?.dispatched) {
      await this.schedule("recovery:wake", Date.now() + POLL_MS, {
        ...(state.admissionID ? { admissionID: state.admissionID } : {}),
        reason: "stale-admission-recovery",
      })
    }
    if (state.queued && !this.capability.has("admission:retry")) {
      const queueID = state.queued.id ?? crypto.randomUUID()
      if (!state.queued.id) await this.options.store.patch({ queued: { ...state.queued, id: queueID } })
      await this.schedule("admission:retry", state.queued.nextAttemptAt ?? Date.now(), {
        queueID,
        reason: "queued-admission",
      })
    }
    if (state.checkpointPending && !this.capability.has("checkpoint:retry")) {
      const retryAt = state.checkpointRetryAt ?? Date.now() + CHECKPOINT_RETRY_MS
      if (!state.checkpointRetryAt) await this.options.store.patch({ checkpointRetryAt: retryAt })
      await this.schedule("checkpoint:retry", retryAt, { reason: "checkpoint-retry" })
    }
    // Keep the local cache synchronized if a prior instance committed a reset epoch.
    this.jobEpoch = epoch
  }

  private async onMemoryLimit(context: MemoryLimitContext): Promise<void> {
    if (!context.sealed) return
    const message = "lifecycle recovery sealed after repeated alarm memory limits"
    await this.options.storage.transaction(async (txn) => {
      await txn.put("lifecycleJobsSealed", true)
      const state = await txn.get<ConversationState>("state")
      if (state) await txn.put("state", {
        ...state,
        lifecycleJobsSealed: true,
        lifecycleJobError: { kind: "memory-limit", message, at: Date.now() },
      })
    })
  }

  /** Authoritative local evidence for the narrowly scoped sealed-idle retry. */
  async evidence(): Promise<RecoverySchedulerEvidence> {
    const state = await this.options.store.get()
    return {
      sealed: await this.options.storage.get<boolean>("lifecycleJobsSealed") === true,
      epoch: await this.options.storage.get<number>("conversationJobEpoch") ?? await this.epoch(),
      checkpointPending: state.checkpointPending === true,
      ...(state.checkpointRetryAt === undefined ? {} : { checkpointRetryAt: state.checkpointRetryAt }),
      idleIntent: await this.options.storage.get<unknown>("containerIdle"),
      leaseIntent: await this.options.storage.get<unknown>("containerLease"),
      claims: await this.options.storage.get<unknown>("conversationJobClaims"),
      activeJobs: this.activeCount,
      pendingUpgrade: await this.options.storage.get<unknown>("runtimeUpgradePending") !== undefined,
    }
  }

  /** No provider/financial I/O. Roll back both unsealing and jobs on any failure. */
  async resumeSealedIdle(expected: RecoverySchedulerEvidence, expectedState: ConversationState): Promise<void> {
    const nextEpoch = expected.epoch + 1
    if (!Number.isSafeInteger(nextEpoch)) throw new Error("conversation job epoch is exhausted")
    await this.options.storage.transaction(async (txn) => {
      if (await txn.get<number>("conversationJobEpoch") !== expected.epoch) throw new Error("sealed recovery epoch changed")
      const current = await this.evidence()
      const state = await this.options.store.get()
      if (!expected.sealed || JSON.stringify(current) !== JSON.stringify(expected) ||
        JSON.stringify(state) !== JSON.stringify(expectedState)) {
        throw new Error("sealed recovery evidence changed")
      }
      for (const kind of ["turn:observe", "admission:retry", "checkpoint:retry", "recovery:wake", "legacy:bootstrap", "lease:renew", "container:idle"] as const) {
        await this.capability.cancel(kind)
      }
      await txn.put("conversationJobEpoch", nextEpoch)
      await txn.delete("conversationJobClaims")
      await txn.delete("lifecycleJobsSealed")
      await txn.put("state", { ...state, lifecycleJobsSealed: false, lifecycleJobError: undefined })
      await txn.put<LegacyAlarmMigration>(LEGACY_ALARM_MIGRATION_KEY, {
        version: 1, dueAt: null, scheduled: false, consumed: true,
      })
      if (state.checkpointPending) {
        const at = Math.max(Date.now(), state.checkpointRetryAt ?? Date.now())
        await this.capability.schedule("checkpoint:retry", at, { epoch: nextEpoch, dueAt: at, reason: "sealed-idle-recovery" })
      }
      if (isContainerIdleRecord(current.idleIntent)) {
        const at = Math.max(Date.now(), current.idleIntent.dueAt)
        await this.capability.schedule("container:idle", at, {
          epoch: nextEpoch, dueAt: at, idleID: current.idleIntent.id,
          runtimeGeneration: current.idleIntent.generation, reason: "sealed-idle-recovery",
        })
      }
      if (current.leaseIntent !== undefined) {
        const at = Date.now()
        await this.capability.schedule("lease:renew", at, { epoch: nextEpoch, dueAt: at, reason: "sealed-idle-recovery" })
      }
    })
    this.jobEpoch = nextEpoch
  }

  async reset(): Promise<void> {
    const epoch = await this.epoch()
    const nextEpoch = epoch + 1
    await this.options.storage.transaction(async () => {
      await this.options.storage.put("conversationJobEpoch", nextEpoch)
      await this.capability.cancel("turn:observe")
      await this.capability.cancel("admission:retry")
      await this.capability.cancel("checkpoint:retry")
      await this.capability.cancel("recovery:wake")
      await this.capability.cancel("legacy:bootstrap")
      await this.capability.cancel("lease:renew")
      await this.capability.cancel("container:idle")
      await this.options.storage.put<LegacyAlarmMigration>(LEGACY_ALARM_MIGRATION_KEY, {
        version: 1,
        dueAt: null,
        scheduled: false,
        consumed: true,
      })
      const stored = await this.options.storage.list()
      for (const key of stored.keys()) {
        if (key === "conversationJobEpoch") continue
        if (key === "containerIdle" || key === "state" || key === "seq" || key === "events" || key === "controlToken" ||
          key === "snapshot" || key === "containerImageVariant" || key === "runtimeUpgradePending" ||
          key === "runtimeUpgradeCompletion" || key === "conversationJobClaims" || key === "lifecycleJobsSealed" ||
          key.startsWith("tombstones:")) {
          await this.options.storage.delete(key)
        }
      }
    })
    this.jobEpoch = nextEpoch
  }

  private async handoff(
    kind: ConversationJobKind,
    payload: ConversationJobPayload,
    work: () => Promise<DomainOutcome>,
  ): Promise<LifecycleJobOutcome> {
    if (!(await this.isCurrent(payload))) return undefined
    if (this.active.has(kind)) return { rescheduleAt: Date.now() + POLL_MS }
    const now = Date.now()
    const claimID = crypto.randomUUID()
    const claimUntil = now + 120_000
    const epoch = payload.epoch!
    const decision = await this.options.storage.transaction(async (txn) => {
      const currentEpoch = await txn.get<number>("conversationJobEpoch")
      if (currentEpoch !== epoch || await txn.get<boolean>("lifecycleJobsSealed")) return { kind: "stale" as const }
      const claims = await txn.get<Record<string, { epoch: number; claimID: string; until: number }>>("conversationJobClaims") ?? {}
      const current = claims[kind]
      if (current?.epoch === epoch && current.until > now) return { kind: "active" as const, until: current.until }
      claims[kind] = { epoch, claimID, until: claimUntil }
      await txn.put("conversationJobClaims", claims)
      await this.capability.schedule(kind, claimUntil, { ...payload, epoch, claimID, dueAt: claimUntil })
      return { kind: "claimed" as const }
    })
    if (decision.kind === "stale") return undefined
    if (decision.kind === "active") return { rescheduleAt: decision.until }

    this.active.add(kind)
    const task = this.capability.runHostTask(async () => {
      let outcome: DomainOutcome
      let failure: unknown
      try {
        outcome = await work()
      } catch (error) {
        failure = error
      }
      try {
        await this.options.storage.transaction(async (txn) => {
          if (await txn.get<number>("conversationJobEpoch") !== epoch) return
          const claims = await txn.get<Record<string, { epoch: number; claimID: string; until: number }>>("conversationJobClaims") ?? {}
          if (claims[kind]?.claimID !== claimID || claims[kind]?.epoch !== epoch) return
          delete claims[kind]
          await txn.put("conversationJobClaims", claims)
          const state = await txn.get<ConversationState>("state")
          const jobPayload = this.capability.getPayload(kind)
          if (jobPayload?.claimID === claimID) {
            await this.capability.cancel(kind)
            const retryAt = failure ? Date.now() + 30_000 : outcome?.rescheduleAt
            if (retryAt !== undefined) await this.schedule(kind, Math.max(Date.now(), retryAt), payload)
          }
          if (state) {
            const lifecycleJobError = failure
              ? { kind, message: "job failed; owned work remains pending", at: Date.now() }
              : state.lifecycleJobError?.kind === kind ? undefined : state.lifecycleJobError
            await txn.put("state", { ...state, lifecycleJobError })
          }
        })
      } catch (error) {
        console.warn("conversation lifecycle handoff completion failed", { kind, error: displayError(error) })
      } finally {
        this.active.delete(kind)
      }
      if (failure) throw failure
    })
    this.options.waitUntil(task.catch(() => {
      console.warn("conversation lifecycle handoff failed", { kind })
    }))
    this.capability.trackAlarmWork(task)
    return undefined
  }

  private async handleJobError(
    kind: ConversationJobKind,
    payload: ConversationJobPayload,
    _error: unknown,
  ): Promise<LifecycleJobOutcome> {
    if (!(await this.isCurrent(payload))) return undefined
    console.warn("conversation lifecycle job failed", { kind })
    await this.options.store.patch({ lifecycleJobError: { kind, message: "job failed; owned work remains pending", at: Date.now() } })
    // Retain the existing owner and work; SDK retries are disabled so a failed
    // wake is retried only by this bounded domain backoff.
    return { rescheduleAt: Date.now() + 30_000 }
  }
}

function displayError(error: unknown): string {
  if (error instanceof Error) return error.message
  try { return JSON.stringify(error) } catch { return String(error) }
}
