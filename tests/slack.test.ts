import { describe, expect, test } from "bun:test"
import {
  chunkText,
  conversationKey,
  formatCheckin,
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

describe("conversationKey", () => {
  test("DMs are one conversation", () => {
    expect(conversationKey({ channel: "D1", ts: "1", isDm: true }, () => false)).toEqual({ key: "D1:dm" })
  })

  test("a mention in a thread uses that thread", () => {
    expect(
      conversationKey(
        { channel: "C1", ts: "2", threadTs: "1", isDm: false, engageChannel: true },
        () => false,
      ),
    ).toEqual({ key: "C1:1", replyTs: "1" })
  })

  test("a mapped thread keeps its own conversation", () => {
    expect(
      conversationKey({ channel: "C1", ts: "3", threadTs: "1", isDm: false }, (key) => key === "C1:1"),
    ).toEqual({ key: "C1:1", replyTs: "1" })
  })

  test("an engaged channel catches unmapped threads", () => {
    expect(
      conversationKey({ channel: "C1", ts: "4", isDm: false }, (key) => key === "C1:channel"),
    ).toEqual({ key: "C1:channel" })
  })

  test("a new top-level mention roots a thread at itself", () => {
    expect(
      conversationKey({ channel: "C1", ts: "5", isDm: false, engageChannel: true }, () => false),
    ).toEqual({ key: "C1:5", replyTs: "5" })
  })
})

describe("text helpers", () => {
  test("chunkText splits long input", () => {
    const chunks = chunkText("word ".repeat(2000), 1000)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1000)
  })

  test("formatCheckin includes steps and elapsed", () => {
    expect(formatCheckin(2, 12_000, "bash")).toBe("⏳ OpenCode working — 2 steps · 12s · last tool: `bash`")
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
