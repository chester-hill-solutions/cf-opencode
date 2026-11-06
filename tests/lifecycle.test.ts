import { describe, expect, test } from "bun:test"
import { STALE_SETTLE_MS, TURN_TIMEOUT_MS, staleAction } from "../src/lifecycle"
import type { ConversationState } from "../src/state"

const now = 1_000_000_000
const state = (overrides: Partial<ConversationState>): ConversationState => ({
  seen: [],
  pending: {},
  ...overrides,
})

describe("staleAction", () => {
  test("does nothing while a poll is running", () => {
    expect(staleAction(state({ phase: "running", runStartedAt: 0 }), now, true)).toBeUndefined()
  })

  test("recovers an admission abandoned by a dead request", () => {
    expect(staleAction(state({ phase: "admitting" }), now, false)).toBe("admission")
  })

  test("resets a settle that outlived the interrupted delivery", () => {
    const started = now - STALE_SETTLE_MS - 1
    expect(staleAction(state({ phase: "settling", runStartedAt: started }), now, false)).toBe(
      "settlement"
    )
  })

  test("keeps a settle inside the window", () => {
    const started = now - STALE_SETTLE_MS + 1000
    expect(staleAction(state({ phase: "settling", runStartedAt: started }), now, false)).toBeUndefined()
  })

  test("times out a running turn with no terminal message", () => {
    const started = now - TURN_TIMEOUT_MS - 1
    expect(staleAction(state({ phase: "running", runStartedAt: started }), now, false)).toBe("timeout")
  })

  test("keeps a running turn inside the window", () => {
    const started = now - TURN_TIMEOUT_MS + 1000
    expect(staleAction(state({ phase: "running", runStartedAt: started }), now, false)).toBeUndefined()
  })

  test("does not time out a run with no start timestamp", () => {
    expect(staleAction(state({ phase: "running" }), now, false)).toBeUndefined()
  })

  test("leaves idle and queued conversations alone", () => {
    expect(staleAction(state({ phase: "idle" }), now, false)).toBeUndefined()
    expect(staleAction(state({ phase: "queued", queued: { text: "x", attempts: 1 } }), now, false)).toBeUndefined()
  })
})
