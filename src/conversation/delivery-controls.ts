import type { ConversationEvent } from "../events"
import { ConversationStore, type QueuedMessage, type SlackTarget } from "../state"

export interface DeliveryControlResult {
  ok: boolean
  status: number
  error?: string
  delivery: "steer" | "interrupt"
  outcome?: "acknowledged" | "ambiguous"
  queue?: { id: string; position: number; depth: number }
  stopRequested?: boolean
  consumed?: null
  observedStop?: null
  settled?: boolean
}

export interface ConversationDeliveryControlsOptions {
  storage: DeliveryControlStorage
  store: ConversationStore
  withLock<T>(task: () => Promise<T>): Promise<T>
  unavailable(): Promise<boolean>
  admitting(): boolean
  queueLimit: number
  steer(sessionID: string, text: string): Promise<void>
  interrupt(sessionID: string): Promise<void>
  schedule(): Promise<void>
  event(event: ConversationEvent): Promise<void>
}

/** Minimal storage surface shared by the real DO storage and focused tests. */
export interface DeliveryControlStorage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  transaction<T>(task: () => Promise<T>): Promise<T>
}

/** One interrupt or cancel request; `preserveQueue` is cancel-only. */
export interface InterruptOptions {
  replaceQueue?: boolean
  requireActive?: boolean
  preserveQueue?: boolean
  slack?: SlackTarget
  idempotencyKey?: string
}

interface InterruptIntent {
  sessionID: string
  runStartedAt: number | null
  reservationID: string | null
  status: "requested" | "acknowledged" | "ambiguous"
  requestedAt: number
}

type StopPreparation =
  | { ok: false; result: DeliveryControlResult }
  | { ok: true; queueWrite: QueueWrite }

type QueueWrite =
  | { kind: "queued"; queue: { id: string; position: number; depth: number } }
  | { kind: "full"; depth: number }
  | { kind: "cleared" }
  /** Cancel targets one turn; the waiting queue is none of its business. */
  | { kind: "unchanged" }

const INTERRUPT_INTENT_KEY = "interruptIntent"

/** Transport-neutral steer/stop actions with durable ambiguous-outcome fences. */
export class ConversationDeliveryControls {
  constructor(private readonly options: ConversationDeliveryControlsOptions) {}

  async steer(text: string): Promise<DeliveryControlResult> {
    const guidance = text.trim()
    if (!guidance) return failure("steer", 400, "steer_text_required")
    return this.options.withLock(async () => {
      try {
        if (await this.options.unavailable()) return failure("steer", 503, "conversation_unavailable")
      } catch {
        return failure("steer", 503, "conversation_unavailable")
      }
      if (this.options.admitting()) return failure("steer", 409, "admission_in_progress")
      const state = await this.options.store.get()
      if (state.phase !== "running" || !state.sessionID || state.budgetReservation?.dispatched !== true) {
        return failure("steer", 409, "no_active_turn")
      }
      try {
        await this.options.steer(state.sessionID, guidance)
      } catch {
        return {
          ...failure("steer", 502, "steer outcome is unknown"),
          outcome: "ambiguous",
        }
      }
      await this.options.event({ type: "steered", sessionID: state.sessionID }).catch(() => {})
      return { ok: true, status: 200, delivery: "steer", outcome: "acknowledged", consumed: null }
    })
  }

  async stop(
    followUp?: string,
    options: InterruptOptions = {},
  ): Promise<DeliveryControlResult> {
    const text = followUp?.trim() || undefined
    return this.options.withLock(async () => {
      try {
        if (await this.options.unavailable()) return failure("interrupt", 503, "conversation_unavailable")
      } catch {
        return failure("interrupt", 503, "conversation_unavailable")
      }
      if (this.options.admitting()) return failure("interrupt", 409, "admission_in_progress")

      const before = await this.options.store.get()
      const phase = before.phase ?? "idle"
      if (phase === "admitting") return failure("interrupt", 409, "admission_in_progress")
      const active = (phase === "running" || phase === "settling") && Boolean(before.sessionID)
      if (options.requireActive && !active) return failure("interrupt", 409, "no_active_turn")

      if (!active && phase !== "idle" && phase !== "queued") {
        return failure("interrupt", 409, "no_active_turn")
      }
      if (!active) {
        let queueWrite!: QueueWrite
        try {
          await this.options.storage.transaction(async () => {
            queueWrite = await this.writeQueue(text, options, false)
            if (queueWrite.kind === "queued") await this.options.schedule()
          })
        } catch {
          return failure("interrupt", 503, "conversation_unavailable")
        }
        if (queueWrite.kind === "full") return failure("interrupt", 429, "queue_full")
        if (!text) return { ok: true, status: 200, delivery: "interrupt", stopRequested: false }
        if (queueWrite.kind === "queued") {
          return { ok: true, status: 202, delivery: "interrupt", queue: queueWrite.queue, stopRequested: false }
        }
        return { ok: true, status: 200, delivery: "interrupt", stopRequested: false }
      }

      const sessionID = before.sessionID!
      const runStartedAt = validTime(before.runStartedAt) ? before.runStartedAt : null
      const reservationID = before.budgetReservation?.reservationID ?? null
      const requestedAt = Date.now()
      const preparation = await this.options.storage.transaction(async (): Promise<StopPreparation> => {
        const state = await this.options.store.get()
        if (this.options.admitting() || (state.phase ?? "idle") === "admitting") {
          return { ok: false, result: failure("interrupt", 409, "admission_in_progress") }
        }
        const currentPhase = state.phase ?? "idle"
        if ((currentPhase !== "running" && currentPhase !== "settling") || state.sessionID !== sessionID ||
          (validTime(state.runStartedAt) ? state.runStartedAt : null) !== runStartedAt ||
          (state.budgetReservation?.reservationID ?? null) !== reservationID) {
          return { ok: false, result: failure("interrupt", 409, "active turn changed; retry status") }
        }
        const existing = await this.options.storage.get<InterruptIntent>(INTERRUPT_INTENT_KEY)
        if (sameTurn(existing, sessionID, runStartedAt, reservationID)) {
          return { ok: false, result: failure("interrupt", 409, "interrupt_pending") }
        }
        const queueResult = await this.queueForInterrupt(text, options)
        if (queueResult.kind === "full") {
          return { ok: false, result: failure("interrupt", 429, "queue_full") }
        }
        await this.options.storage.put(INTERRUPT_INTENT_KEY, {
          sessionID, runStartedAt, reservationID, status: "requested", requestedAt,
        } satisfies InterruptIntent)
        return { ok: true, queueWrite: queueResult }
      })
      if (!preparation.ok) return preparation.result
      const { queueWrite } = preparation

      let outcome: "acknowledged" | "ambiguous" = "acknowledged"
      try {
        await this.options.interrupt(sessionID)
      } catch {
        outcome = "ambiguous"
      }
      await this.options.storage.transaction(async () => {
        const current = await this.options.storage.get<InterruptIntent>(INTERRUPT_INTENT_KEY)
        if (current && current.sessionID === sessionID && current.runStartedAt === runStartedAt &&
          current.reservationID === reservationID && current.requestedAt === requestedAt) {
          await this.options.storage.put(INTERRUPT_INTENT_KEY, { ...current, status: outcome })
        }
      }).catch(() => {})
      await this.options.schedule().catch(() => {})
      return {
        ok: outcome === "acknowledged",
        status: outcome === "acknowledged" ? 200 : 502,
        ...(outcome === "ambiguous" ? { error: "interrupt outcome is unknown" } : {}),
        delivery: "interrupt",
        outcome,
        ...(queueWrite.kind === "queued" ? { queue: queueWrite.queue } : {}),
        stopRequested: true,
        observedStop: null,
        settled: false,
      }
    })
  }

  /** An interrupt may queue or replace; a cancel leaves the queue untouched. */
  private async queueForInterrupt(
    text: string | undefined,
    options: { replaceQueue?: boolean; preserveQueue?: boolean; slack?: SlackTarget; idempotencyKey?: string },
  ): Promise<QueueWrite> {
    if (!text && options.preserveQueue) return { kind: "unchanged" }
    return this.writeQueue(text, options, true)
  }

  private async writeQueue(
    text: string | undefined,
    options: { replaceQueue?: boolean; slack?: SlackTarget; idempotencyKey?: string },
    active: boolean,
  ): Promise<QueueWrite> {
    const state = await this.options.store.get()
    if (!text) {
      await this.options.store.clearQueue()
      if (!active && (state.phase ?? "idle") === "queued") await this.options.store.patch({ phase: "idle" })
      return { kind: "cleared" }
    }
    const currentQueue = state.queue ?? []
    const replace = options.replaceQueue === true || options.slack !== undefined
    if (!replace && currentQueue.length >= this.options.queueLimit) return { kind: "full", depth: currentQueue.length }
    const entry: QueuedMessage = {
      id: crypto.randomUUID(),
      enqueuedAt: Date.now(),
      source: options.slack ? "slack" : "http",
      text,
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      ...(options.slack ? { slack: options.slack } : {}),
      attempts: 0,
      nextAttemptAt: Date.now() + 5000,
    }
    const result = await this.options.store.enqueue(entry, this.options.queueLimit, replace)
    if (result.kind !== "enqueued") return { kind: "full", depth: result.depth }
    return { kind: "queued", queue: { id: result.id, position: result.position, depth: result.depth } }
  }
}

function sameTurn(
  intent: InterruptIntent | undefined,
  sessionID: string,
  runStartedAt: number | null,
  reservationID: string | null,
): boolean {
  return intent?.sessionID === sessionID && (intent.runStartedAt ?? null) === runStartedAt &&
    (intent.reservationID ?? null) === reservationID
}

function validTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function failure(
  delivery: DeliveryControlResult["delivery"],
  status: number,
  error: string,
): DeliveryControlResult {
  return { ok: false, status, error, delivery }
}
