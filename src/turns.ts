import type { ConversationState } from "./state"

/**
 * Turn records are the caller-facing identity of one accepted request
 * (R1-4a D1). They are bounded and pruned; they carry no prompt text, no
 * credential and no output, so status can be served without reading the
 * workspace.
 */

/** Caller-facing lifecycle of one accepted request (R1-4a D1). */
export type TurnState =
  | "queued"
  | "accepted"
  | "dispatched"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown"

export interface TurnConfiguration {
  settingsVersion?: number
  /** Settings version + image digest + applied flags, captured at dispatch. */
  fingerprint?: string
}

export interface TurnRecord {
  id: string
  state: TurnState
  acceptedAt: number
  startedAt?: number
  finishedAt?: number
  sessionID?: string
  runtimeGeneration?: string
  /** Queue entry that will become this turn, while it waits. */
  queueID?: string
  delivery: "queue" | "steer" | "interrupt"
  /** Content digest binding an idempotency key to one request. */
  digest: string
  configuration?: TurnConfiguration
  /** Settings hold owned while the turn can still be charged. */
  reservationID?: string
  cancellation?: { requested: boolean; observedStop: boolean; settled: boolean }
  recovery?: { available: boolean; fromTurnID?: string; verifiedAt?: number; restored: boolean }
}

/** Idempotency key → turn, bounded by `TURN_KEY_LIMIT` and 24 h. */
export interface TurnKey {
  turnID: string
  digest: string
  at: number
}

export type TurnBeginResult =
  | { kind: "created"; turn: TurnRecord }
  | { kind: "replayed"; turn: TurnRecord }
  | { kind: "conflict"; turnID: string }
  | { kind: "expired" }

/** Newest turns retained regardless of age. */
export const TURN_RETENTION_COUNT = 50
/** A turn younger than this is retained even when older than the count window. */
export const TURN_RETENTION_MS = 72 * 60 * 60 * 1000
/** An idempotency key replays its turn for this long, then starts a new turn. */
export const TURN_KEY_WINDOW_MS = 24 * 60 * 60 * 1000
/** Bounded key map so a burst of distinct keys cannot grow state forever. */
export const TURN_KEY_LIMIT = 200

export const TERMINAL_TURN_STATES: readonly TurnState[] = ["completed", "failed", "cancelled"]

export function isTerminalTurn(state: TurnState): boolean {
  return TERMINAL_TURN_STATES.includes(state)
}

/** Content digest: the same key with different work is a conflict, not a replay. */
export async function turnDigest(input: { text: string; user?: string; delivery: string }): Promise<string> {
  const body = JSON.stringify([input.user ?? null, input.delivery, input.text])
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32)
}

export function newTurn(input: {
  delivery: TurnRecord["delivery"]
  digest: string
  state: TurnState
  acceptedAt?: number
  queueID?: string
  settingsVersion?: number
}): TurnRecord {
  return {
    id: `turn_${crypto.randomUUID()}`,
    state: input.state,
    acceptedAt: input.acceptedAt ?? Date.now(),
    delivery: input.delivery,
    digest: input.digest,
    ...(input.queueID ? { queueID: input.queueID } : {}),
    ...(input.settingsVersion !== undefined
      ? { configuration: { settingsVersion: input.settingsVersion } }
      : {}),
  }
}

/**
 * Keep the newest `TURN_RETENTION_COUNT` turns and everything younger than
 * `TURN_RETENTION_MS` (whichever ends last), plus anything still referenced by
 * the active turn or a queued entry. Pruning a referenced part is the bug class
 * issue #2 reported.
 */
export function retainTurns(
  state: Pick<ConversationState, "turns" | "turnKeys" | "turnID" | "queue">,
  now = Date.now(),
): { turns: TurnRecord[]; turnKeys: Record<string, TurnKey> } {
  const turns = state.turns ?? []
  const referenced = new Set<string>()
  if (state.turnID) referenced.add(state.turnID)
  for (const entry of state.queue ?? []) if (entry.turnID) referenced.add(entry.turnID)
  const newest = new Set(turns.slice(-TURN_RETENTION_COUNT).map((turn) => turn.id))
  const kept = turns.filter((turn) => referenced.has(turn.id) ||
    newest.has(turn.id) ||
    now - turn.acceptedAt < TURN_RETENTION_MS)
  const keys = Object.entries(state.turnKeys ?? {})
    .filter(([, key]) => now - key.at <= TURN_KEY_WINDOW_MS)
    .sort(([, left], [, right]) => left.at - right.at)
    .slice(-TURN_KEY_LIMIT)
  return { turns: kept, turnKeys: Object.fromEntries(keys) }
}

export interface PublicTurn {
  id: string
  state: TurnState
  acceptedAt: string
  startedAt?: string
  finishedAt?: string
  sessionID?: string
  runtimeGeneration?: string
  configuration: { settingsVersion: number | null; fingerprint: string | null }
  accounting: { state: "held" | "settled" | "unknown" }
  cancellation: { requested: boolean; observedStop: boolean; settled: boolean }
  recovery: {
    available: boolean
    fromTurnID: string | null
    verifiedAt?: string
    restored: boolean
  }
}

function iso(value: number | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString()
}

/** Held while the turn's own reservation is still the active one; settled once terminal. */
function turnAccounting(turn: TurnRecord, activeReservationID?: string): PublicTurn["accounting"]["state"] {
  const held = Boolean(turn.reservationID && activeReservationID && turn.reservationID === activeReservationID)
  if (held) return "held"
  return isTerminalTurn(turn.state) ? "settled" : "unknown"
}

function turnTimestamps(turn: TurnRecord): Pick<PublicTurn, "startedAt" | "finishedAt"> {
  return {
    ...(turn.startedAt !== undefined ? { startedAt: iso(turn.startedAt) } : {}),
    ...(turn.finishedAt !== undefined ? { finishedAt: iso(turn.finishedAt) } : {}),
  }
}

function turnIdentity(turn: TurnRecord): Pick<PublicTurn, "sessionID" | "runtimeGeneration"> {
  return {
    ...(turn.sessionID ? { sessionID: turn.sessionID } : {}),
    ...(turn.runtimeGeneration ? { runtimeGeneration: turn.runtimeGeneration } : {}),
  }
}

function turnCancellation(turn: TurnRecord): PublicTurn["cancellation"] {
  return {
    requested: turn.cancellation?.requested === true,
    observedStop: turn.cancellation?.observedStop === true,
    settled: turn.cancellation?.settled === true,
  }
}

function turnRecovery(turn: TurnRecord): PublicTurn["recovery"] {
  return {
    available: turn.recovery?.available === true,
    fromTurnID: turn.recovery?.fromTurnID ?? null,
    ...(turn.recovery?.verifiedAt !== undefined ? { verifiedAt: iso(turn.recovery.verifiedAt) } : {}),
    restored: turn.recovery?.restored === true,
  }
}

/**
 * Caller-facing projection. Never includes the digest, the R2 key, the queue
 * entry id or any internal accounting identifier.
 */
export function publicTurn(
  turn: TurnRecord,
  options: { activeReservationID?: string; now?: number } = {},
): PublicTurn {
  return {
    id: turn.id,
    state: turn.state,
    acceptedAt: new Date(turn.acceptedAt).toISOString(),
    ...turnTimestamps(turn),
    ...turnIdentity(turn),
    configuration: {
      settingsVersion: turn.configuration?.settingsVersion ?? null,
      fingerprint: turn.configuration?.fingerprint ?? null,
    },
    accounting: { state: turnAccounting(turn, options.activeReservationID) },
    cancellation: turnCancellation(turn),
    recovery: turnRecovery(turn),
  }
}

/**
 * Resolve a key that already takes up a waiting queue entry. The entry either
 * names a turn (replay or conflict) or predates turn records (same receipt).
 */
export type WaitingKeyOutcome =
  | { kind: "enqueued"; id: string; position: number; depth: number; limit: number; duplicate: true }
  | { kind: "replayed"; turn: TurnRecord }
  | { kind: "conflict"; turnID: string }

export function waitingKey(
  state: Pick<ConversationState, "queue" | "turns">,
  key: string,
  limit: number,
  digest?: string,
): WaitingKeyOutcome | undefined {
  const queue = state.queue ?? []
  const position = queue.findIndex((queued) => queued.idempotencyKey === key)
  const existing = position < 0 ? undefined : queue[position]
  if (!existing) return undefined
  const turn = existing.turnID
    ? (state.turns ?? []).find((candidate) => candidate.id === existing.turnID)
    : undefined
  if (!turn) {
    return { kind: "enqueued", id: existing.id, position: position + 1, depth: queue.length, limit, duplicate: true }
  }
  // A waiting entry must not mask reused-key content drift.
  if (digest !== undefined && digest !== turn.digest) return { kind: "conflict", turnID: turn.id }
  return { kind: "replayed", turn }
}

/**
 * Decide one `beginTurn` write: an existing key replays or conflicts, otherwise
 * the turn joins the retained set under the same serialized write.
 */
export function admitTurn(
  state: ConversationState,
  turn: TurnRecord,
  options: { key?: string; active?: boolean; now?: number } = {},
): { result: TurnBeginResult; next?: ConversationState } {
  const now = options.now ?? Date.now()
  const retained = retainTurns(state, now)
  const replay = options.key ? replayTurnKey(retained, options.key, turn.digest) : undefined
  if (replay) return { result: replay }
  const swept = retainTurns({
    ...state,
    turns: [...retained.turns, turn],
    turnKeys: withTurnKey(retained.turnKeys, options.key, turn, now),
  }, now)
  return {
    result: { kind: "created", turn },
    next: { ...state, ...swept, ...(options.active ? { turnID: turn.id } : {}) },
  }
}

/** Turn states a conversation may hold before its first dispatch has started. */
const UNSENT_TURN_STATES: readonly TurnState[] = ["accepted", "queued"]

function isUnstartedTurn(turn: TurnRecord): boolean {
  return turn.startedAt === undefined && turn.finishedAt === undefined &&
    turn.sessionID === undefined && turn.reservationID === undefined &&
    turn.cancellation === undefined && turn.recovery === undefined &&
    turn.configuration === undefined && UNSENT_TURN_STATES.includes(turn.state)
}

/**
 * An admitting message records its turn before the container image is chosen,
 * so a conversation is still fresh when that one unstarted turn and its key are
 * all the turn state it holds. Anything else is history.
 */
export function isFreshTurnState(
  state: Pick<ConversationState, "turnID" | "turns" | "turnKeys">,
): boolean {
  const turns = state.turns
  if (turns === undefined) return state.turnID === undefined && state.turnKeys === undefined
  if (!Array.isArray(turns) || turns.length !== 1 || turns[0]?.id !== state.turnID) return false
  const turn = turns[0]
  if (!turn || !isUnstartedTurn(turn)) return false
  return Object.values(state.turnKeys ?? {}).every((key) => key.turnID === turn.id)
}

function replayTurnKey(
  retained: { turns: TurnRecord[]; turnKeys: Record<string, TurnKey> },
  key: string,
  digest: string,
): TurnBeginResult | undefined {
  const existing = retained.turnKeys[key]
  if (!existing) return undefined
  if (existing.digest !== digest) return { kind: "conflict", turnID: existing.turnID }
  const found = retained.turns.find((candidate) => candidate.id === existing.turnID)
  return found ? { kind: "replayed", turn: found } : { kind: "expired" }
}

function withTurnKey(
  turnKeys: Record<string, TurnKey>,
  key: string | undefined,
  turn: TurnRecord,
  now: number,
): Record<string, TurnKey> {
  if (!key) return turnKeys
  return { ...turnKeys, [key]: { turnID: turn.id, digest: turn.digest, at: now } }
}

/** Drop a turn whose work never started, and release its key for a retry. */
export function abandonedTurn(
  state: ConversationState,
  id: string,
  key?: string,
): ConversationState | undefined {
  const turns = state.turns ?? []
  if (!turns.some((turn) => turn.id === id)) return undefined
  const turnKeys = { ...(state.turnKeys ?? {}) }
  if (key && turnKeys[key]?.turnID === id) delete turnKeys[key]
  return {
    ...state,
    turns: turns.filter((turn) => turn.id !== id),
    turnKeys,
    ...(state.turnID === id ? { turnID: undefined } : {}),
  }
}

/** Move one turn forward; a terminal state releases the active pointer. */
export function transitionedTurn(
  state: ConversationState,
  id: string,
  patch: Partial<Omit<TurnRecord, "id" | "acceptedAt" | "digest" | "delivery">>,
): { next: ConversationState; turn: TurnRecord } | undefined {
  const turns = state.turns ?? []
  const index = turns.findIndex((turn) => turn.id === id)
  const current = turns[index]
  if (!current) return undefined
  const turn: TurnRecord = { ...current, ...patch, id: current.id }
  const next = [...turns]
  next[index] = turn
  const released = isTerminalTurn(turn.state) && state.turnID === id
  return { next: { ...state, turns: next, ...(released ? { turnID: undefined } : {}) }, turn }
}

export function turnByID(state: ConversationState, id: string): TurnRecord | undefined {
  return state.turns?.find((turn) => turn.id === id)
}

/**
 * The turn a dispatched reservation starts: the head entry's turn while a
 * queue dispatch is in flight, otherwise the active turn.
 */
export function dispatchedTurn(
  state: Pick<ConversationState, "queue" | "turns" | "turnID" | "sessionID">,
  input: { reservationID: string; dispatchedAt: number; queueID?: string },
): Pick<ConversationState, "turnID" | "turns"> {
  const head = input.queueID !== undefined ? state.queue?.[0] : undefined
  const turnID = head?.turnID ?? state.turnID
  if (!turnID) return {}
  return {
    turnID,
    turns: (state.turns ?? []).map((turn) => turn.id === turnID
      ? {
        ...turn,
        state: "dispatched" as const,
        startedAt: turn.startedAt ?? input.dispatchedAt,
        reservationID: input.reservationID,
        ...(state.sessionID ? { sessionID: state.sessionID } : {}),
      }
      : turn),
  }
}
