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
 * Returns false for any other error, so the caller keeps its own handling. A
 * settled turn leaves nothing to observe, which is what stops the observation
 * loop: without this, every retry re-prepares a container, fails the same way
 * and renews the lease forever.
 */
export async function settleMissingSession(ports: MissingSessionPorts, error: unknown): Promise<boolean> {
  if (!isSessionMissing(error)) return false
  const state = await ports.store.get()
  const reservationRetained = state.budgetReservation?.dispatched === true
  if (state.turnID) {
    await ports.store.transitionTurn(state.turnID, { state: "failed", finishedAt: Date.now() }).catch(() => undefined)
  }
  await ports.store.patch({
    // A retained reservation needs an operator, so the phase stays out of idle
    // and idle-close does not delete the runtime that operator may resume.
    ...(reservationRetained
      ? { phase: "running" as const, settlementError: MISSING_SESSION_RETAINED }
      : { phase: "idle" as const, settlementError: undefined, runStartedAt: undefined }),
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
