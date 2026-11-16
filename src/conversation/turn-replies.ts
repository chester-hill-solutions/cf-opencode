import type { ConversationStore, QueuedMessage } from "../state"
import { isTerminalTurn, publicTurn, type TurnRecord } from "../turns"
import type { ConversationDeliveryControls } from "./delivery-controls"
import type { QueueAdmissionOutcome } from "./admissions"

/**
 * HTTP answers for turn identity (R1-4a). Every receipt is built here so the
 * message pipeline only decides which answer applies, and status never projects
 * more than the stored turn holds.
 */

/** A key whose turn was pruned: never a 500, never a resurrected turn. */
export function turnExpiredReceipt(): Response {
  return Response.json({ ok: false, error: "turn_expired" }, { status: 410 })
}

/** The same key with different content is a conflict, not a replay. */
export function turnConflictReceipt(turnID: string): Response {
  return Response.json({ ok: false, error: "idempotency_conflict", turnID }, { status: 409 })
}

/** The waiting queue entry behind a key, if it is still queued. */
export interface QueuedEntry {
  id: string
  position: number
  depth: number
}

export function queuedEntry(
  queue: readonly QueuedMessage[],
  matches: (entry: QueuedMessage) => boolean,
): QueuedEntry | undefined {
  const position = queue.findIndex(matches)
  const entry = position < 0 ? undefined : queue[position]
  return entry ? { id: entry.id, position: position + 1, depth: queue.length } : undefined
}

/** The queue receipt fields every replay answer shares. */
export function queuedEntryReceipt(entry: QueuedEntry | undefined): Record<string, unknown> {
  return entry ? { queued: true, delivery: "queue", queue: entry } : {}
}

/** A repeated key answers with the turn it already started. */
export async function turnReplayReceipt(store: ConversationStore, turn: TurnRecord): Promise<Response> {
  const state = await store.get()
  const queue = state.queue ?? []
  const entry = queuedEntry(queue, (candidate) => candidate.id === turn.queueID)
  return Response.json({
    ok: true,
    replayed: true,
    duplicate: true,
    sessionID: turn.sessionID ?? state.sessionID,
    ...queuedEntryReceipt(entry),
    turn: publicTurn(turn, { activeReservationID: state.budgetReservation?.reservationID }),
  })
}

/** Every non-created turn decision, in one place. */
export type RefusedTurn =
  | { kind: "replayed"; turn: TurnRecord }
  | { kind: "conflict"; turnID: string }
  | { kind: "expired" }

export async function refusedTurnReceipt(
  store: ConversationStore,
  result: RefusedTurn,
): Promise<Response> {
  if (result.kind === "conflict") return turnConflictReceipt(result.turnID)
  if (result.kind === "expired") return turnExpiredReceipt()
  return turnReplayReceipt(store, result.turn)
}

/** Nothing was queued: the caller gets the refusal, never a turn id. */
export function queueRefusalReceipt(result: Exclude<QueueAdmissionOutcome, { kind: "enqueued" }>): Response {
  const status = result.kind === "queue_full" ? 429 : result.kind === "admission_in_progress" ? 409 : 503
  return Response.json({ ok: false, error: result.kind, ...result }, { status })
}

/** Accepted and waiting: the turn exists now, but its work has not started. */
export function queueAcceptedReceipt(
  result: Extract<QueueAdmissionOutcome, { kind: "enqueued" }>,
  fallback: TurnRecord,
): Response {
  return Response.json({
    ok: true,
    replayed: false,
    queued: true,
    delivery: "queue",
    queue: {
      id: result.id,
      position: result.position,
      depth: result.depth,
      limit: result.limit,
      ...(result.duplicate ? { duplicate: true } : {}),
    },
    turn: {
      ...publicTurn(result.turn ?? fallback),
      ...(result.duplicate ? {} : { queuePosition: result.position }),
    },
  }, { status: 202 })
}

/** `GET /turns/:id`: identity, lifecycle and accounting state only. */
/** Cancel exactly one turn: clear its own queue entry, or stop its run. */
export async function cancelTurn(
  store: ConversationStore,
  delivery: ConversationDeliveryControls,
  turnID: string,
): Promise<Response> {
  const turn = await store.getTurn(turnID)
  if (!turn) return Response.json({ error: "unknown_turn" }, { status: 404 })
  if (isTerminalTurn(turn.state)) return Response.json({ ok: false, error: "already_terminal" }, { status: 409 })
  if (turn.state === "queued" && turn.queueID) {
    const cleared = await store.removeQueueEntry(turn.queueID)
    await store.transitionTurn(turnID, {
      state: "cancelled",
      finishedAt: Date.now(),
      cancellation: { requested: true, observedStop: cleared, settled: true },
    })
    return cancellationReceipt(cleared, cleared, true)
  }
  const state = await store.get()
  if (state.turnID !== turnID) return Response.json({ ok: false, error: "cannot_target" }, { status: 409 })
  const result = await delivery.stop(undefined, { requireActive: true, preserveQueue: true })
  if (!result.ok) return Response.json({ ok: false, error: result.error ?? "cannot_target" }, { status: result.status })
  const stopped = result.stopRequested === true
  await store.transitionTurn(turnID, {
    cancellation: { requested: true, observedStop: stopped, settled: false },
  })
  return cancellationReceipt(false, stopped, false)
}

function cancellationReceipt(queuedCleared: boolean, observedStop: boolean, settled: boolean): Response {
  return Response.json({
    ok: true,
    cancellation: { requested: true, queuedCleared, observedStop, settled },
  }, { status: 202 })
}

/** `GET /turns/:id/reply`: the assistant text this conversation still retains. */
export async function turnReplyReceipt(store: ConversationStore, turnID: string): Promise<Response> {
  const turn = await store.getTurn(turnID)
  if (!turn) return Response.json({ error: "unknown_turn" }, { status: 404 })
  const reply = (await store.eventsAfter(0))
    .filter((entry) => entry.event.turnID === turnID && entry.event.type === "assistant")
    .map((entry) => (entry.event as { text: string }).text)
    .join("")
  const available = reply.length > 0
  return Response.json({
    available,
    reply,
    replay: available ? "retained" : turn.startedAt ? "expired" : "none",
  })
}

function replyTarget(pathname: string): string | undefined {
  if (!pathname.startsWith("/turns/") || !pathname.endsWith("/reply")) return undefined
  return decodeURIComponent(pathname.slice("/turns/".length, -"/reply".length))
}

/** `POST /turns/:id/cancel`, or undefined for any other request. */
function cancelTarget(request: Request, pathname: string): string | undefined {
  if (request.method !== "POST" || !pathname.startsWith("/turns/") || !pathname.endsWith("/cancel")) {
    return undefined
  }
  return decodeURIComponent(pathname.slice("/turns/".length, -"/cancel".length))
}

/**
 * Passive GETs served by the conversation itself. They answer from stored state
 * or the live runtime and must never start lifecycle recovery or jobs.
 */
export interface TurnControl {
  questions(): Promise<Response>
  answer(requestID: string, body: unknown): Promise<Response>
  cancel(turnID: string): Promise<Response>
}

export async function passiveReadRoute(
  request: Request,
  store: ConversationStore,
  control: TurnControl,
): Promise<Response | undefined> {
  const pathname = new URL(request.url).pathname
  const cancelID = cancelTarget(request, pathname)
  if (cancelID !== undefined) {
    return cancelID ? control.cancel(cancelID) : Response.json({ error: "invalid turn id" }, { status: 400 })
  }
  if (request.method === "POST" && pathname.startsWith("/questions/")) {
    const requestID = decodeURIComponent(pathname.slice("/questions/".length))
    if (!requestID) return Response.json({ error: "invalid question id" }, { status: 400 })
    return control.answer(requestID, await request.json().catch(() => undefined))
  }
  if (request.method !== "GET") return undefined
  const replyID = replyTarget(pathname)
  if (replyID !== undefined) return turnReplyReceipt(store, replyID)
  if (pathname.startsWith("/turns/")) return turnStatusReceipt(store, pathname.slice("/turns/".length))
  if (pathname === "/questions") return control.questions()
  return undefined
}

/** Whether this conversation still holds a replayable frame for the turn. */
async function turnOutput(store: ConversationStore, turn: TurnRecord) {
  const retained = (await store.eventsAfter(0)).some((entry) => entry.event.turnID === turn.id)
  if (retained) return { available: true, replay: "retained" as const }
  return { available: false, replay: turn.startedAt ? "expired" as const : "none" as const }
}

export async function turnStatusReceipt(store: ConversationStore, rawID: string): Promise<Response> {
  let id: string
  try {
    id = decodeURIComponent(rawID)
  } catch {
    return Response.json({ error: "invalid turn id" }, { status: 400 })
  }
  if (!id) return Response.json({ error: "invalid turn id" }, { status: 400 })
  const turn = await store.getTurn(id)
  if (!turn) return Response.json({ error: "unknown_turn" }, { status: 404 })
  const state = await store.get()
  return Response.json({
    turn: {
      ...publicTurn(turn, { activeReservationID: state.budgetReservation?.reservationID }),
      output: await turnOutput(store, turn),
    },
  })
}
