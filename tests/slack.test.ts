import { describe, expect, test } from "bun:test"
import {
  chunkText,
  formatSlackContext,
  mrkdwnEscape,
  verifySlackSignature,
} from "../src/adapters/slack"

async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${body}`))
  return "v0=" + Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("")
}

describe("verifySlackSignature", () => {
  const secret = "test-signing-secret"
  const body = JSON.stringify({ type: "event_callback" })
  const timestamp = "1700000000"

  test("accepts a valid signature", async () => {
    const signature = await sign(secret, timestamp, body)
    expect(
      await verifySlackSignature({ signingSecret: secret, timestamp, signature, body, now: 1700000000_000 }),
    ).toBe(true)
  })

  test("rejects a tampered body", async () => {
    const signature = await sign(secret, timestamp, body)
    expect(
      await verifySlackSignature({
        signingSecret: secret,
        timestamp,
        signature,
        body: body + " ",
        now: 1700000000_000,
      }),
    ).toBe(false)
  })

  test("rejects a stale timestamp", async () => {
    const signature = await sign(secret, timestamp, body)
    expect(
      await verifySlackSignature({
        signingSecret: secret,
        timestamp,
        signature,
        body,
        now: 1700000000_000 + 10 * 60_000,
      }),
    ).toBe(false)
  })

  test("rejects missing headers", async () => {
    expect(await verifySlackSignature({ signingSecret: secret, timestamp: null, signature: null, body })).toBe(false)
  })
})

describe("text helpers", () => {
  test("chunkText splits long input", () => {
    const chunks = chunkText("word ".repeat(2000), 1000)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1000)
  })

  test("formatSlackContext skips bots and the answered message", () => {
    const context = formatSlackContext(
      [
        { user: "U1", text: "earlier", ts: "1" },
        { bot_id: "B1", text: "bot", ts: "2" },
        { user: "U2", text: "current", ts: "3" },
      ],
      { botUserId: "UBOT", excludeTs: "3" },
    )
    expect(context).toBe("<@U1>: earlier")
  })

  test("mrkdwnEscape escapes the three characters", () => {
    expect(mrkdwnEscape("a & <b>")).toBe("a &amp; &lt;b&gt;")
  })
})
