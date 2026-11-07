import { describe, expect, test } from "bun:test"
import { bearerAuthorized, constantTimeEqual } from "../src/control-auth"

describe("constantTimeEqual", () => {
  test("matches identical strings and rejects different ones", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true)
    expect(constantTimeEqual("abc", "abd")).toBe(false)
    expect(constantTimeEqual("abc", "abcd")).toBe(false)
    expect(constantTimeEqual("", "")).toBe(true)
  })
})

describe("bearerAuthorized", () => {
  test("accepts only the expected bearer token", () => {
    expect(bearerAuthorized("Bearer secret", "secret")).toBe(true)
    expect(bearerAuthorized("Bearer other", "secret")).toBe(false)
    expect(bearerAuthorized("secret", "secret")).toBe(false)
    expect(bearerAuthorized(null, "secret")).toBe(false)
  })

  test("refuses everything when no token is configured", () => {
    expect(bearerAuthorized("Bearer ", "")).toBe(false)
    expect(bearerAuthorized("Bearer anything", "")).toBe(false)
  })
})
