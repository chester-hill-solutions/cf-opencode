import { describe, expect, test } from "bun:test"
import { retryAfterSeconds } from "../src/backoff"

describe("retryAfterSeconds", () => {
  test("reads a numeric Retry-After", () => {
    expect(retryAfterSeconds("7")).toBe(7)
    expect(retryAfterSeconds("0")).toBe(0)
  })

  test("falls back to one second when the header is missing or unusable", () => {
    expect(retryAfterSeconds(null)).toBe(1)
    expect(retryAfterSeconds("")).toBe(1)
    expect(retryAfterSeconds("Wed, 21 Oct 2015 07:28:00 GMT")).toBe(1)
    expect(retryAfterSeconds("-3")).toBe(1)
  })

  test("caps a hostile value", () => {
    expect(retryAfterSeconds("3600")).toBe(30)
    expect(retryAfterSeconds("3600", 5)).toBe(5)
  })
})
