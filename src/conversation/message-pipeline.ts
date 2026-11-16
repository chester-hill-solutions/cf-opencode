import type { BudgetReservationResult } from "./budget-reservations"
import type { ConversationAdmissions } from "./admissions"
import type { ConversationDeliveryControls, DeliveryControlResult } from "./delivery-controls"
import type { ConversationSessions } from "./sessions"
import type { MessageRequest } from "./requests"
import type { ConversationEvent } from "../events"
import type { HarnessSettings } from "../settings"
import { ConversationStore, type BudgetReservation } from "../state"
import { newTurn, publicTurn, turnDigest, type TurnRecord } from "../turns"
import { logEvent } from "../log"
import { WorkspaceRepositoryConflictError } from "../workspace-repository"
import {
  queueAcceptedReceipt,
  queueRefusalReceipt,
  queuedEntry,
  queuedEntryReceipt,
  refusedTurnReceipt,
  turnConflictReceipt,
  turnExpiredReceipt,
  turnReplayReceipt,
} from "./turn-replies"

type MessageDelivery = NonNullable<MessageRequest["delivery"]>

/** One message that passed validation; nothing here re-reads the request body. */
interface TurnMessage {
  input: MessageRequest
  text: string
  prompt: string
  delivery: MessageDelivery
  idempotencyKey?: string
  digest: string
}

interface Session {
  sessionID: string
  baseline?: string
}

type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response }

export interface ConversationMessagePipelineOptions {
  store: ConversationStore
  admissions: ConversationAdmissions
  deliveryControls: ConversationDeliveryControls
  sessions: Pick<ConversationSessions, "ensure" | "baseline">
  recovery: {
    providerRepairPending(): Promise<boolean>
    workspacePending(): Promise<boolean>
    upgradePending(): Promise<boolean>
  }
  budget: {
    acquire(): Promise<BudgetReservationResult>
    dispatch(reservation: BudgetReservation, baseline: string | undefined): Promise<boolean>
  }
  prompt(sessionID: string, text: string): Promise<void>
  deliver(event: ConversationEvent): Promise<void>
  count(name: string): Promise<void>
  settings(): Promise<Pick<HarnessSettings, "streaming">>
  startStream(sessionID: string): void
}

/**
 * The HTTP message pipeline for one conversation: validate, then either steer or
 * interrupt the active turn, or start a turn of its own. Turn identity lives in
 * `./turn-replies`; this class only orders the side effects.
 */
export class ConversationMessagePipeline {
  constructor(private readonly options: ConversationMessagePipelineOptions) {}

  async handle(input: MessageRequest): Promise<Response> {
    if (await this.options.recovery.providerRepairPending()) {
      return Response.json({ error: "provider repair pending", code: "PROVIDER_REPAIR_PENDING" }, { status: 409 })
    }
    const body = messageBody(input)
    if (!body.ok) return body.response
    const blocked = await this.maintenance(body.value.delivery)
    if (blocked) return blocked
    const key = messageKey(input.idempotencyKey)
    if (!key.ok) return key.response
    return this.accept({ input, body: body.value, idempotencyKey: key.value })
  }

  /** Maintenance and upgrade fences outrank every message, but only steer waits on cleanup. */
  private async maintenance(delivery: MessageDelivery): Promise<Response | undefined> {
    if (delivery !== "queue" && await this.options.recovery.workspacePending()) {
      return Response.json({ error: "workspace maintenance pending", code: "WORKSPACE_DISCARD_PENDING" }, { status: 409 })
    }
    if (await this.options.recovery.upgradePending()) {
      return Response.json({ ok: false, error: "runtime upgrade is pending; no message was queued" }, { status: 409 })
    }
    return undefined
  }

  private async accept(request: {
    input: MessageRequest
    body: { text: string; delivery: MessageDelivery }
    idempotencyKey?: string
  }): Promise<Response> {
    const { input, body } = request
    const prompt = input.user ? `${input.user}: ${body.text}` : body.text
    const message: TurnMessage = {
      input, text: body.text, prompt, delivery: body.delivery,
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      digest: await turnDigest({ text: prompt, delivery: body.delivery }),
    }
    if (body.delivery !== "queue") return this.deliveryMessage(message)
    return this.queueMessage(message)
  }

  /**
   * Steer joins the active turn and interrupt's follow-up queues a new one;
   * neither creates a turn here, so the key guard stays the event tombstone.
   */
  private async deliveryMessage(message: TurnMessage): Promise<Response> {
    const key = message.idempotencyKey
    if (key && !(await this.options.store.claimEvent(`msg:${key}`))) return this.duplicateDelivery(key)
    const result = message.delivery === "steer"
      ? await this.options.deliveryControls.steer(message.prompt)
      : await this.options.deliveryControls.stop(message.prompt, {
        requireActive: true, replaceQueue: message.input.replaceQueue, idempotencyKey: key,
      })
    await this.settleKey(result, key)
    const turn = result.ok && message.delivery === "steer" ? await this.activeTurn() : undefined
    return Response.json({ ...result, ...(turn ? { turn: publicTurn(turn) } : {}) }, { status: result.status })
  }

  /** A consumed key only stays consumed once the delivery was accepted. */
  private async settleKey(result: DeliveryControlResult, key?: string): Promise<void> {
    if (!key) return
    if (!result.ok && result.outcome !== "ambiguous") {
      await this.options.store.releaseEvent(`msg:${key}`).catch(() => {})
      return
    }
    await this.options.store.markTombstone(`msg:${key}`).catch(() => {})
  }

  private async duplicateDelivery(key: string): Promise<Response> {
    const state = await this.options.store.get()
    const entry = queuedEntry(state.queue ?? [], (candidate) => candidate.idempotencyKey === key)
    const turn = state.turnID ? await this.options.store.getTurn(state.turnID) : undefined
    return Response.json({
      ok: true,
      duplicate: true,
      sessionID: state.sessionID,
      ...queuedEntryReceipt(entry),
      ...(turn ? { turn: publicTurn(turn) } : {}),
    })
  }

  private async activeTurn(): Promise<TurnRecord | undefined> {
    const state = await this.options.store.get()
    const turnID = state.turnID
    if (!turnID) return undefined
    return this.options.store.getTurn(turnID)
  }

  private async queueMessage(message: TurnMessage): Promise<Response> {
    if (message.input.replaceQueue || !(await this.options.admissions.claim())) return this.queuedReceipt(message)
    const turn = newTurn({ delivery: "queue", digest: message.digest, state: "accepted" })
    const begun = await this.options.store.beginTurn(turn, { key: message.idempotencyKey, active: true })
    if (begun.kind === "replayed") return turnReplayReceipt(this.options.store, begun.turn)
    if (begun.kind === "conflict") return turnConflictReceipt(begun.turnID)
    if (begun.kind === "expired") return turnExpiredReceipt()
    return this.dispatch(message, turn)
  }

  private async queuedReceipt(message: TurnMessage): Promise<Response> {
    const queuedTurn = newTurn({ delivery: "queue", digest: message.digest, state: "queued" })
    const result = await this.options.admissions.enqueue(message.prompt, undefined, {
      replace: message.input.replaceQueue,
      ...(message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : {}),
      turn: queuedTurn,
    })
    if (result.kind === "replayed" || result.kind === "conflict" || result.kind === "expired") {
      return refusedTurnReceipt(this.options.store, result)
    }
    if (result.kind !== "enqueued") return queueRefusalReceipt(result)
    return queueAcceptedReceipt(result, queuedTurn)
  }

  /**
   * The turn exists; from here every failure must abandon it rather than leave a
   * ghost. Nothing is charged until the budget hold is dispatched.
   */
  private async dispatch(message: TurnMessage, turn: TurnRecord): Promise<Response> {
    const session = await this.ensureSession(message, turn)
    if (session instanceof Response) return session
    const reservation = await this.options.budget.acquire()
    if (reservation.kind !== "granted") return this.refuseReservation(reservation, message, turn)
    if (!(await this.options.budget.dispatch(reservation.reservation, session.baseline))) {
      this.options.admissions.finishLocal()
      await this.options.store.advance("idle")
      await this.abandon(message, turn)
      return Response.json(
        { ok: false, error: "could not persist budget dispatch state", reservation: "unavailable" },
        { status: 503 },
      )
    }
    return this.promptTurn(message, turn, session)
  }

  private async ensureSession(message: TurnMessage, turn: TurnRecord): Promise<Session | Response> {
    try {
      const sessionID = await this.options.sessions.ensure(
        message.text,
        message.input.transport ?? "http",
        message.input.slack,
      )
      return { sessionID, baseline: await this.options.sessions.baseline(sessionID) }
    } catch (error) {
      this.options.admissions.finishLocal()
      void this.options.count("admission.failed")
      logEvent("admission.failed", { transport: "http" })
      await this.options.store.patch({ phase: "idle", admissionID: undefined, admissionStartedAt: undefined })
      // The turn never started: release it so the queued retry owns its own turn.
      await this.abandon(message, turn)
      if (error instanceof WorkspaceRepositoryConflictError) {
        return Response.json(
          { ok: false, error: "workspace repository verification failed; no message was queued", code: "WORKSPACE_REPOSITORY_CONFLICT" },
          { status: 409 },
        )
      }
      return this.queuedReceipt(message)
    }
  }

  /** A refused hold leaves no turn behind: the key stays reusable for a retry. */
  private async refuseReservation(
    result: Exclude<BudgetReservationResult, { kind: "granted" }>,
    message: TurnMessage,
    turn: TurnRecord,
  ): Promise<Response> {
    if (result.kind === "already-dispatched") {
      await this.options.admissions.resumeDispatched()
      return Response.json(
        { ok: false, error: result.message, reservation: result.kind },
        { status: 503 },
      )
    }
    this.options.admissions.finishLocal()
    await this.options.store.advance("idle")
    await this.abandon(message, turn)
    if (result.kind === "denied") {
      return Response.json(
        {
          ok: false,
          error: result.message,
          spentUSD: result.spentUSD,
          reservedUSD: result.reservedUSD,
          budgetUSD: result.budgetUSD,
        },
        { status: 429 },
      )
    }
    return Response.json({ ok: false, error: result.message, reservation: result.kind }, { status: 503 })
  }

  /**
   * The durable dispatch marker is written, so any transport error is ambiguous:
   * keep the hold and never turn it into queueable work.
   */
  private async promptTurn(message: TurnMessage, turn: TurnRecord, session: Session): Promise<Response> {
    try {
      await this.options.prompt(session.sessionID, message.prompt)
    } catch (error) {
      return this.unknownDispatch(message, turn, session, error)
    }
    return this.accepted(turn, session.sessionID, session.baseline)
  }

  private async unknownDispatch(message: TurnMessage, turn: TurnRecord, session: Session, error: unknown): Promise<Response> {
    await this.options.admissions.recordAccepted(session.baseline, "ambiguous")
    const unknown = await this.options.store.transitionTurn(turn.id, { state: "unknown", finishedAt: Date.now() })
    await this.options.store.patch({ turnID: undefined }).catch(() => {})
    await this.options.deliver({
      type: "error",
      message: `prompt dispatch outcome is unknown; reservation retained: ${error instanceof Error ? error.message : String(error)}`,
    }).catch(() => {})
    return Response.json(
      {
        ok: false,
        error: "prompt dispatch outcome is unknown; reservation retained",
        ...(unknown ? { turn: publicTurn(unknown) } : {}),
      },
      { status: 502 },
    )
  }

  /** The prompt is accepted; a bookkeeping or stream failure must not re-enqueue it. */
  private async accepted(turn: TurnRecord, sessionID: string, baseline?: string): Promise<Response> {
    await this.options.admissions.recordAccepted(baseline, "acknowledged")
    // Independent reads: the status projection and the streaming preference.
    const [accepted, settings] = await Promise.all([
      this.options.store.getTurn(turn.id),
      this.options.settings().catch(() => undefined),
    ])
    if (settings?.streaming) this.options.startStream(sessionID)
    return Response.json({
      ok: true,
      replayed: false,
      sessionID,
      ...(accepted ? { turn: publicTurn(accepted) } : {}),
    })
  }

  private async abandon(message: TurnMessage, turn: TurnRecord): Promise<void> {
    await this.options.store.abandonTurn(turn.id, message.idempotencyKey).catch(() => {})
  }
}

/** Body shape is not guaranteed by the route; reject anything non-string early. */
function messageBody(input: MessageRequest): Parsed<{ text: string; delivery: MessageDelivery }> {
  const text = typeof input.text === "string" ? input.text.trim() : ""
  if (!text) return { ok: false, response: Response.json({ ok: false, error: "empty message" }, { status: 400 }) }
  const delivery = input.delivery ?? "queue"
  if (!["queue", "steer", "interrupt"].includes(delivery) ||
    (input.replaceQueue !== undefined && typeof input.replaceQueue !== "boolean") ||
    (delivery === "steer" && input.replaceQueue !== undefined)) {
    return { ok: false, response: Response.json({ ok: false, error: "invalid delivery options" }, { status: 400 }) }
  }
  return { ok: true, value: { text, delivery } }
}

function messageKey(value: string | undefined): Parsed<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(value)) {
    return { ok: false, response: Response.json({ ok: false, error: "invalid idempotencyKey" }, { status: 400 }) }
  }
  return { ok: true, value }
}
