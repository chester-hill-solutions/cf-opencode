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

  test("denies the live state root that holds provider credentials", () => {
    const rules = buildPermissionRules({}, "/workspace", "/var/lib/aboiteau/state")
    const denies = rules.filter((rule) => rule.effect === "deny")
    for (const action of ["read", "edit"]) {
      expect(denies).toContainEqual({
        action,
        resource: "/var/lib/aboiteau/state/**",
        effect: "deny",
      })
    }
    for (const pattern of [
      "*/var/lib/aboiteau/state*",
      "*$HOME*",
      "*${HOME}*",
      "*$XDG_CONFIG_HOME*",
      "*${XDG_DATA_HOME}*",
      "*~*",
    ]) {
      expect(denies).toContainEqual({ action: "shell", resource: pattern, effect: "deny" })
    }
  })

  test("uses the configured state root instead of the legacy layout", () => {
    const rules = buildPermissionRules({}, "/workspace", "/srv/harness-state/")
    expect(rules).toContainEqual({
      action: "read",
      resource: "/srv/harness-state/**",
      effect: "deny",
    })
    expect(rules).toContainEqual({
      action: "shell",
      resource: "*/srv/harness-state*",
      effect: "deny",
    })
  })

  test("orders catch-all asks before the exceptions they baseline", () => {
    // OpenCode uses the last matching rule, so a catch-all placed after an
    // allow would make the allow unreachable (every safe shell command would
    // ask, and every workspace edit would ask).
    const rules = buildPermissionRules({ allow: ["cat *"] }, "/workspace")
    const shellAsk = rules.findIndex((rule) => rule.action === "shell" && rule.resource === "*")
    const shellAllow = rules.findIndex((rule) => rule.action === "shell" && rule.resource === "cat *")
    const editAsk = rules.findIndex((rule) => rule.action === "edit" && rule.resource === "/**")
    const editAllow = rules.findIndex((rule) => rule.action === "edit" && rule.resource === "/workspace/**")
    expect(shellAsk).toBeGreaterThan(-1)
    expect(shellAllow).toBeGreaterThan(shellAsk)
    expect(editAsk).toBeGreaterThan(-1)
    expect(editAllow).toBeGreaterThan(editAsk)
  })

  test("resolves sample commands to the intended effect under last-match-wins", () => {
    // Mirrors the upstream whole-value glob (`*` matches any characters,
    // including `/`); the last matching rule for an action decides.
    const rules = buildPermissionRules(
      { allow: ["cat *", "git status *", "bun test *"], ask: ["git push *"], deny: ["sudo *"] },
      "/workspace",
      "/var/lib/aboiteau/state",
    )
    const verdict = (action: string, resource: string): string | undefined => {
      const glob = (pattern: string) =>
        new RegExp(
          `^${pattern
            .split("*")
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*")}$`,
        )
      const matches = (pattern: string) => {
        if (glob(pattern).test(resource)) return true
        // A shell pattern ending in " *" also matches the bare command.
        if (pattern.endsWith(" *") && glob(pattern.slice(0, -2)).test(resource)) return true
        return false
      }
      let effect: string | undefined
      for (const rule of rules) {
        if (rule.action === action && matches(rule.resource)) effect = rule.effect
      }
      return effect
    }
    expect(verdict("shell", "cat /workspace/foo.txt")).toBe("allow")
    expect(verdict("shell", "git status --short")).toBe("allow")
    expect(verdict("shell", "bun test tests")).toBe("allow")
    expect(verdict("shell", "git push origin main")).toBe("ask")
    expect(verdict("shell", "rm -rf /tmp/x")).toBe("deny")
    expect(verdict("shell", "sudo ls")).toBe("deny")
    expect(verdict("shell", "cat /var/lib/aboiteau/state/config/opencode.json")).toBe("deny")
    expect(verdict("edit", "/workspace/a.txt")).toBe("allow")
    expect(verdict("edit", "/etc/passwd")).toBe("ask")
    expect(verdict("read", "/workspace/a.txt")).toBe("allow")
    expect(verdict("read", "/etc/passwd")).toBe("ask")
    expect(verdict("read", "/var/lib/aboiteau/state/config/opencode.json")).toBe("deny")
    expect(verdict("webfetch", "https://example.com")).toBe("allow")
    expect(verdict("webfetch", "http://169.254.169.254/latest")).toBe("deny")
  })
})
