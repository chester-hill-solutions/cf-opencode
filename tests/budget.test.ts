import { describe, expect, test } from "bun:test"
import { budgetExceeded, nextBudgetReset } from "../src/budget"

describe("budgetExceeded", () => {
  test("is disabled when no budget is set", () => {
    expect(budgetExceeded(10, 0)).toBe(false)
    expect(budgetExceeded(10, -1)).toBe(false)
  })

  test("blocks at or above the cap", () => {
    expect(budgetExceeded(5, 5)).toBe(true)
    expect(budgetExceeded(5.01, 5)).toBe(true)
  })

  test("allows spend below the cap", () => {
    expect(budgetExceeded(4.99, 5)).toBe(false)
    expect(budgetExceeded(0, 0.01)).toBe(false)
  })

  test("ignores non-finite numbers", () => {
    expect(budgetExceeded(Number.NaN, 5)).toBe(false)
    expect(budgetExceeded(5, Number.NaN)).toBe(false)
  })
})

describe("nextBudgetReset", () => {
  test("returns just after the next UTC midnight", () => {
    const now = Date.parse("2026-11-07T12:34:56.000Z")
    expect(new Date(nextBudgetReset(now)).toISOString()).toBe("2026-11-08T00:01:00.000Z")
  })

  test("never returns a moment in the past", () => {
    const now = Date.parse("2026-11-07T23:59:59.999Z")
    expect(nextBudgetReset(now)).toBeGreaterThanOrEqual(now + 60_000)
  })
})
