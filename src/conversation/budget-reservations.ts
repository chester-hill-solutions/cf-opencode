import { ConversationStore, type BudgetReservation } from "../state"

const POLL_MS = 2000

export type BudgetReservationResult =
  | { kind: "granted"; reservation: BudgetReservation }
  | { kind: "denied"; message: string; spentUSD: number; reservedUSD: number; budgetUSD: number }
  | { kind: "conflict"; message: string }
  | { kind: "already-dispatched"; message: string; reservation: BudgetReservation }
  | { kind: "unavailable"; message: string }

export interface BudgetSettingsPort {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>
}

export interface BudgetReservationJobsPort {
  cancelQueuedAdmission(): Promise<void>
  observe(at: number, payload: {
    reservationID: string
    reservationDate: string
    sessionID?: string
    reason: string
  }): Promise<void>
}

export interface ConversationBudgetReservationsOptions {
  conversationID: string
  storage: DurableObjectStorage
  store: ConversationStore
  settings(): BudgetSettingsPort
  jobs: BudgetReservationJobsPort
  beforeDispatch(): Promise<void>
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function finiteBudgetValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Durable Settings reservation and pre-prompt dispatch fences for one conversation. */
export class ConversationBudgetReservations {
  constructor(private readonly options: ConversationBudgetReservationsOptions) {}

  /** Persist a proposed owner before contacting Settings, so ambiguous calls can be retried safely. */
  async acquire(): Promise<BudgetReservationResult> {
    let proposed: BudgetReservation
    try {
      proposed = await this.options.store.ensureBudgetReservation(crypto.randomUUID())
    } catch (error) {
      return { kind: "unavailable", message: errorMessage(error) }
    }
    if (proposed.dispatched) {
      return {
        kind: "already-dispatched",
        message: "this conversation already has a dispatched reservation",
        reservation: proposed,
      }
    }

    let response: Response
    try {
      response = await this.options.settings().fetch("https://settings/usage/reserve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationID: this.options.conversationID,
          reservationID: proposed.reservationID,
          costUSD: 0.1,
        }),
      })
    } catch (error) {
      return { kind: "unavailable", message: errorMessage(error) }
    }

    let result: unknown
    try {
      result = await response.json()
    } catch {
      return { kind: "unavailable", message: "budget authority returned an unreadable response" }
    }
    const body = result && typeof result === "object" ? result as Record<string, unknown> : {}
    if (response.status === 429) {
      const spentUSD = finiteBudgetValue(body.spentUSD)
      const reservedUSD = finiteBudgetValue(body.reservedUSD)
      const budgetUSD = finiteBudgetValue(body.budgetUSD)
      await this.options.store.clearDeniedBudgetProposal(proposed.reservationID).catch(() => false)
      return {
        kind: "denied",
        message: `daily budget reached ($${spentUSD.toFixed(2)} spent + $${reservedUSD.toFixed(2)} reserved of $${budgetUSD.toFixed(2)})`,
        spentUSD,
        reservedUSD,
        budgetUSD,
      }
    }
    if (response.status === 409) {
      if (body.code === "legacy_usage_requires_migration" || body.code === "reservation_retired") {
        await this.options.store.clearDeniedBudgetProposal(proposed.reservationID).catch(() => false)
      }
      return {
        kind: "conflict",
        message: typeof body.error === "string" ? body.error : "budget reservation ownership conflict",
      }
    }
    if (!response.ok) {
      return {
        kind: "unavailable",
        message: typeof body.error === "string" ? body.error : `budget authority returned ${response.status}`,
      }
    }
    if (
      body.ok !== true ||
      body.reservationID !== proposed.reservationID ||
      typeof body.date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(body.date)
    ) {
      return { kind: "unavailable", message: "budget authority returned an invalid reservation reference" }
    }
    const saved = await this.options.store.setBudgetReservationDate(proposed.reservationID, body.date).catch(() => false)
    if (!saved) return { kind: "unavailable", message: "local reservation ownership changed" }
    return {
      kind: "granted",
      reservation: { reservationID: proposed.reservationID, date: body.date, dispatched: false },
    }
  }

  /** Persist dispatch ambiguity and observation before any provider request. */
  async markDispatched(
    reservation: BudgetReservation,
    turnBaseline: string | undefined,
    fromQueue = false,
  ): Promise<boolean> {
    if (!reservation.date) return false
    try {
      await this.options.beforeDispatch()
      return await this.options.storage.transaction(async () => {
        const marked = await this.options.store.markBudgetReservationDispatched(
          reservation.reservationID,
          reservation.date!,
          turnBaseline,
          fromQueue,
        )
        if (!marked) return false
        const state = await this.options.store.get()
        await this.options.jobs.cancelQueuedAdmission()
        await this.options.jobs.observe(Date.now() + POLL_MS, {
          reservationID: reservation.reservationID,
          reservationDate: reservation.date!,
          sessionID: state.sessionID,
          reason: fromQueue ? "queued-prompt-dispatched" : "prompt-dispatched",
        })
        return true
      })
    } catch {
      return false
    }
  }

  /** Release only a matching acknowledged owner; local ownership remains on ambiguity. */
  async release(reservation: BudgetReservation): Promise<boolean> {
    if (!reservation.date) return false
    const current = await this.options.store.get().then((state) => state.budgetReservation).catch(() => undefined)
    if (!current || current.reservationID !== reservation.reservationID || current.date !== reservation.date) return false
    let response: Response
    try {
      response = await this.options.settings().fetch("https://settings/usage/release", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationID: this.options.conversationID,
          reservationID: reservation.reservationID,
          date: reservation.date,
        }),
      })
    } catch {
      return false
    }
    if (!response.ok) return false
    let result: unknown
    try {
      result = await response.json()
    } catch {
      return false
    }
    if (!isRecord(result) || result.ok !== true || typeof result.released !== "boolean" ||
      !isRecord(result.retirement) || result.retirement.conversationID !== this.options.conversationID ||
      result.retirement.reservationID !== reservation.reservationID || result.retirement.reason !== "released" ||
      typeof result.retirement.retiredAt !== "number" || !Number.isFinite(result.retirement.retiredAt) ||
      (result.retirement.date !== undefined && typeof result.retirement.date !== "string") ||
      (reservation.date !== undefined && typeof result.retirement.date === "string" &&
        result.retirement.date !== reservation.date)) {
      return false
    }
    return this.options.store.clearBudgetReservation(reservation.reservationID, reservation.date).catch(() => false)
  }
}
