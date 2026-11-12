import { describe, expect, it } from "bun:test"
import { classifyRecovery, recoverySnapshotID, type RecoveryAuthority } from "../src/recovery"
import type { ConversationState } from "../src/state"

const base: ConversationState = { phase: "idle", seen: [], pending: {} }

const authority = (holds: RecoveryAuthority["holds"] = []): RecoveryAuthority => ({
  conversationID: "conversation-1",
  snapshotID: "a".repeat(64),
  holds,
  legacyRows: [],
})

describe("held turn recovery classification", () => {
  it("allows cancelling only a strictly undispatched idle proposal without queue or active cached fences", () => {
    const result = classifyRecovery({
      conversationID: "conversation-1",
      state: { ...base, budgetReservation: { reservationID: "r1", dispatched: false } },
      authority: authority(),
      live: { admitting: false, pumping: false },
    })
    expect(result).toEqual({ kind: "undispatched", blockers: [], actions: ["cancel_before_dispatch"] })
  })

  it("blocks undispatched cancellation for queued work, active cached evidence, or a live pump", () => {
    const state: ConversationState = {
      ...base,
      budgetReservation: { reservationID: "r1", dispatched: false },
      queued: { text: "private prompt", attempts: 0 },
      sessionID: "session-1",
      usageExecution: { sessionID: "session-1", startedSeq: 8, terminalSeq: 4, latestStepSeq: 6 },
    }
    const result = classifyRecovery({
      conversationID: "conversation-1", state, authority: authority(), live: { admitting: false, pumping: true },
    })
    expect(result.actions).toEqual([])
    expect(result.blockers).toEqual(expect.arrayContaining([
      "live_local_operation", "queued_work_present", "cached_execution_unfinished",
    ]))
  })

  it("allows dispatched retries with queued work and unfinished cached execution, but never clears them", () => {
    const result = classifyRecovery({
      conversationID: "conversation-1",
      state: {
        ...base,
        phase: "settling",
        budgetReservation: { reservationID: "r1", date: "2026-11-11", dispatched: true },
        queued: { text: "next prompt", attempts: 0 },
        sessionID: "session-1",
        usageExecution: { sessionID: "session-1", startedSeq: 8, terminalSeq: 4, latestStepSeq: 6 },
      },
      authority: authority(),
      live: { admitting: false, pumping: false },
    })
    expect(result).toEqual({ kind: "dispatched", blockers: [], actions: ["retry"] })
  })

  it("blocks central mismatch, legacy ownership, missing dispatched date, and stale cancellation phase", () => {
    const mismatch = classifyRecovery({
      conversationID: "conversation-1",
      state: { ...base, budgetReservation: { reservationID: "r1", date: "2026-11-11", dispatched: true } },
      authority: authority([{ kind: "reservation", conversationID: "conversation-1", reservationID: "other", date: "2026-11-11" }]),
      live: { admitting: false, pumping: false },
    })
    const noDate = classifyRecovery({
      conversationID: "conversation-1",
      state: { ...base, budgetReservation: { reservationID: "r1", dispatched: true } },
      authority: authority(), live: { admitting: false, pumping: false },
    })
    const legacy = classifyRecovery({
      conversationID: "conversation-1",
      state: { ...base, budgetReservation: { reservationID: "r1", dispatched: false } },
      authority: authority([{ kind: "legacy-reservation", conversationID: "conversation-1" }]),
      live: { admitting: false, pumping: false },
    })
    const stalePhase = classifyRecovery({
      conversationID: "conversation-1",
      state: { ...base, phase: "running", budgetReservation: { reservationID: "r1", dispatched: false } },
      authority: authority(), live: { admitting: false, pumping: false },
    })
    expect(mismatch.actions).toEqual([])
    expect(mismatch.blockers).toContain("central_ownership_mismatch")
    expect(noDate.blockers).toContain("dispatched_reservation_origin_date_missing")
    expect(legacy.blockers).toContain("legacy_hold")
    expect(stalePhase.blockers).toContain("phase_not_pre_dispatch")
  })

  it("binds inspection snapshots to ownership, authority state, cached evidence, and live flags", async () => {
    const input = {
      conversationID: "conversation-1",
      state: { ...base, budgetReservation: { reservationID: "r1", dispatched: false } },
      authority: authority(),
      live: { admitting: false, pumping: false },
    }
    const first = await recoverySnapshotID(input)
    const changed = await recoverySnapshotID({ ...input, authority: authority([
      { kind: "reservation", conversationID: "conversation-1", reservationID: "r1", date: "2026-11-11" },
    ]) })
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(changed).not.toBe(first)
  })
})
