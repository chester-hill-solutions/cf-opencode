import { makeClient, portFetch } from "../opencode"
import type { ConversationState } from "../state"
import { ConversationStore } from "../state"
import type { RuntimeQuiescenceResult } from "../runtime-quiescence"
import type { ConversationUsage } from "./usage"
import type { ConversationCheckpoints } from "./checkpoints"
import type { ConversationImages } from "./images"
import type { ConversationLease } from "./lease"
import type { ConversationRuntime } from "./runtime"
import type { ConversationRuntimeAccess } from "./runtime-access"
import { isContainerIdleRecord, type ContainerIdleRecord } from "./idle-state"
export { isContainerIdleRecord, type ContainerIdleRecord } from "./idle-state"

const IDLE_CLOSE_MS = 30_000
const IDLE_RETRY_MS = 30_000
const CONTROL_PORT = 4001
const IDLE_KEY = "containerIdle"
const IDLE_CLOSE_PENDING_MESSAGE = "container idle close is pending; wait for stop recovery"

export interface IdleCloseJobPayload {
  idleID?: string
  runtimeGeneration?: string
}

export class IdleClosePendingError extends Error {
  constructor() {
    super(IDLE_CLOSE_PENDING_MESSAGE)
    this.name = "IdleClosePendingError"
  }
}

type IdleCloseOutcome = { rescheduleAt: number } | undefined
type OpenCodeClient = ReturnType<typeof makeClient>

export interface ConversationIdleCloseOptions {
  storage: DurableObjectStorage
  store: ConversationStore
  id: string
  runtime: Pick<ConversationRuntime, "apiPort" | "generation" | "port" | "stop" | "confirmedStopped"> & {
    nativeRunning(): boolean
  }
  access: Pick<ConversationRuntimeAccess, "exclusive" | "activityEpoch">
  usage: Pick<ConversationUsage, "serialize" | "replayLogLocked" | "ledger">
  checkpoints: Pick<ConversationCheckpoints, "captureOwned" | "verifySplitArchive">
  images: Pick<ConversationImages, "clearSnapshot">
  leases: Pick<ConversationLease, "releaseAfterStop">
  eligibleNative(): boolean
  locallyBusy(): Promise<boolean>
  withAdmissionLock<T>(task: () => Promise<T>): Promise<T>
  stopStream(): Promise<boolean>
  prove(client: OpenCodeClient, sessionID: string): Promise<RuntimeQuiescenceResult>
  jobs: {
    schedule(at: number, payload: IdleCloseJobPayload): Promise<void>
    cancel(): Promise<void>
  }
}

/**
 * Closes only a quiescent native runtime after encrypted split archives are
 * verified. The persisted closing phase fences new preparation until stop and
 * lease release are both confirmed.
 */
export class ConversationIdleClose {
  constructor(private readonly options: ConversationIdleCloseOptions) {}

  /** Called after a completed runtime use; never replaces an in-progress close. */
  async touch(): Promise<boolean> {
    if (!this.options.eligibleNative() || !this.options.runtime.nativeRunning()) return false
    const generation = this.options.runtime.generation
    if (!generation) return false
    const now = Date.now()
    const record: ContainerIdleRecord = {
      version: 1,
      id: crypto.randomUUID(),
      generation,
      dueAt: now + IDLE_CLOSE_MS,
      phase: "waiting",
    }
    return this.options.storage.transaction(async (txn) => {
      const prior = await txn.get<unknown>(IDLE_KEY)
      if (prior !== undefined && !isContainerIdleRecord(prior)) {
        throw new Error("container idle intent is unreadable")
      }
      if (prior?.phase === "closing") return false
      await txn.put(IDLE_KEY, record)
      await this.options.jobs.schedule(record.dueAt, {
        idleID: record.id,
        runtimeGeneration: record.generation,
      })
      return true
    })
  }

  /** Prevent an uncertain stop from being reopened by normal runtime preparation. */
  async beforePrepareOwned(): Promise<void> {
    const record = await this.readIntent()
    if (record?.phase === "closing") {
      throw new IdleClosePendingError()
    }
  }

  run(payload: IdleCloseJobPayload): Promise<IdleCloseOutcome> {
    return this.options.withAdmissionLock(() => this.runLocked(payload))
  }

  private async runLocked(payload: IdleCloseJobPayload): Promise<IdleCloseOutcome> {
    const record = await this.readIntent()
    if (!record || !payload.idleID || !payload.runtimeGeneration ||
      payload.idleID !== record.id || payload.runtimeGeneration !== record.generation) return undefined
    if (record.phase === "waiting" && Date.now() < record.dueAt) return { rescheduleAt: record.dueAt }
    if (!this.options.eligibleNative()) return { rescheduleAt: Date.now() + IDLE_RETRY_MS }

    if (record.phase === "closing") {
      return this.options.usage.serialize(() =>
        this.options.access.exclusive(() => this.finishClose(record)),
      )
    }

    if (!this.options.runtime.nativeRunning()) return this.releaseAlreadyStopped(record)

    const blocked = await this.blockedBeforeClose()
    if (blocked) return { rescheduleAt: Date.now() + IDLE_RETRY_MS }

    // Stop our own SSE reader before taking usage serialization; session.wait
    // below proves the native execution itself has finished.
    const activityAtRequest = this.options.access.activityEpoch
    if (!(await this.options.stopStream())) return { rescheduleAt: Date.now() + IDLE_RETRY_MS }
    const owned = await this.options.usage.serialize(async () =>
      this.options.access.exclusive(async () => this.verifyAndClose(record, activityAtRequest)),
    )
    return owned
  }

  /** Reconcile capacity when the platform already stopped the native binding. */
  private async releaseAlreadyStopped(record: ContainerIdleRecord): Promise<IdleCloseOutcome> {
    if (!this.options.runtime.confirmedStopped || await this.options.locallyBusy()) {
      return { rescheduleAt: Date.now() + IDLE_RETRY_MS }
    }
    const activityAtRequest = this.options.access.activityEpoch
    if (!(await this.options.stopStream())) return { rescheduleAt: Date.now() + IDLE_RETRY_MS }
    return this.options.usage.serialize(() => this.options.access.exclusive(async () => {
      if (!this.options.runtime.confirmedStopped || this.options.access.activityEpoch !== activityAtRequest ||
        await this.options.locallyBusy()) return { rescheduleAt: Date.now() + IDLE_RETRY_MS }
      if (!await this.ownsWaitingRecord(record)) return undefined
      // No new destruction occurs here: the binding is already confirmed
      // stopped, so archive availability and financial holds do not gate
      // releasing only the container-capacity lease.
      if (!(await this.options.runtime.stop())) return { rescheduleAt: Date.now() + IDLE_RETRY_MS }
      if (!(await this.options.leases.releaseAfterStop())) return { rescheduleAt: Date.now() + IDLE_RETRY_MS }
      const cleared = await this.clearWaitingRecord(record, activityAtRequest)
      return cleared ? undefined : { rescheduleAt: Date.now() + IDLE_RETRY_MS }
    }))
  }

  private async ownsWaitingRecord(record: ContainerIdleRecord): Promise<boolean> {
    const current = await this.readIntent()
    return Boolean(current && current.phase === "waiting" && current.id === record.id &&
      current.generation === record.generation && current.dueAt === record.dueAt)
  }

  private async clearWaitingRecord(record: ContainerIdleRecord, activityEpoch: number): Promise<boolean> {
    return this.options.storage.transaction(async (txn) => {
      const current = await txn.get<unknown>(IDLE_KEY)
      if (!isContainerIdleRecord(current) || current.phase !== "waiting" || current.id !== record.id ||
        current.generation !== record.generation || current.dueAt !== record.dueAt ||
        this.options.access.activityEpoch !== activityEpoch) return false
      await this.options.jobs.cancel()
      await txn.delete(IDLE_KEY)
      return true
    })
  }

  private async blockedBeforeClose(): Promise<boolean> {
    if (await this.options.locallyBusy()) return true
    const state = await this.options.store.get()
    return !this.eligibleState(state) || await this.options.storage.get<boolean>("lifecycleJobsSealed") === true
  }

  private eligibleState(state: ConversationState): boolean {
    return (state.phase ?? "idle") === "idle" && !state.queued && !state.budgetReservation &&
      !state.checkpointPending && Object.keys(state.pending ?? {}).length === 0 && Boolean(state.sessionID)
  }

  private async verifyAndClose(record: ContainerIdleRecord, activityAtRequest: number): Promise<IdleCloseOutcome> {
    if (this.options.access.activityEpoch !== activityAtRequest) {
      return { rescheduleAt: Date.now() + IDLE_RETRY_MS }
    }
    if (await this.blockedBeforeClose() || !this.options.runtime.nativeRunning()) {
      return { rescheduleAt: Date.now() + IDLE_RETRY_MS }
    }
    const port = this.options.runtime.apiPort ?? await this.options.runtime.port(4000)
    const client = makeClient(portFetch(port))
    const initialState = await this.options.store.get()
    const sessionID = initialState.sessionID
    if (!sessionID) return { rescheduleAt: Date.now() + IDLE_RETRY_MS }

    try {
      await this.options.usage.replayLogLocked(sessionID, undefined, client)
      const ledger = await this.options.usage.ledger()
      if (ledger.conversationID !== this.options.id || ledger.holds.length || ledger.blockers.length || ledger.legacyRows.length) {
        return { rescheduleAt: Date.now() + IDLE_RETRY_MS }
      }
      const proof = await this.options.prove(client, sessionID)
      if (proof.proof.sessionID !== sessionID || proof.proof.runtimeGeneration !== record.generation ||
        this.options.runtime.generation !== record.generation) {
        return { rescheduleAt: Date.now() + IDLE_RETRY_MS }
      }
      if (!(await this.options.checkpoints.captureOwned())) return { rescheduleAt: Date.now() + IDLE_RETRY_MS }
      const checkpointState = await this.options.store.get()
      const manifest = checkpointState.checkpointManifest
      if (!manifest) return { rescheduleAt: Date.now() + IDLE_RETRY_MS }
      await this.options.checkpoints.verifySplitArchive(manifest, true)

      if (this.options.access.activityEpoch !== activityAtRequest || await this.blockedBeforeClose()) {
        return { rescheduleAt: Date.now() + IDLE_RETRY_MS }
      }
      const closeClaim = await this.markClosing(record, sessionID, activityAtRequest)
      if (closeClaim === "stale") return undefined
      if (closeClaim === "deferred") return { rescheduleAt: Date.now() + IDLE_RETRY_MS }
      return this.finishClose({ ...record, phase: "closing" })
    } catch {
      return { rescheduleAt: Date.now() + IDLE_RETRY_MS }
    }
  }

  private async markClosing(
    expected: ContainerIdleRecord,
    sessionID: string,
    activityAtStart: number,
  ): Promise<"marked" | "deferred" | "stale"> {
    return this.options.storage.transaction(async (txn) => {
      const current = await txn.get<unknown>(IDLE_KEY)
      const state = await txn.get<ConversationState>("state")
      if (!isContainerIdleRecord(current) || current.phase !== "waiting" ||
        current.id !== expected.id || current.generation !== expected.generation || current.dueAt !== expected.dueAt ||
        !state || state.sessionID !== sessionID) return "stale"
      if (!this.eligibleState(state) || this.options.access.activityEpoch !== activityAtStart ||
        await txn.get<boolean>("lifecycleJobsSealed") === true) return "deferred"
      await txn.put(IDLE_KEY, { ...current, phase: "closing" } satisfies ContainerIdleRecord)
      return "marked"
    })
  }

  private async finishClose(record: ContainerIdleRecord): Promise<IdleCloseOutcome> {
    if (await this.options.locallyBusy() || !this.eligibleState(await this.options.store.get())) {
      return { rescheduleAt: Date.now() + IDLE_RETRY_MS }
    }
    const isRunning = this.options.runtime.nativeRunning()
    if (isRunning) {
      const generation = await this.currentGeneration(record, true)
      if (generation !== record.generation) return { rescheduleAt: Date.now() + IDLE_RETRY_MS }
    }
    // Reaching `closing` proves both encrypted archive parts were validated.
    await this.options.images.clearSnapshot()
    if (isRunning) {
      if (!(await this.options.runtime.stop())) return { rescheduleAt: Date.now() + IDLE_RETRY_MS }
    }
    if (!this.options.runtime.confirmedStopped) return { rescheduleAt: Date.now() + IDLE_RETRY_MS }
    if (!(await this.options.leases.releaseAfterStop())) return { rescheduleAt: Date.now() + IDLE_RETRY_MS }
    const cleared = await this.options.storage.transaction(async (txn) => {
      const current = await txn.get<unknown>(IDLE_KEY)
      if (!isContainerIdleRecord(current) || current.id !== record.id || current.phase !== "closing") return false
      await this.options.jobs.cancel()
      await txn.delete(IDLE_KEY)
      return true
    })
    return cleared ? undefined : { rescheduleAt: Date.now() + IDLE_RETRY_MS }
  }

  private async currentGeneration(record: ContainerIdleRecord, closing: boolean): Promise<string | undefined> {
    const cached = this.options.runtime.generation
    if (cached) return cached === record.generation ? cached : undefined
    if (!closing || !this.options.runtime.nativeRunning()) return undefined
    const control = await this.options.runtime.port(CONTROL_PORT)
    const response = await control.fetch("http://container/start", {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return undefined
    const proof: unknown = await response.json()
    if (!proof || typeof proof !== "object" || Array.isArray(proof)) return undefined
    const value = proof as Record<string, unknown>
    return value.ok === true && typeof value.opencodeGeneration === "string" &&
      value.opencodeGeneration === record.generation ? value.opencodeGeneration : undefined
  }

  private async readIntent(): Promise<ContainerIdleRecord | undefined> {
    const value = await this.options.storage.get<unknown>(IDLE_KEY)
    if (value === undefined) return undefined
    if (!isContainerIdleRecord(value)) throw new Error("container idle intent is unreadable")
    return value
  }
}
