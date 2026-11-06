/**
 * Turn-lifecycle timing rules, kept pure so they can be tested without a
 * Durable Object. The DO applies the action the rules return.
 */

import type { ConversationState } from "./state"

/** A turn that produced no terminal message and no error is abandoned. */
export const TURN_TIMEOUT_MS = 15 * 60_000
/** A settle left behind by a crash or deploy is reset rather than stranding the DO. */
export const STALE_SETTLE_MS = 10 * 60_000

export type StaleAction = "admission" | "settlement" | "timeout"

/**
 * What an alarm should do about a phase that outlived its work.
 * `pumping` means a poll is running in this instance, so nothing is stale.
 */
export function staleAction(
  state: ConversationState,
  now: number,
  pumping: boolean,
): StaleAction | undefined {
  if (pumping) return undefined
  const phase = state.phase ?? "idle"
  const started = state.runStartedAt

  // The request that was admitting died with the previous DO instance.
  if (phase === "admitting") return "admission"

  // Delivery or checkpointing was interrupted; the turn already has a reply.
  if (phase === "settling" && started && now - started > STALE_SETTLE_MS) return "settlement"

  // The provider never returned and never emitted a terminal error.
  if (phase === "running" && started && now - started > TURN_TIMEOUT_MS) return "timeout"

  return undefined
}
