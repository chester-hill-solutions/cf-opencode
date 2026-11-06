import { describe, expect, test } from "bun:test"
import { withRetries } from "../src/retry"

describe("withRetries", () => {
  test("returns the first success", async () => {
    let calls = 0
    const result = await withRetries(async () => {
      calls++
      return "ok"
    }, { attempts: 3, delayMs: 1 })
    expect(result).toBe("ok")
    expect(calls).toBe(1)
  })

  test("retries until it succeeds", async () => {
    let calls = 0
    const result = await withRetries(async () => {
      calls++
      if (calls < 3) throw new Error("boom")
      return calls
    }, { attempts: 3, delayMs: 1 })
    expect(result).toBe(3)
    expect(calls).toBe(3)
  })

  test("throws the last error after exhausting attempts", async () => {
    let calls = 0
    await expect(
      withRetries(async () => {
        calls++
        throw new Error(`boom ${calls}`)
      }, { attempts: 2, delayMs: 1 }),
    ).rejects.toThrow("boom 2")
    expect(calls).toBe(2)
  })
})
