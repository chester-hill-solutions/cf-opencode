import { describe, expect, it } from "vitest"
import { SELF } from "cloudflare:test"

const BASE = "https://harness.test"
const API = { authorization: "Bearer test-token" }

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

async function signed(body: string, secret = "test-secret") {
  const timestamp = String(Math.floor(Date.now() / 1000))
  return {
    "content-type": "application/json",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": await sign(secret, timestamp, body),
  }
}

describe("worker surface", () => {
  it("answers health", async () => {
    const res = await SELF.fetch(`${BASE}/health`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("ok")
  })

  it("rejects API requests without a token", async () => {
    const res = await SELF.fetch(`${BASE}/api/conversations/demo`)
    expect(res.status).toBe(401)
  })

  it("returns conversation state with a token", async () => {
    const res = await SELF.fetch(`${BASE}/api/conversations/demo`, { headers: API })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ seen: [], pending: {} })
  })

  it("rejects invalid conversation keys", async () => {
    const res = await SELF.fetch(`${BASE}/api/conversations/${encodeURIComponent("bad key!")}`, { headers: API })
    expect(res.status).toBe(400)
  })

  it("answers the Slack url_verification challenge", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" })
    const res = await SELF.fetch(`${BASE}/slack/events`, { method: "POST", headers: await signed(body), body })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ challenge: "abc123" })
  })

  it("rejects a bad Slack signature", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" })
    const headers = await signed(body, "wrong-secret")
    const res = await SELF.fetch(`${BASE}/slack/events`, { method: "POST", headers, body })
    expect(res.status).toBe(401)
  })

  it("accepts a signed Slack event and routes it", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "evt_bot_1",
      event: { type: "message", channel: "C1", ts: "1", bot_id: "B1", text: "ignore me" },
    })
    const res = await SELF.fetch(`${BASE}/slack/events`, { method: "POST", headers: await signed(body), body })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("ok")
  })

  it("serves an SSE stream", async () => {
    const res = await SELF.fetch(`${BASE}/api/conversations/demo/events`, { headers: API })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    await res.body?.cancel()
  })

  it("rejects interactivity with an unknown action", async () => {
    const payload = JSON.stringify({ type: "block_actions", actions: [{ action_id: "nope", value: "{}" }] })
    const body = new URLSearchParams({ payload }).toString()
    const timestamp = String(Math.floor(Date.now() / 1000))
    const signature = await sign("test-secret", timestamp, body)
    const res = await SELF.fetch(`${BASE}/slack/interactivity`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body,
    })
    expect(res.status).toBe(200)
  })
})
