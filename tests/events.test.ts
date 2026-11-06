import { describe, expect, test } from "bun:test"
import { formatSse, isSlowSubscriber } from "../src/events"

describe("isSlowSubscriber", () => {
  test("drops only subscribers past the queue budget", () => {
    expect(isSlowSubscriber(0)).toBe(false)
    expect(isSlowSubscriber(-1024)).toBe(false)
    expect(isSlowSubscriber(-65 * 1024)).toBe(true)
    expect(isSlowSubscriber(null)).toBe(false)
  })
})

describe("formatSse", () => {
  test("wraps an assistant event in an SSE frame", () => {
    expect(formatSse({ type: "assistant", text: "hi" })).toBe(
      'event: assistant\ndata: {"type":"assistant","text":"hi"}\n\n',
    )
  })

  test("includes permission details", () => {
    const frame = formatSse({ type: "permission", requestID: "req_1", action: "shell", resources: ["ls"] })
    expect(frame.startsWith("event: permission\n")).toBe(true)
    expect(frame).toContain('"requestID":"req_1"')
    expect(frame.endsWith("\n\n")).toBe(true)
  })

  test("includes an SSE id when sequenced", () => {
    expect(formatSse({ type: "settled" }, 7)).toBe('id: 7\nevent: settled\ndata: {"type":"settled"}\n\n')
  })

  test("formats a reset frame", () => {
    expect(formatSse({ type: "reset" })).toBe('event: reset\ndata: {"type":"reset"}\n\n')
  })

  test("settled has no payload fields", () => {
    expect(formatSse({ type: "settled" })).toBe('event: settled\ndata: {"type":"settled"}\n\n')
  })
})
