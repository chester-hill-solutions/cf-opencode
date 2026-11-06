import { describe, expect, test } from "bun:test"
import { defaultSettings, validateSettings } from "../src/settings"

const base = defaultSettings({
  WORKSPACE_REPO: "https://github.com/chester-hill-solutions/cf-opencode",
  OPENCODE_MODEL: "opencode/deepseek-v4.1-flash",
  POLL_SECONDS: "2",
})

describe("defaultSettings", () => {
  test("uses environment defaults and smart-allow lists", () => {
    expect(base.workspaceRepo).toContain("github.com")
    expect(base.model).toBe("opencode/deepseek-v4.1-flash")
    expect(base.pollSeconds).toBe(2)
    expect(base.streaming).toBe(true)
    expect(base.permissions.allow.length).toBeGreaterThan(5)
    expect(base.permissions.ask.length).toBeGreaterThan(10)
    expect(base.permissions.ask).toContain("git push *")
    expect(base.permissions.deny).toContain("sudo *")
    expect(base.permissions.deny).toContain("dd *")
    expect(base.version).toBe(1)
  })
})

describe("validateSettings", () => {
  test("accepts a partial update and keeps the version", () => {
    const result = validateSettings({ pollSeconds: 5 }, base)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.pollSeconds).toBe(5)
      expect(result.value.version).toBe(base.version)
      expect(result.value.model).toBe(base.model)
    }
  })

  test("accepts permission lists", () => {
    const result = validateSettings(
      { permissions: { allow: ["ls *"], ask: ["git push *"], deny: ["rm -rf *"] } },
      base,
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.permissions.allow).toEqual(["ls *"])
      expect(result.value.permissions.ask).toEqual(["git push *"])
      expect(result.value.permissions.deny).toEqual(["rm -rf *"])
    }
  })

  test("rejects a bad repo, branch, model, poll interval or streaming flag", () => {
    for (const body of [
      { workspaceRepo: "not a url" },
      { workspaceBranch: "bad branch!" },
      { model: "no-slash" },
      { model: "/missing-provider" },
      { pollSeconds: 1 },
      { pollSeconds: 61 },
      { pollSeconds: 2.5 },
      { streaming: "yes" },
      { permissions: { allow: [""] } },
      { permissions: { deny: "sudo *" } },
    ]) {
      expect(validateSettings(body, base).ok).toBe(false)
    }
  })

  test("trims permission patterns", () => {
    const result = validateSettings({ permissions: { allow: ["  ls *  "], ask: [], deny: [] } }, base)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.permissions.allow).toEqual(["ls *"])
  })

  test("starts with no onboarding progress", () => {
    expect(base.onboarding).toEqual({})
  })

  test("keeps onboarding progress across a settings save", () => {
    const connected = {
      ...base,
      onboarding: { githubConnectedAt: 123, githubLogin: "octocat", completedAt: 456 },
    }
    const result = validateSettings({ pollSeconds: 4 }, connected)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.onboarding).toEqual(connected.onboarding)
  })

  test("does not let a client write onboarding state through PUT", () => {
    const result = validateSettings(
      { onboarding: { completedAt: 999, githubLogin: "attacker" } },
      base
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.onboarding).toEqual({})
  })

  test("defaults to no spending budget", () => {
    expect(base.dailyBudgetUSD).toBe(0)
  })

  test("accepts a daily budget and keeps it across saves", () => {
    const withBudget = { ...base, dailyBudgetUSD: 12.5 }
    const result = validateSettings({ streaming: false }, withBudget)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.dailyBudgetUSD).toBe(12.5)
  })

  test("rejects an invalid daily budget", () => {
    for (const value of [-1, Number.NaN, 1e9, "5"]) {
      expect(validateSettings({ dailyBudgetUSD: value }, base).ok).toBe(false)
    }
  })

  test("defaults to two concurrent containers", () => {
    expect(base.maxContainers).toBe(2)
  })

  test("accepts a container cap and keeps it across saves", () => {
    const withCap = { ...base, maxContainers: 4 }
    const result = validateSettings({ streaming: false }, withCap)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.maxContainers).toBe(4)
  })

  test("rejects an invalid container cap", () => {
    for (const value of [0, 11, 2.5, "2"]) {
      expect(validateSettings({ maxContainers: value }, base).ok).toBe(false)
    }
  })
})
