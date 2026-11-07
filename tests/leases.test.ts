import { describe, expect, test } from "bun:test"
import { decideLease } from "../src/leases"

const now = 1_000_000
const ttl = 600_000
const base = { leases: [], id: "a", now, ttlMs: ttl, cap: 2 }

describe("decideLease", () => {
  test("grants when a slot is free", () => {
    expect(decideLease(base)).toEqual({
      grant: true,
      expiresAt: now + ttl,
      active: 1,
      refreshed: false,
    })
  })

  test("refreshes a lease the caller already holds, even at the cap", () => {
    const leases = [
      { id: "a", expiresAt: now + 5 },
      { id: "b", expiresAt: now + 5 },
    ]
    const decision = decideLease({ ...base, leases })
    expect(decision).toMatchObject({ grant: true, active: 2, refreshed: true })
    expect(decision.grant && decision.expiresAt).toBe(now + ttl)
  })

  test("refuses at the cap and reports the earliest expiry", () => {
    const leases = [
      { id: "a", expiresAt: now + 300 },
      { id: "b", expiresAt: now + 100 },
    ]
    expect(decideLease({ ...base, id: "c", leases })).toEqual({
      grant: false,
      active: 2,
      retryAt: now + 100,
    })
  })

  test("ignores and does not count expired leases", () => {
    const leases = [
      { id: "a", expiresAt: now - 1 },
      { id: "b", expiresAt: now - 2 },
    ]
    expect(decideLease({ ...base, leases })).toMatchObject({ grant: true, active: 1 })
  })

  test("lets an expired lease holder back in even when others fill the cap", () => {
    const leases = [
      { id: "a", expiresAt: now - 1 },
      { id: "b", expiresAt: now + 100 },
    ]
    expect(decideLease({ ...base, leases })).toMatchObject({ grant: true, active: 2 })
  })

  test("treats a cap below one as one", () => {
    expect(decideLease({ ...base, cap: 0 })).toMatchObject({ grant: true, active: 1 })
    expect(decideLease({ ...base, cap: 0, leases: [{ id: "b", expiresAt: now + 1 }] })).toMatchObject({
      grant: false,
      active: 1,
    })
  })
})
