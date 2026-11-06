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

export interface ConversationState {
  /** Lifecycle phase; absent means "idle" for conversations from older builds. */
  phase?: ConversationPhase
  /** When the current run was admitted, for turn-duration metrics. */
  runStartedAt?: number
  /** Last assistant message id before the current prompt; the turn boundary. */
  turnBaseline?: string
  sessionID?: string
  transport?: Transport
  slack?: SlackTarget
  /** Last assistant text broadcast to SSE, used to avoid duplicates. */
  lastReply?: string
  /** Last assistant text posted to Slack; interim updates stay on SSE only. */
  lastSlackReply?: string
  /** Settings version the running container was configured with. */
  settingsVersion?: number
  /** One pending admission when the container could not start. */
  queued?: { text: string; slack?: SlackTarget; attempts: number }
  /** Fingerprint of the workspace at the last successful checkpoint. */
  checkpointFingerprint?: string
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
  /** Serializes event-log read-modify-write cycles within this Durable Object. */
  private eventTail: Promise<unknown> = Promise.resolve()

  constructor(private readonly storage: KeyValueStorage) {}

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.eventTail.then(task, task)
    this.eventTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async get(): Promise<ConversationState> {
    const state = await this.storage.get<ConversationState>("state")
    return state ?? { seen: [], pending: {} }
  }

  async save(state: ConversationState): Promise<void> {
    await this.storage.put("state", state)
  }

  /** Claim an event for processing; false when it was already claimed. */
  async claimEvent(eventID: string): Promise<boolean> {
    const state = await this.get()
    if (state.seen.includes(eventID)) return false
    state.seen = [...state.seen, eventID].slice(-SEEN_LIMIT)
    await this.save(state)
    return true
  }

  /** Release a claim after a failed admission so a redelivery can be processed. */
  async releaseEvent(eventID: string): Promise<void> {
    const state = await this.get()
    state.seen = state.seen.filter((id) => id !== eventID)
    await this.save(state)
  }

  /** Move the lifecycle forward; an invalid transition is ignored, not thrown. */
  async advance(to: ConversationPhase): Promise<boolean> {
    const state = await this.get()
    const from = state.phase ?? "idle"
    if (from === to) return true
    if (!canTransition(from, to)) return false
    await this.save({ ...state, phase: to })
    return true
  }

  /** Merge fields into the latest state instead of writing a stale snapshot. */
  async patch(patch: Partial<ConversationState>): Promise<ConversationState> {
    const state = await this.get()
    const next = { ...state, ...patch }
    await this.save(next)
    return next
  }

  async setSession(sessionID: string, transport: Transport, slack?: SlackTarget): Promise<void> {
    const state = await this.get()
    state.sessionID = sessionID
    state.transport = transport
    if (slack) state.slack = slack
    await this.save(state)
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
    const state = await this.get()
    for (const requestID of requestIDs) state.pending[requestID] = sessionID
    await this.save(state)
  }

  async peekPermission(requestID: string): Promise<string | undefined> {
    return (await this.get()).pending[requestID]
  }

  /** Remove a permission only after the decision was recorded. */
  async clearPermission(requestID: string): Promise<void> {
    const state = await this.get()
    if (!state.pending[requestID]) return
    delete state.pending[requestID]
    await this.save(state)
  }
}
