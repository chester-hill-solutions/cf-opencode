import { describe, expect, test } from "bun:test"
import { buildPermissionRules, DENY_COMMANDS } from "../src/permissions"

describe("buildPermissionRules", () => {
  test("allows workspace edits and web access", () => {
    const rules = buildPermissionRules({}, "/workspace")
    expect(rules).toContainEqual({ action: "edit", resource: "/workspace/**", effect: "allow" })
    expect(rules).toContainEqual({ action: "read", resource: "/workspace/**", effect: "allow" })
    expect(rules).toContainEqual({ action: "webfetch", resource: "*", effect: "allow" })
    expect(rules).toContainEqual({ action: "websearch", resource: "*", effect: "allow" })
  })

  test("uses the configured workspace", () => {
    const rules = buildPermissionRules({}, "/srv/repo")
    expect(rules).toContainEqual({ action: "edit", resource: "/srv/repo/**", effect: "allow" })
  })

  test("asks for arbitrary shell and puts denials last", () => {
    const rules = buildPermissionRules({
      allow: ["bun test *"],
      ask: ["git push *"],
      deny: ["sudo *"],
    })
    const askIndex = rules.findIndex((rule) => rule.action === "shell" && rule.resource === "*")
    const denyIndex = rules.findIndex((rule) => rule.action === "shell" && rule.resource === "sudo *")
    expect(askIndex).toBeGreaterThan(-1)
    expect(denyIndex).toBeGreaterThan(askIndex)
    expect(rules).toContainEqual({ action: "shell", resource: "bun test *", effect: "allow" })
    expect(rules).toContainEqual({ action: "shell", resource: "git push *", effect: "ask" })
  })

  test("denies reading secrets and the metadata endpoint", () => {
    const rules = buildPermissionRules()
    expect(rules.some((rule) => rule.effect === "deny" && rule.resource.includes(".ssh"))).toBe(true)
    expect(rules.some((rule) => rule.effect === "deny" && rule.resource.includes(".env"))).toBe(true)
    expect(rules.some((rule) => rule.effect === "deny" && rule.resource.includes("169.254.169.254"))).toBe(true)
  })

  test("every default deny command is represented when supplied", () => {
    const rules = buildPermissionRules({ deny: [...DENY_COMMANDS] })
    for (const command of DENY_COMMANDS) {
      expect(rules).toContainEqual({ action: "shell", resource: command, effect: "deny" })
    }
  })

  test("a settings save cannot remove the hard-coded denials", () => {
    const rules = buildPermissionRules({ deny: [] })
    for (const command of DENY_COMMANDS) {
      expect(rules).toContainEqual({ action: "shell", resource: command, effect: "deny" })
    }
  })

  test("denies every env variant, harness state and metadata access", () => {
    const rules = buildPermissionRules({}, "/workspace")
    const denies = rules.filter((rule) => rule.effect === "deny")
    for (const action of ["read", "edit"]) {
      expect(denies).toContainEqual({ action, resource: "**/.env*", effect: "deny" })
      expect(denies).toContainEqual({ action, resource: "/workspace/.state/**", effect: "deny" })
      expect(denies).toContainEqual({ action, resource: "/**/.state/**", effect: "deny" })
    }
    expect(denies).toContainEqual({
      action: "webfetch",
      resource: "*169.254.169.254*",
      effect: "deny",
    })
    expect(denies).toContainEqual({ action: "shell", resource: "*.state*", effect: "deny" })
  })
})
