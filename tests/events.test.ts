import { describe, expect, test } from "bun:test"
import { formatSse } from "../src/events"

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

  test("settled has no payload fields", () => {
    expect(formatSse({ type: "settled" })).toBe('event: settled\ndata: {"type":"settled"}\n\n')
  })
})
