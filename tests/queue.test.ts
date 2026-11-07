import { describe, expect, test } from "bun:test"
import { isCapacityRejection } from "../src/queue"

describe("queue capacity detection", () => {
  test("recognises the lease-cap error", () => {
    expect(isCapacityRejection(new Error("container capacity reached"))).toBe(true)
  })

  test("does not treat prompt failures as capacity pressure", () => {
    expect(isCapacityRejection(new Error("session.create returned no id"))).toBe(false)
    expect(isCapacityRejection(new Error("container start failed: 500"))).toBe(false)
    expect(isCapacityRejection("container capacity reached")).toBe(true)
    expect(isCapacityRejection(undefined)).toBe(false)
  })
})
