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
  text: string
  slack?: SlackTarget
  attempts: number
  /** When the next admission attempt is due. */
  nextAttemptAt?: number
  /** Why the last attempt failed, for operators. */
  lastError?: string
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
  /** Size of the last successful checkpoint, for cost tracking. */
  checkpointSize?: number
  /** The terminal error of the last turn, kept for status output. */
  lastTurnError?: string
  /** Today's spend for this conversation, as reported by OpenCode. */
  usage?: { date: string; costUSD: number; input: number; output: number }
  /** Why the last usage refresh failed, for operators. */
  usageError?: string
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
    return this.transact((state) => {
      if (state.seen.includes(eventID)) return { result: false }
      return {
        next: { ...state, seen: [...state.seen, eventID].slice(-SEEN_LIMIT) },
        result: true,
      }
    })
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
