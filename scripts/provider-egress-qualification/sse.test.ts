import { describe, expect, test } from "bun:test"
import { ChatCompletionSSEParser } from "./sse"

const frame = (choice: Record<string, unknown>) => `data: ${JSON.stringify({ choices: [choice] })}\r\n\r\n`

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function parseInChunks(value: string, chunkSize: number, limit = 48 * 1024) {
  const source = bytes(value)
  const parser = new ChatCompletionSSEParser(limit)
  for (let offset = 0; offset < source.length; offset += chunkSize) {
    parser.push(source.slice(offset, Math.min(offset + chunkSize, source.length)))
  }
  return parser.finish()
}

describe("ChatCompletionSSEParser", () => {
  test("reconstructs content split across delta frames and arbitrary UTF-8/CRLF chunks", () => {
    const sse = [
      ": keepalive\r\n\r\n",
      frame({ delta: { role: "assistant" }, finish_reason: null }),
      frame({ delta: { content: "R1_7A_" }, finish_reason: null }),
      frame({ delta: { content: "STREAM_OK" }, finish_reason: null }),
      frame({ delta: {}, finish_reason: "stop" }),
      "data: [DONE]\r\n\r\n",
    ].join("")
    const result = parseInChunks(sse, 7)
    expect(result.valid).toBe(true)
    expect(result.content).toBe("R1_7A_STREAM_OK")
    expect(result.chunks).toBeGreaterThan(1)
    expect(result.bytes).toBe(bytes(sse).byteLength)
  })

  test("rejects missing DONE, malformed JSON, data after DONE, and oversized streams", () => {
    expect(parseInChunks(frame({ delta: { content: "marker" } }), 12).valid).toBe(false)
    expect(parseInChunks("data: {bad}\n\n data: [DONE]\n\n", 5).valid).toBe(false)
    expect(parseInChunks(`${frame({ delta: {} })}data: [DONE]\n\ndata: extra\n\n`, 9).valid).toBe(false)
    expect(parseInChunks(`${frame({ delta: { content: "long" } })}data: [DONE]\n\n`, 8, 12).valid).toBe(false)
  })
})
