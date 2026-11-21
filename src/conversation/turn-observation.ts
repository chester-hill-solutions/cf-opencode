import type { ConversationState, ConversationStore } from "../state"
import { staleAction } from "../lifecycle"
import { logEvent } from "../log"
import type { HarnessSettings } from "../settings"
import type { PersistedTurnTimeout } from "../turn-observation"
import type { ConversationJobPayload } from "./jobs"

/** The phases in which a provider outcome is still expected. */
const OBSERVED_PHASES = new Set(["running", "settling"])

/** One poll of a dispatched turn; `rescheduleAt` means the turn still owes work. */
export type TurnObservationOutcome = { rescheduleAt: number } | undefined

const POLL_MS = 2_000
/** A live stream already delivers text, so its poll is only a fallback. */
const STREAMING_POLL_MS = 30_000

export interface TurnObservationOptions {
  conversationID: string
  storage: DurableObjectStorage
  store: ConversationStore
  scheduler: { isCurrent(payload: ConversationJobPayload): Promise<boolean> }
  runtimeUpgrades: { hasPending(): Promise<boolean> }
  recoveryActive(): boolean
  admissions: {
    active: boolean
    resumeDispatched(scheduleRecovery?: boolean): Promise<void>
  }
  turnExecution: {
    isPumping: boolean
    isStreaming: boolean
    pumpOnce(): Promise<boolean>
    pauseSettlement(message: string): Promise<void>
    finishTimedOutTurn(state: ConversationState, reply: string, failure: { message: string }): Promise<void>
  }
  count(name: string): Promise<void>
  settings(): Promise<HarnessSettings | undefined>
  /** Settles a turn whose runtime lost its session; false when it is another error. */
  settleMissingSession(error: unknown): Promise<boolean>
}

/**
 * Owns one `turn:observe` job: fence the payload, reconcile a stale turn, poll
 * the reply, and decide when to look again.
 *
 * It is separate from the Durable Object because a settled turn must end the
 * loop here: a failure with nothing left to observe never reschedules.
 */
export class ConversationTurnObservation {
  constructor(private readonly options: TurnObservationOptions) {}

  async run(payload: ConversationJobPayload): Promise<TurnObservationOutcome> {
    try {
      return await this.observe(payload)
    } catch (error) {
      if (!await this.options.settleMissingSession(error)) throw error
      return undefined
    }
  }

  private async observe(payload: ConversationJobPayload): Promise<TurnObservationOutcome> {
    if (await this.shouldSkip(payload)) return undefined
    if (this.busy()) return { rescheduleAt: Date.now() + POLL_MS }
    await this.resumeDispatchedPhase()
    const state = await this.options.store.get()
    if (await this.reconcileStale(state)) return undefined
    return this.poll()
  }

  /** A stale payload or a turn that expects no provider outcome owns no observation. */
  private async shouldSkip(payload: ConversationJobPayload): Promise<boolean> {
    if (await this.payloadIsStale(payload)) return true
    const state = await this.options.store.get()
    if (this.payloadFencesAnotherTurn(payload, state)) return true
    return !expectsProviderOutcome(state)
  }

  private async payloadIsStale(payload: ConversationJobPayload): Promise<boolean> {
    if (!(await this.options.scheduler.isCurrent(payload))) return true
    return this.options.runtimeUpgrades.hasPending()
  }

  /** A fenced payload belongs to the dispatch that scheduled it, not to a newer turn. */
  private payloadFencesAnotherTurn(payload: ConversationJobPayload, state: ConversationState): boolean {
    if (!payload.reservationID) return false
    const reservation = state.budgetReservation
    return !reservation?.dispatched || reservation.reservationID !== payload.reservationID ||
      reservation.date !== payload.reservationDate
  }

  private busy(): boolean {
    return this.options.recoveryActive() || this.options.admissions.active || this.options.turnExecution.isPumping
  }

  /** A dispatched turn whose phase drifted must go back to running before polling. */
  private async resumeDispatchedPhase(): Promise<void> {
    const state = await this.options.store.get()
    const phase = state.phase ?? "idle"
    if (state.budgetReservation?.dispatched && phase !== "running" && phase !== "settling") {
      await this.options.admissions.resumeDispatched(false)
    }
  }

  /** Returns true when a stale turn was closed and there is nothing left to poll. */
  private async reconcileStale(state: ConversationState): Promise<boolean> {
    const action = staleAction(state, Date.now(), false)
    if (action === "settlement") return this.closeStaleSettlement(state)
    if (action === "timeout") return this.closeStaleTimeout(state)
    return false
  }

  private async closeStaleSettlement(state: ConversationState): Promise<boolean> {
    logEvent("settlement.stale", {
      ...(state.runStartedAt ? { durationMs: Date.now() - state.runStartedAt } : {}),
    })
    if (state.budgetReservation?.dispatched) {
      await this.options.store.patch({ phase: "running" })
      return false
    }
    await this.options.store.advance("idle")
    return true
  }

  private async closeStaleTimeout(state: ConversationState): Promise<boolean> {
    const reported = await this.options.storage.get<PersistedTurnTimeout>("turnTimeout")
    if (!reported || reported.sessionID !== state.sessionID || reported.runStartedAt !== state.runStartedAt) {
      await this.options.storage.put("turnTimeout", {
        sessionID: state.sessionID,
        runStartedAt: state.runStartedAt,
        observedAt: Date.now(),
      })
      await this.options.count("turn.timedout")
      logEvent("turn.timedout", {
        conversationID: this.options.conversationID,
        sessionID: state.sessionID,
        ...(state.runStartedAt ? { durationMs: Date.now() - state.runStartedAt } : {}),
      })
    }
    if (state.budgetReservation?.dispatched) {
      await this.options.turnExecution.pauseSettlement(
        "turn exceeded its time limit; dispatched reservation retained while context is checked",
      )
      return false
    }
    await this.options.turnExecution.finishTimedOutTurn(state, state.lastReply ?? "", { message: "turn timed out" })
    return true
  }

  private async poll(): Promise<TurnObservationOutcome> {
    const settled = await this.options.turnExecution.pumpOnce()
    return settled ? this.settledOutcome() : this.nextPoll()
  }

  /** A settled turn keeps observing only while it still holds a dispatch. */
  private async settledOutcome(): Promise<TurnObservationOutcome> {
    const after = await this.options.store.get()
    if (after.closedTurn) return undefined
    return after.budgetReservation?.dispatched ? this.nextPoll() : undefined
  }

  private async nextPoll(): Promise<TurnObservationOutcome> {
    const settings = await this.options.settings().catch(() => undefined)
    return {
      rescheduleAt: Date.now() + (this.options.turnExecution.isStreaming
        ? STREAMING_POLL_MS
        : (settings?.pollSeconds ?? 2) * 1000),
    }
  }
}

/** Whether this turn still expects a provider outcome worth polling. */
function expectsProviderOutcome(state: ConversationState): boolean {
  if (state.closedTurn) return false
  return state.budgetReservation?.dispatched === true || OBSERVED_PHASES.has(state.phase ?? "idle")
}
