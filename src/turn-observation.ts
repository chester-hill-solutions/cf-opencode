import type { ConversationState } from "./state"
import { TURN_TIMEOUT_MS } from "./lifecycle"

export interface PersistedTurnTimeout {
  sessionID?: string
  runStartedAt?: number
  observedAt?: number
}

export interface TurnObservation {
  policy: "observe_and_alert"
  thresholdMs: number
  executionDeadlineEnforced: false
  runStartedAt: number | null
  elapsedMs: number | null
  overdue: boolean
  timeoutObserved: boolean
  timeoutObservedAt: number | null
  settlement: "active" | "paused" | "settled" | "unknown"
}

/**
 * Project persisted turn evidence for status surfaces. This is observational:
 * crossing the threshold never implies that provider execution was stopped.
 */
export function projectTurnObservation(
  state: ConversationState,
  now: number,
  timeout?: PersistedTurnTimeout | null,
): TurnObservation {
  const runStartedAt = validTime(state.runStartedAt) ? state.runStartedAt : null
  const elapsedMs = runStartedAt === null ? null : Math.max(0, now - runStartedAt)
  const phase = state.phase ?? "idle"
  const isTimedTurn = runStartedAt !== null && typeof state.sessionID === "string" &&
    state.sessionID.length > 0 && timeout?.sessionID === state.sessionID &&
    timeout.runStartedAt === runStartedAt
  const timeoutObserved = Boolean(isTimedTurn)
  const active = phase === "running" || phase === "settling"
  const hasHold = Boolean(state.budgetReservation)

  let settlement: TurnObservation["settlement"] = "unknown"
  if (phase === "idle" && !hasHold && runStartedAt !== null) settlement = "settled"
  else if (active && Boolean(state.settlementError) && hasHold) settlement = "paused"
  else if (active) settlement = "active"

  return {
    policy: "observe_and_alert",
    thresholdMs: TURN_TIMEOUT_MS,
    executionDeadlineEnforced: false,
    runStartedAt,
    elapsedMs,
    overdue: active && elapsedMs !== null && elapsedMs >= TURN_TIMEOUT_MS,
    timeoutObserved,
    timeoutObservedAt: timeoutObserved && validTime(timeout?.observedAt) ? timeout.observedAt : null,
    settlement,
  }
}

function validTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}
