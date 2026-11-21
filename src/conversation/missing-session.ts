import type { ConversationEvent } from "../events"
import { logEvent } from "../log"
import type { ConversationStore } from "../state"
import { orphanFreeState } from "./recovery-actions"
import { jobFailureReason } from "./scheduler"

/**
 * Bounded outcome of a turn whose session the runtime no longer has. The
 * provider may have billed the dispatch, so the spend is not measured here; an
 * operator retires a retained reservation explicitly.
 */
export const MISSING_SESSION_FAILED = "the runtime no longer knows this session, so the turn cannot be observed"
export const MISSING_SESSION_RETAINED = "runtime no longer knows this session; reservation retained for operator reconciliation"

export interface MissingSessionPorts {
  conversationID: string
  store: ConversationStore
  /** Stop the container; false when the stop was not confirmed. */
  stopRuntime(): Promise<boolean>
  /** Release the lease after a confirmed stop. */
  releaseLease(): Promise<boolean>
  count(name: string): Promise<void>
  event(event: ConversationEvent): Promise<void>
}

/** The runtime answered that the session this turn observes no longer exists. */
export function isSessionMissing(error: unknown): boolean {
  return jobFailureReason(error) === "session_missing"
}

/**
 * Settle a turn whose session the runtime no longer has.
 *
 * Returns false for any other error, so the caller keeps its own handling. The
 * turn is recorded as closed, which is what ends the loop: without it every
 * retry re-prepared a container, failed the same way and renewed the lease.
 */
export async function settleMissingSession(ports: MissingSessionPorts, error: unknown): Promise<boolean> {
  if (!isSessionMissing(error)) return false
  const state = await ports.store.get()
  const reservationRetained = state.budgetReservation?.dispatched === true
  if (state.turnID) {
    await ports.store.transitionTurn(state.turnID, { state: "failed", finishedAt: Date.now() }).catch(() => undefined)
  }
  await ports.store.patch({
    // The turn is over either way. A retained reservation is marked as awaiting
    // an operator so that job rehydration does not re-arm the turn: a phase that
    // still looks running is exactly what made this settlement loop once per wake.
    phase: "idle",
    runStartedAt: undefined,
    settlementError: reservationRetained ? MISSING_SESSION_RETAINED : undefined,
    ...(reservationRetained
      ? { missingSessionSettlement: { at: Date.now(), ...(state.sessionID ? { sessionID: state.sessionID } : {}) } }
      : { missingSessionSettlement: undefined }),
    turnID: undefined,
    lastTurnError: MISSING_SESSION_FAILED,
    reportedError: "session_missing",
    ...orphanFreeState(state),
  })
  const stopped = await ports.stopRuntime().catch(() => false)
  const released = stopped && await ports.releaseLease().catch(() => false)
  await ports.count(released ? "turn.session_missing" : "turn.session_missing.runtime_retained").catch(() => undefined)
  logEvent("session.missing", {
    conversationID: ports.conversationID,
    sessionID: state.sessionID,
    reservationRetained,
    stopped,
    released,
  })
  await ports.event({
    type: "error",
    message: released
      ? "This turn's session no longer exists in the runtime, so it was closed. Send a follow-up to continue in a new session."
      : "This turn's session no longer exists in the runtime, and its container could not be stopped yet.",
  }).catch(() => undefined)
  return true
}
