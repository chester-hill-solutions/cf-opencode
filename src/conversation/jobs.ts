import {
  LifecycleCapability,
  type MemoryLimitContext,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle"

export type ConversationJobKind = "turn:observe" | "admission:retry" | "checkpoint:retry" | "recovery:wake" | "legacy:bootstrap" | "lease:renew"

export interface ConversationJobPayload {
  epoch?: number
  claimID?: string
  admissionID?: string
  queueID?: string
  reservationID?: string
  reservationDate?: string
  sessionID?: string
  runtimeGeneration?: string
  /** Due-time fence; stale jobs must not run work before the domain deadline. */
  dueAt?: number
  /** Optional reason for telemetry and narrowly scoped recovery. */
  reason?: string
}

export interface ConversationJobHandlers {
  onStart(): Promise<void>
  turnObserve(payload: ConversationJobPayload): Promise<LifecycleJobOutcome>
  admissionRetry(payload: ConversationJobPayload): Promise<LifecycleJobOutcome>
  checkpointRetry(payload: ConversationJobPayload): Promise<LifecycleJobOutcome>
  recoveryWake(payload: ConversationJobPayload): Promise<LifecycleJobOutcome>
  legacyBootstrap(payload: ConversationJobPayload): Promise<LifecycleJobOutcome>
  leaseRenew(payload: ConversationJobPayload): Promise<LifecycleJobOutcome>
  onJobError(kind: ConversationJobKind, payload: ConversationJobPayload, error: unknown): Promise<LifecycleJobOutcome>
  onMemoryLimit(context: MemoryLimitContext): Promise<void>
}

const JOBS: Record<ConversationJobKind, { id: string; fn: string }> = {
  "turn:observe": { id: "turn:observe", fn: "turnObserve" },
  "admission:retry": { id: "admission:retry", fn: "admissionRetry" },
  "checkpoint:retry": { id: "checkpoint:retry", fn: "checkpointRetry" },
  "recovery:wake": { id: "recovery:wake", fn: "recoveryWake" },
  "legacy:bootstrap": { id: "legacy:bootstrap", fn: "legacyBootstrap" },
  "lease:renew": { id: "lease:renew", fn: "leaseRenew" },
}

const KIND_BY_FUNCTION = new Map(Object.entries(JOBS).map(([kind, value]) => [value.fn, kind as ConversationJobKind]))

/** Lifecycle's durable SQLite queue carries wake/deadline intents, never prompts. */
export class ConversationJobs extends LifecycleCapability {
  constructor(private readonly handlers: ConversationJobHandlers) {
    super("conversation-jobs")
  }

  async onStart(): Promise<void> {
    // Initializes the SDK-owned SQLite queue schema before any transactional push.
    this.lifecycle.jobs.list()
    await this.lifecycle.runInHostContext(() => this.handlers.onStart())
  }

  async schedule(kind: ConversationJobKind, time: number, payload: ConversationJobPayload = {}): Promise<void> {
    const job = JOBS[kind]
    if (!Number.isSafeInteger(time) || time < 0) throw new Error("conversation job time must be an epoch millisecond")
    // Ensure the SDK-owned queue schema exists before publishing an explicit
    // durable intent, including from a transactional legacy bootstrap.
    this.lifecycle.jobs.list()
    const prior = this.lifecycle.jobs.get(job.id)
    const sameOwner = prior?.fn === job.fn && sameJobOwner(parsePayload(prior.payload), payload)
    // A handler may publish its next deadline while its due row is executing.
    // Never let that already-due row replace the new backoff (which would
    // create a tight retry loop); only preserve a still-future external wake.
    const effectiveTime = sameOwner && prior!.time > Date.now() ? Math.min(prior!.time, time) : time
    await this.lifecycle.jobs.push({
      id: job.id,
      fn: job.fn,
      // A wake from one source must not delay an already-needed earlier wake.
      time: effectiveTime,
      payload: { ...payload, dueAt: effectiveTime },
      singleflight: true,
      recoveryLoop: true,
      retry: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 1000 },
    })
  }

  async cancel(kind: ConversationJobKind): Promise<void> {
    await this.lifecycle.jobs.cancel(JOBS[kind].id)
  }

  getPayload(kind: ConversationJobKind): ConversationJobPayload | undefined {
    const job = this.lifecycle.jobs.get(JOBS[kind].id)
    return job ? parsePayload(job.payload) : undefined
  }

  has(kind: ConversationJobKind): boolean {
    return this.lifecycle.jobs.get(JOBS[kind].id) !== undefined
  }

  async runHostTask<T>(task: () => Promise<T>): Promise<T> {
    return await this.lifecycle.runInHostContext(task) as T
  }

  trackAlarmWork(work: Promise<unknown>): void {
    this.lifecycle.trackAlarmWork(work)
  }

  async onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    const kind = KIND_BY_FUNCTION.get(context.job.fn)
    if (!kind) return undefined
    const payload = parsePayload(context.job.payload)
    return await this.lifecycle.runInHostContext(() => {
      switch (kind) {
        case "turn:observe": return this.handlers.turnObserve(payload)
        case "admission:retry": return this.handlers.admissionRetry(payload)
        case "checkpoint:retry": return this.handlers.checkpointRetry(payload)
        case "recovery:wake": return this.handlers.recoveryWake(payload)
        case "legacy:bootstrap": return this.handlers.legacyBootstrap(payload)
        case "lease:renew": return this.handlers.leaseRenew(payload)
      }
    }) as LifecycleJobOutcome
  }

  async onJobError(context: LifecycleJobContext, error: unknown): Promise<LifecycleJobOutcome> {
    const kind = KIND_BY_FUNCTION.get(context.job.fn)
    if (!kind) return undefined
    const payload = parsePayload(context.job.payload)
    return await this.lifecycle.runInHostContext(() => this.handlers.onJobError(kind, payload, error)) as LifecycleJobOutcome
  }

  async onMemoryLimit(context: MemoryLimitContext): Promise<void> {
    await this.lifecycle.runInHostContext(() => this.handlers.onMemoryLimit(context))
  }
}

function parsePayload(value: unknown): ConversationJobPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const raw = value as Record<string, unknown>
  return {
    ...(typeof raw.epoch === "number" && Number.isSafeInteger(raw.epoch) && raw.epoch >= 0 ? { epoch: raw.epoch } : {}),
    ...(typeof raw.claimID === "string" ? { claimID: raw.claimID } : {}),
    ...(typeof raw.admissionID === "string" ? { admissionID: raw.admissionID } : {}),
    ...(typeof raw.queueID === "string" ? { queueID: raw.queueID } : {}),
    ...(typeof raw.reservationID === "string" ? { reservationID: raw.reservationID } : {}),
    ...(typeof raw.reservationDate === "string" ? { reservationDate: raw.reservationDate } : {}),
    ...(typeof raw.sessionID === "string" ? { sessionID: raw.sessionID } : {}),
    ...(typeof raw.runtimeGeneration === "string" ? { runtimeGeneration: raw.runtimeGeneration } : {}),
    ...(typeof raw.dueAt === "number" && Number.isSafeInteger(raw.dueAt) && raw.dueAt >= 0 ? { dueAt: raw.dueAt } : {}),
    ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
  }
}

function sameJobOwner(left: ConversationJobPayload, right: ConversationJobPayload): boolean {
  return left.epoch === right.epoch && left.claimID === right.claimID && left.admissionID === right.admissionID &&
    left.queueID === right.queueID && left.reservationID === right.reservationID &&
    left.reservationDate === right.reservationDate && left.sessionID === right.sessionID &&
    left.runtimeGeneration === right.runtimeGeneration
}
