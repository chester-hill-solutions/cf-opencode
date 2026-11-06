/**
 * Per-conversation state, stored in the Durable Object's SQLite-backed storage.
 * Transport-neutral: Slack targets and HTTP/SSE consumers share it.
 */

export type Transport = "slack" | "http"

export interface SlackTarget {
  channel: string
  /** Thread root replies are posted under. Absent for DMs. */
  replyTs?: string
}

export interface ConversationState {
  sessionID?: string
  transport?: Transport
  slack?: SlackTarget
  /** Last assistant text delivered, used to avoid duplicates. */
  lastReply?: string
  /** Settings version the running container was configured with. */
  settingsVersion?: number
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
  constructor(private readonly storage: KeyValueStorage) {}

  async get(): Promise<ConversationState> {
    const state = await this.storage.get<ConversationState>("state")
    return state ?? { seen: [], pending: {} }
  }

  async save(state: ConversationState): Promise<void> {
    await this.storage.put("state", state)
  }

  /** Record an event id; returns true when it was already seen. */
  async seenBefore(eventID: string): Promise<boolean> {
    const state = await this.get()
    if (state.seen.includes(eventID)) return true
    state.seen = [...state.seen, eventID].slice(-SEEN_LIMIT)
    await this.save(state)
    return false
  }

  async setSession(sessionID: string, transport: Transport, slack?: SlackTarget): Promise<void> {
    const state = await this.get()
    state.sessionID = sessionID
    state.transport = transport
    if (slack) state.slack = slack
    await this.save(state)
  }

  /** Monotonic sequence for SSE ids; survives restarts. */
  async nextSeq(): Promise<number> {
    const current = (await this.storage.get<number>("seq")) ?? 0
    const next = current + 1
    await this.storage.put("seq", next)
    return next
  }

  async appendEvent(entry: StoredEventEntry): Promise<void> {
    const log = (await this.storage.get<StoredEventEntry[]>("events")) ?? []
    log.push(entry)
    await this.storage.put("events", log.slice(-EVENT_LIMIT))
  }

  async eventsAfter(lastID: number): Promise<StoredEventEntry[]> {
    const log = (await this.storage.get<StoredEventEntry[]>("events")) ?? []
    return log.filter((entry) => entry.seq > lastID)
  }

  async rememberPermission(requestID: string, sessionID: string): Promise<void> {
    const state = await this.get()
    state.pending[requestID] = sessionID
    await this.save(state)
  }

  async takePermission(requestID: string): Promise<string | undefined> {
    const state = await this.get()
    const sessionID = state.pending[requestID]
    if (sessionID) {
      delete state.pending[requestID]
      await this.save(state)
    }
    return sessionID
  }
}
