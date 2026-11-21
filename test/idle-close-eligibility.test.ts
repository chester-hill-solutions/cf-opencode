import { describe, expect, it } from "vitest"
import { ineligibleReason } from "../src/conversation/idle-close"
import type { ConversationState } from "../src/state"

/**
 * A closed turn keeps only an accounting record (`closedTurn`, the retained
 * reservation) and a queue nothing may admit. Neither needs a running container,
 * so neither may keep one alive: that is the difference between an operator's
 * pending decision and a slot leak.
 */

const base: ConversationState = { phase: "idle", seen: [], pending: {} }
const hold = { reservationID: "r1", date: "2026-11-20", dispatched: true }
const queue = [{ id: "q1", enqueuedAt: 1, source: "http" as const, text: "hello", attempts: 0 }]

describe("idle close eligibility", () => {
  it("closes a conversation with nothing outstanding", () => {
    expect(ineligibleReason(base)).toBe("ineligible")
  })

  it("keeps an open turn's queue and reservation", () => {
    expect(ineligibleReason({ ...base, queue })).toBe("queued")
    expect(ineligibleReason({ ...base, budgetReservation: hold })).toBe("reserved")
  })

  it("closes a closed turn even with a queue and a retained reservation", () => {
    expect(ineligibleReason({ ...base, queue, budgetReservation: hold, closedTurn: { at: 1, reason: "settlement_expired" } }))
      .toBe("ineligible")
  })

  it("still keeps runtime work a closed turn has not finished", () => {
    const closed = { at: 1, reason: "settlement_expired" as const }
    expect(ineligibleReason({ ...base, closedTurn: closed, checkpointPending: true })).toBe("checkpoint_pending")
    expect(ineligibleReason({ ...base, closedTurn: closed, pending: { perm: "ses_x" } })).toBe("pending_work")
  })

  it("names a phase that is not idle", () => {
    expect(ineligibleReason({ ...base, phase: "running" })).toBe("not_idle_running")
    expect(ineligibleReason({ ...base, phase: "queued" })).toBe("not_idle_queued")
  })
})
