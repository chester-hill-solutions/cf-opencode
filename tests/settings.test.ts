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
})
