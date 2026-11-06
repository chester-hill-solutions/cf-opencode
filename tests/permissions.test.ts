import { describe, expect, test } from "bun:test"
import { DENY_COMMANDS, isSafeShellCommand, smartAllowRules } from "../src/permissions"

describe("smartAllowRules", () => {
  test("allows workspace edits and web access", () => {
    const rules = smartAllowRules("/workspace")
    expect(rules).toContainEqual({ action: "edit", resource: "/workspace/**", effect: "allow" })
    expect(rules).toContainEqual({ action: "read", resource: "/workspace/**", effect: "allow" })
    expect(rules).toContainEqual({ action: "webfetch", resource: "*", effect: "allow" })
  })

  test("asks for arbitrary shell and denies dangerous commands last", () => {
    const rules = smartAllowRules()
    const askIndex = rules.findIndex((rule) => rule.action === "shell" && rule.resource === "*")
    const denyIndex = rules.findIndex((rule) => rule.action === "shell" && rule.resource === "sudo *")
    expect(askIndex).toBeGreaterThan(-1)
    expect(denyIndex).toBeGreaterThan(askIndex)
  })

  test("denies reading secrets", () => {
    const rules = smartAllowRules()
    expect(rules.some((rule) => rule.effect === "deny" && rule.resource.includes(".ssh"))).toBe(true)
    expect(rules.some((rule) => rule.effect === "deny" && rule.resource.includes(".env"))).toBe(true)
  })

  test("every deny command is represented", () => {
    const rules = smartAllowRules()
    for (const command of DENY_COMMANDS) {
      expect(rules).toContainEqual({ action: "shell", resource: command, effect: "deny" })
    }
  })
})

describe("isSafeShellCommand", () => {
  test("allows read-only and build commands", () => {
    for (const command of ["ls -la", "cat file.txt", "rg TODO", "git status", "git diff --stat", "bun test", "node --version"]) {
      expect(isSafeShellCommand(command)).toBe(true)
    }
  })

  test("asks for unknown binaries", () => {
    expect(isSafeShellCommand("terraform apply")).toBe(false)
    expect(isSafeShellCommand("./deploy.sh")).toBe(false)
  })

  test("rejects shell metacharacters and redirection", () => {
    for (const command of ["ls | sh", "cat a > b", "echo $(whoami)", "git status && rm -rf /", "ls; whoami"]) {
      expect(isSafeShellCommand(command)).toBe(false)
    }
  })

  test("rejects destructive commands", () => {
    for (const command of ["sudo ls", "rm -rf /workspace", "chmod 777 file", "dd if=/dev/zero of=/dev/sda"]) {
      expect(isSafeShellCommand(command)).toBe(false)
    }
  })
})
