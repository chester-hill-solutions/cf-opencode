import { describe, expect, test } from "bun:test"
import {
  formatModelList,
  formatSessionList,
  modelRef,
  parseSlackCommand,
  relativeTime,
  resolveSessionChoice,
  type SessionSummary,
} from "../src/slack-command-format"

const now = Date.UTC(2026, 10, 4, 12, 0, 0)

describe("modelRef", () => {
  test("joins provider and model", () => {
    expect(modelRef({ providerID: "opencode-go", id: "deepseek-v4.1-flash" })).toBe(
      "opencode-go/deepseek-v4.1-flash",
    )
  })

  test("includes a variant when present", () => {
    expect(modelRef({ providerID: "p", id: "m", variant: "high" })).toBe("p/m#high")
  })
})

describe("relativeTime", () => {
  test("scales from seconds to days", () => {
    expect(relativeTime(now - 5_000, now)).toBe("just now")
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago")
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago")
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d ago")
  })

  test("returns empty when the timestamp is unknown", () => {
    expect(relativeTime(undefined, now)).toBe("")
  })
})

describe("formatModelList", () => {
  test("lists enabled models and marks the current one", () => {
    const out = formatModelList(
      [
        { providerID: "opencode-go", id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
        { providerID: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" },
      ],
      { current: "opencode-go/deepseek-v4.1-flash" },
    )
    expect(out).toContain("• `opencode-go/deepseek-v4.1-flash` — DeepSeek V4.1 Flash  ← current")
    expect(out).toContain("• `anthropic/claude-sonnet` — Claude Sonnet")
  })

  test("drops disabled and deprecated models", () => {
    const out = formatModelList([
      { providerID: "p", id: "off", enabled: false },
      { providerID: "p", id: "old", status: "deprecated" },
      { providerID: "p", id: "live", status: "active" },
    ])
    expect(out).toContain("p/live")
    expect(out).not.toContain("p/off")
    expect(out).not.toContain("p/old")
  })

  test("marks a selected variant and keeps only chat models when types are present", () => {
    const out = formatModelList([
      { providerID: "p", id: "chat", type: "chat" },
      { providerID: "p", id: "image", type: "image" },
      { providerID: "p", id: "gone", type: "chat", status: "unavailable" },
    ], { current: "p/chat#high" })
    expect(out).toContain("p/chat`  ← current")
    expect(out).not.toContain("p/image")
    expect(out).not.toContain("p/gone")
  })

  test("caps the list and says how many were left out", () => {
    const models = Array.from({ length: 30 }, (_, index) => ({ providerID: "p", id: `m${index}` }))
    const out = formatModelList(models, { limit: 10 })
    expect(out).toContain("p/m9")
    expect(out).not.toContain("p/m10")
    expect(out).toContain("20 more")
  })
})

describe("parseSlackCommand", () => {
  test("normalizes names and help punctuation while preserving args", () => {
    expect(parseSlackCommand("  !HELP.  ")).toEqual({ name: "help", args: "" })
    expect(parseSlackCommand("!MODEL p/m#high")).toEqual({ name: "model", args: "p/m#high" })
  })

  test("retains unknown commands and ignores ordinary text", () => {
    expect(parseSlackCommand("!future thing")).toEqual({ name: "future", args: "thing" })
    expect(parseSlackCommand("please !help")).toBeUndefined()
  })
})

describe("formatSessionList", () => {
  const sessions: SessionSummary[] = [
    { id: "ses_aaa", title: "Callcaster credits", time: { updated: now - 60_000 }, model: { providerID: "opencode-go", id: "deepseek" } },
    { id: "ses_bbb", title: "Formatting", time: { updated: now - 3 * 3_600_000 } },
  ]

  test("numbers sessions and marks the current one", () => {
    const out = formatSessionList(sessions, { now, current: "ses_aaa" })
    expect(out).toContain("1. *Callcaster credits*")
    expect(out).toContain("`ses_aaa` · 1m ago · `opencode-go/deepseek`  ← current")
    expect(out).toContain("2. *Formatting*")
    expect(out).toContain("default model")
  })

  test("explains an empty list", () => {
    expect(formatSessionList([], { now })).toContain("No sessions")
  })
})

describe("resolveSessionChoice", () => {
  const sessions: SessionSummary[] = [{ id: "ses_aaa" }, { id: "ses_bbb" }]

  test("accepts a 1-based number", () => {
    expect(resolveSessionChoice(sessions, "2")).toEqual({ kind: "session", session: sessions[1] as SessionSummary })
  })

  test("rejects a number outside the list", () => {
    expect(resolveSessionChoice(sessions, "9").kind).toBe("error")
  })

  test("accepts an exact id or an unambiguous prefix", () => {
    expect(resolveSessionChoice(sessions, "ses_aaa").kind).toBe("session")
    expect(resolveSessionChoice(sessions, "ses_b").kind).toBe("session")
  })

  test("rejects an ambiguous prefix and an unknown id", () => {
    expect(resolveSessionChoice([{ id: "ses_aa1" }, { id: "ses_aa2" }], "ses_aa").kind).toBe("error")
    expect(resolveSessionChoice(sessions, "nope").kind).toBe("error")
  })
})
