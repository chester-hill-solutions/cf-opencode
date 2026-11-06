import { describe, expect, test } from "bun:test"
import { createSseParser, type SseMessage } from "../src/sse"

function collect() {
  const messages: SseMessage[] = []
  return { messages, parse: createSseParser((message) => messages.push(message)) }
}

describe("createSseParser", () => {
  test("parses a frame with id, event and data", () => {
    const { messages, parse } = collect()
    parse('id: 3\nevent: assistant\ndata: {"type":"assistant","text":"hi"}\n\n')
    expect(messages).toEqual([{ id: "3", event: "assistant", data: '{"type":"assistant","text":"hi"}' }])
  })

  test("handles frames split across chunks", () => {
    const { messages, parse } = collect()
    parse("event: assis")
    parse('tant\ndata: {"type":"assistant","text":"hi"}\n')
    expect(messages).toEqual([])
    parse("\n")
    expect(messages).toHaveLength(1)
    expect(messages[0]!.event).toBe("assistant")
  })

  test("parses several frames in one chunk", () => {
    const { messages, parse } = collect()
    parse("event: assistant\ndata: {}\n\nevent: settled\ndata: {}\n\n")
    expect(messages.map((message) => message.event)).toEqual(["assistant", "settled"])
  })

  test("ignores comments and blank frames", () => {
    const { messages, parse } = collect()
    parse(": connected\n\n: heartbeat\n\n")
    expect(messages).toEqual([])
  })

  test("accepts data-only frames", () => {
    const { messages, parse } = collect()
    parse('data: {"type":"settled"}\n\n')
    expect(messages).toEqual([{ data: '{"type":"settled"}' }])
  })
})
