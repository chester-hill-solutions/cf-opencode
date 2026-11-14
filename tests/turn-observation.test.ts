import { describe, expect, it } from "bun:test"
import { TURN_TIMEOUT_MS } from "../src/lifecycle"
import { projectTurnObservation } from "../src/turn-observation"
import type { ConversationState } from "../src/state"

const startedAt = 1_000_000
const running: ConversationState = {
  phase: "running",
  sessionID: "session-a",
  runStartedAt: startedAt,
  seen: [],
  pending: {},
}

describe("projectTurnObservation", () => {
  it("marks a running turn overdue at the threshold boundary", () => {
    const observation = projectTurnObservation(running, startedAt + TURN_TIMEOUT_MS)

    expect(observation).toMatchObject({
      policy: "observe_and_alert",
      thresholdMs: TURN_TIMEOUT_MS,
      executionDeadlineEnforced: false,
      elapsedMs: TURN_TIMEOUT_MS,
      overdue: true,
      timeoutObserved: false,
      settlement: "active",
    })
  })

  it("does not apply a previous turn timeout record to a newer run", () => {
    const observation = projectTurnObservation(
      { ...running, runStartedAt: startedAt + 1, budgetReservation: { reservationID: "new", dispatched: true } },
      startedAt + TURN_TIMEOUT_MS,
      { sessionID: "session-a", runStartedAt: startedAt, observedAt: startedAt + TURN_TIMEOUT_MS },
    )

    expect(observation.timeoutObserved).toBe(false)
    expect(observation.timeoutObservedAt).toBeNull()
    expect(observation.settlement).toBe("active")
  })

  it("projects the same persisted timeout after a restart and preserves legacy records without timestamps", () => {
    const timeoutRecord = { sessionID: "session-a", runStartedAt: startedAt }
    const first = projectTurnObservation(running, startedAt + TURN_TIMEOUT_MS + 5, timeoutRecord)
    const afterRestart = projectTurnObservation({ ...running }, startedAt + TURN_TIMEOUT_MS + 5, timeoutRecord)

    expect(afterRestart).toEqual(first)
    expect(afterRestart.timeoutObserved).toBe(true)
    expect(afterRestart.timeoutObservedAt).toBeNull()
  })

  it("reports a timed out dispatched hold as paused without claiming execution stopped", () => {
    const observation = projectTurnObservation(
      {
        ...running,
        budgetReservation: { reservationID: "hold-a", dispatched: true },
        settlementError: "turn exceeded its time limit",
      },
      startedAt + TURN_TIMEOUT_MS,
      { sessionID: "session-a", runStartedAt: startedAt, observedAt: startedAt + TURN_TIMEOUT_MS },
    )

    expect(observation).toMatchObject({
      overdue: true,
      timeoutObserved: true,
      timeoutObservedAt: startedAt + TURN_TIMEOUT_MS,
      settlement: "paused",
      executionDeadlineEnforced: false,
    })
    expect(observation).not.toHaveProperty("runtimeStopped")
  })

  it("does not infer a paused settlement from a timeout record alone", () => {
    const observation = projectTurnObservation(
      { ...running, budgetReservation: { reservationID: "hold-a", dispatched: true } },
      startedAt + TURN_TIMEOUT_MS,
      { sessionID: "session-a", runStartedAt: startedAt, observedAt: startedAt + TURN_TIMEOUT_MS },
    )

    expect(observation.timeoutObserved).toBe(true)
    expect(observation.settlement).toBe("active")
  })

  it("keeps settlement unknown when an idle legacy state has no run timestamp", () => {
    const observation = projectTurnObservation({ phase: "idle", seen: [], pending: {} }, startedAt)

    expect(observation).toMatchObject({
      runStartedAt: null,
      elapsedMs: null,
      overdue: false,
      timeoutObserved: false,
      timeoutObservedAt: null,
      settlement: "unknown",
      executionDeadlineEnforced: false,
    })
  })
})
