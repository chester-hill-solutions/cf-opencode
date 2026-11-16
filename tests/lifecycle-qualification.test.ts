import { describe, expect, test } from "bun:test"
import { bearerAuthorized } from "../src/control-auth"
import { resolveQualificationRoute } from "../scripts/lifecycle-qualification/route-contract"

describe("lifecycle qualification route contract", () => {
  test("resolves only the two fixed actions and two fixed core reads", () => {
    expect(resolveQualificationRoute("/prepare", "POST")).toEqual({ kind: "prepare" })
    expect(resolveQualificationRoute("/cleanup", "POST")).toEqual({ kind: "cleanup" })
    expect(resolveQualificationRoute(
      "/api/conversations/lifecycle-idle-qualification/context", "GET",
    )).toEqual({ kind: "core", path: "/context" })
    expect(resolveQualificationRoute(
      "/api/conversations/lifecycle-idle-qualification/debug", "GET",
    )).toEqual({ kind: "core", path: "/debug" })
    expect(resolveQualificationRoute("/api/conversations/arbitrary/context", "GET")).toBeUndefined()
    expect(resolveQualificationRoute("/prepare/extra", "POST")).toBeUndefined()
    expect(resolveQualificationRoute("/prepare", "GET")).toBeUndefined()
  })

  test("requires the fixed-time bearer authorization helper to accept staging credentials", () => {
    expect(bearerAuthorized("Bearer isolated-test-token", "isolated-test-token")).toBe(true)
    expect(bearerAuthorized("Bearer wrong-token", "isolated-test-token")).toBe(false)
    expect(bearerAuthorized(null, "isolated-test-token")).toBe(false)
    expect(bearerAuthorized("Bearer anything", "")).toBe(false)
  })
})
