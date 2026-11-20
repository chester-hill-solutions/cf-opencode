import { describe, expect, it } from "vitest"
import type { ConversationState } from "../src/state"
import { failureRetryAt, jobFailureReason } from "../src/conversation/scheduler"

/**
 * A failed lifecycle job retries while it still owns work. Retrying one that
 * owns none is how a single failure becomes an alarm loop: each wake prepares a
 * runtime, fails the same way and renews the lease.
 */

const idle: ConversationState = { phase: "idle", seen: [], pending: {} }

describe("failed lifecycle job retry", () => {
  it("never retries a lost session", () => {
    const error = new Error("Session not found")
    expect(jobFailureReason(error)).toBe("session_missing")
    expect(failureRetryAt("turn:observe", error, { ...idle, phase: "running" })).toBeUndefined()
  })

  it("does not retry an observation that owns no turn", () => {
    expect(failureRetryAt("turn:observe", new Error("boom"), idle)).toBeUndefined()
    expect(failureRetryAt("turn:observe", new Error("boom"), undefined)).toBeUndefined()
  })

  it("retries an observation that still expects a provider outcome", () => {
    expect(failureRetryAt("turn:observe", new Error("boom"), { ...idle, phase: "running" }))
      .toBeGreaterThan(Date.now())
    expect(failureRetryAt("turn:observe", new Error("boom"), { ...idle, phase: "settling" }))
      .toBeGreaterThan(Date.now())
    expect(failureRetryAt("turn:observe", new Error("boom"), {
      ...idle,
      budgetReservation: { reservationID: "held", date: "2026-11-20", dispatched: true },
    })).toBeGreaterThan(Date.now())
  })

  it("keeps retrying the other kinds, whose owner work is not a phase", () => {
    expect(failureRetryAt("lease:renew", new Error("boom"), idle)).toBeGreaterThan(Date.now())
    expect(failureRetryAt("checkpoint:retry", new Error("boom"), idle)).toBeGreaterThan(Date.now())
  })
})
