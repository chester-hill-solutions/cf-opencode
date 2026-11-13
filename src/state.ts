/**
 * Per-conversation state, stored in the Durable Object's SQLite-backed storage.
 * Transport-neutral: Slack targets and HTTP/SSE consumers share it.
 */

export type Transport = "slack" | "http"

/**
 * Persisted conversation lifecycle. Execution guards (`pumping`, `streaming`)
 * stay in memory; this is the state a restarted DO can reason about.
 */
export type ConversationPhase = "idle" | "admitting" | "running" | "settling" | "queued"

/** Target phase → phases it may be entered from. */
export const ALLOWED_FROM: Record<ConversationPhase, ConversationPhase[]> = {
  idle: ["idle", "admitting", "running", "settling", "queued"],
  admitting: ["idle", "queued"],
  running: ["admitting", "queued", "running"],
  settling: ["running", "admitting"],
  queued: ["idle", "admitting"],
}

export function canTransition(from: ConversationPhase, to: ConversationPhase): boolean {
  return ALLOWED_FROM[to].includes(from)
}

export interface SlackTarget {
  channel: string
  /** Thread root replies are posted under. Absent for DMs. */
  replyTs?: string
}

/** One admission held while the container could not accept it. */
export interface QueuedMessage {
  /** Stable owner fence for its Lifecycle admission/retry intent. */
  id?: string
  text: string
  slack?: SlackTarget
  attempts: number
  /** When the next admission attempt is due. */
  nextAttemptAt?: number
  /** Why the last attempt failed, for operators. */
  lastError?: string
}

/** Durable reference to the one Settings-owned hold for this conversation. */
export interface BudgetReservation {
  reservationID: string
  /** UTC day assigned by Settings when the hold was first granted. */
  date?: string
  /** True once the provider request may have been sent. */
  dispatched: boolean
}

export interface OperatorReconciliationMarker {
  receiptID: string
  reservationID: string
  kind: "observed_actual" | "acknowledged_unknown"
  createdAt: number
  usageDate: string | null
  actualCostUSD: number | null
}

export interface CheckpointPart {
  key: string
  size: number
  encrypted: boolean
}

/** A split checkpoint: workspace and harness state are separate R2 objects. */
export interface CheckpointManifest {
  workspace: CheckpointPart
  state?: CheckpointPart
  /** Workspace fingerprint at archive time. */
  fingerprint?: string
  /** State fingerprint at archive time. */
  stateFingerprint?: string
  createdAt: number
}

export interface ConversationState {
  /** Lifecycle phase; absent means "idle" for conversations from older builds. */
  phase?: ConversationPhase
  /** When the current run was admitted, for turn-duration metrics. */
  runStartedAt?: number
  /** How many times this conversation started a container, for ops visibility. */
  containerStarts?: number
  /** Last assistant message id before the current prompt; the turn boundary. */
  turnBaseline?: string
  sessionID?: string
  /** A model choice local to this conversation, preserved across cold starts. */
  modelOverride?: string
  /** Channel threads accept follow-ups after a mention, until !leave. */
  slackEngaged?: boolean
  /** Questions already announced for the active session. */
  announcedForms?: string[]
  transport?: Transport
  slack?: SlackTarget
  /** Last assistant text broadcast to SSE, used to avoid duplicates. */
  lastReply?: string
  /** Last assistant text posted to Slack; interim updates stay on SSE only. */
  lastSlackReply?: string
  /** Key of the turn failure already reported, for at-most-once delivery. */
  reportedError?: string
  /** Settings version the running container was configured with. */
  settingsVersion?: number
  /** One pending admission when the container could not start. */
  queued?: QueuedMessage
  /** Stable fence for a pre-dispatch admission recovery wake. */
  admissionID?: string
  /** When the current admission claimed the phase, for stale recovery. */
  admissionStartedAt?: number
  /** Owned Settings hold for the current turn, if one has been acquired. */
  budgetReservation?: BudgetReservation
  /** Durable local pointer to the last acknowledged operator reconciliation receipt. */
  operatorReconciliation?: OperatorReconciliationMarker
  /** Fingerprint of the workspace at the last successful checkpoint. */
  checkpointFingerprint?: string
  /** Fingerprint of the state root at the last successful checkpoint. */
  checkpointStateFingerprint?: string
  /** R2 key of the last successful checkpoint, used to prove a 204 is real. */
  checkpointKey?: string
  /** Split checkpoint: both archive keys and their verified sizes. */
  checkpointManifest?: CheckpointManifest
  /** The stored archive is application-encrypted with the tenant key. */
  checkpointEncrypted?: boolean
  /** A checkpoint failed and has not been retried to success. */
  checkpointPending?: boolean
  /** Retry count for a pending checkpoint. */
  checkpointAttempts?: number
  /** Earliest safe retry time for a failed checkpoint. */
  checkpointRetryAt?: number
  /** Last bounded lifecycle callback failure, retained for operator visibility. */
  lifecycleJobError?: { kind: string; message: string; at: number }
  /** Alarm memory-limit seal: resume requires guarded recovery retry or reset. */
  lifecycleJobsSealed?: boolean
  /** Size of the last successful checkpoint, for cost tracking. */
  checkpointSize?: number
  /** The terminal error of the last turn, kept for status output. */
  lastTurnError?: string
  /** Legacy cumulative spend snapshot; durable usage sources supersede it. */
  usage?: { date: string; costUSD: number; input: number; output: number }
  /** Legacy auxiliary accumulator; durable usage sources supersede it. */
  usageAux?: { date: string; costUSD: number; input: number; output: number; seen: string[] }
  /** Highest acknowledged durable session log sequence for this session. */
  usageCursor?: { sessionID: string; seq: number }
  /** Latest acknowledged billable step for terminal settlement proof. */
  usageTerminal?: { sessionID: string; assistantMessageID: string; seq: number }
  /** Latest durable execution fences observed while replaying this session. */
  usageExecution?: { sessionID: string; startedSeq: number; terminalSeq: number; latestStepSeq: number }
  /** Why the last usage refresh failed, for operators. */
  usageError?: string
  /** Why terminal settlement is paused while usage or hold release is unacknowledged. */
  settlementError?: string
  /** Slack event ids already handled (dedupe). */
  seen: string[]
  /** Pending permission requests: requestID -> sessionID. */
  pending: Record<string, string>
}

export interface StoredEventEntry {
  seq: number
  event: import("./events").ConversationEvent
}

export interface KeyValueStorage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
}

const SEEN_LIMIT = 200
const EVENT_LIMIT = 200
/** Dedupe tombstones live this long before an event id may be re-processed. */
const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000

export class ConversationStore {
  /**
   * Serializes every read-modify-write cycle within this Durable Object. A
   * Durable Object is single-threaded but `await` yields, so two requests can
   * interleave between `get` and `put` unless mutations are queued here.
   */
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly storage: KeyValueStorage) {}

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task)
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Read the state, filling fields that older records may not have written.
   * Never hand a caller a state with a missing `seen` or `pending` field.
   */
  private async read(): Promise<ConversationState> {
    const state = await this.storage.get<ConversationState>("state")
    return {
      ...(state ?? {}),
      seen: Array.isArray(state?.seen) ? state.seen : [],
      pending: state?.pending && typeof state.pending === "object" ? state.pending : {},
    }
  }

  /**
   * Apply a mutation to the latest state as one serialized step. `task` gets the
   * current state and returns the state to persist (omit `next` to leave storage
   * untouched) plus the caller's result.
   */
  private transact<T>(
    task: (state: ConversationState) => { next?: ConversationState; result: T },
  ): Promise<T> {
    return this.serial(async () => {
      const state = await this.read()
      const { next, result } = task(state)
      if (next) await this.storage.put("state", next)
      return result
    })
  }

  /** Read the latest state. Reads may interleave; mutations are serialized. */
  async get(): Promise<ConversationState> {
    return this.read()
  }

  /** Claim an event for processing; false when it was already claimed. */
  async claimEvent(eventID: string): Promise<boolean> {
    if (await this.isTombstoned(eventID)) return false
    return this.transact((state) => {
      if (state.seen.includes(eventID)) return { result: false }
      return {
        next: { ...state, seen: [...state.seen, eventID].slice(-SEEN_LIMIT) },
        result: true,
      }
    })
  }

  /** Persist a tombstone so an event id stays blocked beyond the SEEN_LIMIT window. */
  async markTombstone(eventID: string): Promise<void> {
    await this.serial(async () => {
      const now = Date.now()
      const date = new Date(now).toISOString().slice(0, 10)
      const key = `tombstones:${date}`
      const store = (await this.storage.get<Record<string, number>>(key)) ?? {}
      store[eventID] = now
      // Purge tombstones older than the TTL so the map does not grow forever.
      const cutoff = now - TOMBSTONE_TTL_MS
      for (const [id, ts] of Object.entries(store)) {
        if (Number(ts) <= cutoff) delete store[id]
      }
      await this.storage.put(key, store)
    })
  }

  /** Check whether an event id is blocked by a persistent tombstone. */
  private async isTombstoned(eventID: string): Promise<boolean> {
    const now = Date.now()
    const today = new Date(now)
    const dates = [today, new Date(now - 24 * 60 * 60 * 1000)]
    for (const date of dates) {
      const store = await this.storage.get<Record<string, number>>(`tombstones:${date.toISOString().slice(0, 10)}`)
      const ts = store?.[eventID]
      if (typeof ts === "number" && Number.isFinite(ts) && now >= ts && now - ts < TOMBSTONE_TTL_MS) {
        return true
      }
    }
    return false
  }

  /** Release a claim after a failed admission so a redelivery can be processed. */
  async releaseEvent(eventID: string): Promise<void> {
    await this.transact((state) => ({
      next: { ...state, seen: state.seen.filter((id) => id !== eventID) },
      result: undefined,
    }))
  }

  /** Move the lifecycle forward; an invalid transition is ignored, not thrown. */
  async advance(to: ConversationPhase): Promise<boolean> {
    return this.transact((state) => {
      const from = state.phase ?? "idle"
      if (from === to) return { result: true }
      if (!canTransition(from, to)) return { result: false }
      return { next: { ...state, phase: to }, result: true }
    })
  }

  /** Merge fields into the latest state instead of writing a stale snapshot. */
  async patch(patch: Partial<ConversationState>): Promise<ConversationState> {
    return this.transact((state) => {
      const next = { ...state, ...patch }
      return { next, result: next }
    })
  }

  /**
   * Persist a proposal before contacting Settings. Retries reuse the current
   * ID, while a possibly dispatched reservation is never replaced.
   */
  async ensureBudgetReservation(proposedID: string): Promise<BudgetReservation> {
    return this.transact((state) => {
      if (state.budgetReservation) return { result: state.budgetReservation }
      const reservation = { reservationID: proposedID, dispatched: false }
      return { next: { ...state, budgetReservation: reservation }, result: reservation }
    })
  }

  /** Attach Settings' origin day without replacing another or dispatched hold. */
  async setBudgetReservationDate(reservationID: string, date: string): Promise<boolean> {
    return this.transact((state) => {
      const reservation = state.budgetReservation
      if (!reservation || reservation.reservationID !== reservationID || reservation.dispatched !== false) {
        return { result: false }
      }
      if (reservation.date === date) return { result: true }
      return {
        next: { ...state, budgetReservation: { ...reservation, date } },
        result: true,
      }
    })
  }

  /** Mark the matching durable hold as potentially dispatched before sending. */
  async markBudgetReservationDispatched(
    reservationID: string,
    date: string,
    turnBaseline: string | undefined,
    fromQueue = false,
  ): Promise<boolean> {
    return this.transact((state) => {
      const reservation = state.budgetReservation
      if (!reservation || reservation.reservationID !== reservationID || reservation.date !== date) {
        return { result: false }
      }
      if (reservation.dispatched) return { result: false }
      return {
        next: {
          ...state,
          phase: "admitting",
          admissionID: undefined,
          admissionStartedAt: undefined,
          budgetReservation: { ...reservation, dispatched: true },
          runStartedAt: Date.now(),
          turnBaseline,
          ...(fromQueue ? { queued: undefined } : {}),
        },
        result: true,
      }
    })
  }

  /** Clear only the same reference after an acknowledged Settings release. */
  async clearBudgetReservation(reservationID: string, date: string): Promise<boolean> {
    return this.transact((state) => {
      const reservation = state.budgetReservation
      if (!reservation || reservation.reservationID !== reservationID || reservation.date !== date) {
        return { result: false }
      }
      return { next: { ...state, budgetReservation: undefined }, result: true }
    })
  }

  /** Compare-and-clear a dispatched hold only after its central receipt is acknowledged. */
  async clearOperatorReconciledReservation(input: {
    sessionID: string
    reservationID: string
    date: string
    marker: OperatorReconciliationMarker
  }): Promise<boolean> {
    return this.transact((state) => {
      const reservation = state.budgetReservation
      if (state.sessionID !== input.sessionID || state.queued ||
        !reservation || reservation.dispatched !== true ||
        reservation.reservationID !== input.reservationID || reservation.date !== input.date) {
        return { result: false }
      }
      return {
        next: {
          ...state,
          phase: "idle",
          budgetReservation: undefined,
          settlementError: undefined,
          operatorReconciliation: input.marker,
        },
        result: true,
      }
    })
  }

  /** Forget a proposal only after Settings definitively denied creation. */
  async clearDeniedBudgetProposal(reservationID: string): Promise<boolean> {
    return this.transact((state) => {
      const reservation = state.budgetReservation
      if (!reservation || reservation.reservationID !== reservationID || reservation.dispatched !== false) {
        return { result: false }
      }
      return { next: { ...state, budgetReservation: undefined }, result: true }
    })
  }

  /** Clear only the exact captured proposal, and only while dispatch is disproven. */
  async clearUndispatchedBudgetProposal(captured: BudgetReservation): Promise<boolean> {
    return this.transact((state) => {
      const reservation = state.budgetReservation
      if (!reservation || reservation.dispatched !== false || captured.dispatched !== false ||
        reservation.reservationID !== captured.reservationID || reservation.date !== captured.date ||
        state.queued || ((state.phase ?? "idle") !== "idle" && state.phase !== "admitting")) {
        return { result: false }
      }
      return {
        next: {
          ...state,
          budgetReservation: undefined,
          ...(state.phase === "admitting" ? { phase: "idle" as const } : {}),
        },
        result: true,
      }
    })
  }

  /** Increment one numeric counter atomically and return the new value. */
  async increment(field: "containerStarts", by = 1): Promise<number> {
    return this.transact((state) => {
      const value = (state[field] ?? 0) + by
      return { next: { ...state, [field]: value }, result: value }
    })
  }

  /**
   * Claim the single queue slot. Concurrent callers race on this one
   * check-and-set, so exactly one message can be queued and none is dropped by
   * a stale read.
   */
  async enqueue(entry: QueuedMessage): Promise<boolean> {
    return this.transact((state) => {
      if (state.queued) return { result: false }
      const from = state.phase ?? "idle"
      const phase = from === "queued" || canTransition(from, "queued") ? "queued" : state.phase
      return { next: { ...state, queued: entry, phase }, result: true }
    })
  }

  async setSession(sessionID: string, transport: Transport, slack?: SlackTarget): Promise<void> {
    await this.transact((state) => ({
      next: {
        ...state,
        sessionID,
        transport,
        ...(slack ? { slack } : {}),
      },
      result: undefined,
    }))
  }

  /**
   * Assign the next SSE sequence and append the event as one serialized step,
   * so concurrent deliveries cannot duplicate an id or reorder the log.
   */
  async appendEvent(event: import("./events").ConversationEvent): Promise<number> {
    return this.serial(async () => {
      const current = (await this.storage.get<number>("seq")) ?? 0
      const seq = current + 1
      await this.storage.put("seq", seq)
      const log = (await this.storage.get<StoredEventEntry[]>("events")) ?? []
      log.push({ seq, event })
      await this.storage.put("events", log.slice(-EVENT_LIMIT))
      return seq
    })
  }

  async eventsAfter(lastID: number): Promise<StoredEventEntry[]> {
    const log = (await this.storage.get<StoredEventEntry[]>("events")) ?? []
    return log.filter((entry) => entry.seq > lastID)
  }

  async oldestSeq(): Promise<number | undefined> {
    const log = (await this.storage.get<StoredEventEntry[]>("events")) ?? []
    return log[0]?.seq
  }

  async rememberPermission(requestID: string, sessionID: string): Promise<void> {
    await this.rememberPermissions([requestID], sessionID)
  }

  /** Record several pending permissions with one read and one write. */
  async rememberPermissions(requestIDs: string[], sessionID: string): Promise<void> {
    if (requestIDs.length === 0) return
    await this.transact((state) => {
      const pending = { ...state.pending }
      for (const requestID of requestIDs) pending[requestID] = sessionID
      return { next: { ...state, pending }, result: undefined }
    })
  }

  async peekPermission(requestID: string): Promise<string | undefined> {
    return (await this.get()).pending[requestID]
  }

  /** Remove a permission only after the decision was recorded. */
  async clearPermission(requestID: string): Promise<void> {
    await this.transact((state) => {
      if (!state.pending[requestID]) return { result: undefined }
      const pending = { ...state.pending }
      delete pending[requestID]
      return { next: { ...state, pending }, result: undefined }
    })
  }
}
