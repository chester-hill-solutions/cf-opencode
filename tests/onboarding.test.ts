import { describe, expect, test } from "bun:test"
import { hasConnectedProvider, isOnboardingProxyPath } from "../src/onboarding"

describe("isOnboardingProxyPath", () => {
  test("allows the endpoints the setup wizard uses", () => {
    expect(isOnboardingProxyPath("/integrations", "GET")).toBe(true)
    expect(isOnboardingProxyPath("/models", "GET")).toBe(true)
    expect(isOnboardingProxyPath("/integrations/github:main/connect/oauth", "POST")).toBe(true)
    expect(isOnboardingProxyPath("/integrations/github:main/connect/oauth/attempt1", "GET")).toBe(true)
    expect(
      isOnboardingProxyPath("/integrations/github:main/connect/oauth/attempt1/complete", "POST"),
    ).toBe(true)
    expect(isOnboardingProxyPath("/integrations/github:main/connect/key", "POST")).toBe(true)
  })

  test("rejects control-plane routes", () => {
    for (const path of [
      "/configure",
      "/start",
      "/restore",
      "/seed-state",
      "/checkpoint",
      "/state-checkpoint",
      "/health",
      "/usage",
    ]) {
      expect(isOnboardingProxyPath(path, "POST")).toBe(false)
    }
  })

  test("rejects wrong methods and dot segments", () => {
    expect(isOnboardingProxyPath("/integrations/a/connect/oauth", "GET")).toBe(false)
    expect(isOnboardingProxyPath("/integrations/a/connect/key", "GET")).toBe(false)
    expect(isOnboardingProxyPath("/integrations/../configure", "POST")).toBe(false)
    expect(isOnboardingProxyPath("/integrations/a/connect/oauth/../complete", "POST")).toBe(false)
  })
})

describe("hasConnectedProvider", () => {
  test("requires at least one connection", () => {
    expect(hasConnectedProvider([])).toBe(false)
    expect(hasConnectedProvider([{}])).toBe(false)
    expect(hasConnectedProvider([{ connections: [] }])).toBe(false)
    expect(hasConnectedProvider([{ connections: [{}] }])).toBe(true)
  })
})
