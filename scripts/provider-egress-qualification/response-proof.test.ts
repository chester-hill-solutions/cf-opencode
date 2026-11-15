import { describe, expect, test } from "bun:test"
import { successfulStartProof } from "./response-proof"

describe("provider egress start response proof", () => {
  test("accepts and consumes a successful JSON proof", async () => {
    const response = Response.json({ ok: true })
    expect(await successfulStartProof(response)).toBe(true)
    expect(response.bodyUsed).toBe(true)
  })

  test("cancels a failed HTTP response body without parsing it", async () => {
    let canceled = false
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("private error body")) },
      cancel() { canceled = true },
    }), { status: 503 })

    expect(await successfulStartProof(response)).toBe(false)
    expect(canceled).toBe(true)
  })

  test("consumes malformed JSON and rejects it without a second body operation", async () => {
    const response = new Response("not JSON", { headers: { "content-type": "text/plain" } })

    expect(await successfulStartProof(response)).toBe(false)
    expect(response.bodyUsed).toBe(true)
  })
})
