import { describe, expect, test } from "bun:test"
import { sdkTerminalFailure } from "./sdk-failure"

const known = [
  "compaction.unavailable",
  "compaction.failed",
  "provider.auth",
  "provider.no-route",
  "provider.unsupported-operation",
  "provider.unknown",
  "provider.content-filter",
  "unknown",
] as const

describe("SDK terminal failure classification", () => {
  test("returns only exact known error codes", () => {
    for (const type of known) {
      expect(sdkTerminalFailure([{ type: "assistant", error: { type, message: "private text" } }])).toBe(type)
    }
  })

  test("never reflects hostile error types or provider messages", () => {
    const hostile = "provider.auth\nSECRET=do-not-return"
    expect(sdkTerminalFailure([{ type: "assistant", error: hostile }])).toBe("terminal_error")
    expect(sdkTerminalFailure([{ type: "assistant", error: { type: hostile, message: hostile } }])).toBe("terminal_error")
    expect(sdkTerminalFailure([{ type: "assistant", error: { type: "other", message: hostile } }])).toBe("terminal_error")
    expect(sdkTerminalFailure([{ type: "assistant", error: { message: hostile } }])).toBe("terminal_error")
  })

  test("limits classification to the current turn and uses a safe default", () => {
    expect(sdkTerminalFailure([
      { id: "old-user", type: "user" },
      { type: "assistant", error: { type: "provider.auth" } },
      { id: "new-user", type: "user" },
      { type: "assistant", content: [{ type: "text", text: "no error" }] },
    ])).toBe("terminal_error")
    expect(sdkTerminalFailure([])).toBe("terminal_error")
  })
})
