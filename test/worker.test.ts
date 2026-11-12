import { describe, expect, it } from "vitest"
import { env, runInDurableObject, SELF } from "cloudflare:test"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"

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

  it("serves the model catalogue with a token", async () => {
    const res = await SELF.fetch(`${BASE}/api/models`, { headers: API })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { models: Array<{ ref: string }>; recommended: string }
    expect(data.models.length).toBeGreaterThan(0)
    expect(data.recommended).toContain("/")
  })

  it("serves settings with a token", async () => {
    const res = await SELF.fetch(`${BASE}/api/settings`, { headers: API })
    expect(res.status).toBe(200)
    const settings = (await res.json()) as { model: string; pollSeconds: number; version: number }
    expect(settings.model).toContain("/")
    expect(settings.pollSeconds).toBeGreaterThanOrEqual(2)
    expect(settings.version).toBe(1)
  })

  it("rejects invalid settings", async () => {
    const res = await SELF.fetch(`${BASE}/api/settings`, {
      method: "PUT",
      headers: { ...API, "content-type": "application/json" },
      body: JSON.stringify({ model: "not-a-model" }),
    })
    expect(res.status).toBe(400)
  })

  it("saves settings and bumps the version", async () => {
    const res = await SELF.fetch(`${BASE}/api/settings`, {
      method: "PUT",
      headers: { ...API, "content-type": "application/json" },
      body: JSON.stringify({ pollSeconds: 5 }),
    })
    expect(res.status).toBe(200)
    const settings = (await res.json()) as { pollSeconds: number; version: number }
    expect(settings.pollSeconds).toBe(5)
    expect(settings.version).toBe(2)
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

  it("returns 400 for a signed malformed Slack event instead of throwing", async () => {
    const body = "{not-json"
    const res = await SELF.fetch(`${BASE}/slack/events`, { method: "POST", headers: await signed(body), body })
    expect(res.status).toBe(400)
    expect(await res.text()).toBe("invalid json")
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

  it("returns 400 for a malformed conversation key instead of throwing", async () => {
    const res = await SELF.fetch(`${BASE}/api/conversations/%E0%A4%A`, { headers: API })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: "invalid conversation key" })
  })

  it("returns 400 for a malformed permission id instead of throwing", async () => {
    const res = await SELF.fetch(`${BASE}/api/conversations/demo/permissions/%E0%A4%A`, {
      method: "POST",
      headers: { ...API, "content-type": "application/json" },
      body: JSON.stringify({ decision: "once" }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: "invalid request id" })
  })

  it("rejects a non-string message body", async () => {
    const res = await SELF.fetch(`${BASE}/api/conversations/demo/messages`, {
      method: "POST",
      headers: { ...API, "content-type": "application/json" },
      body: JSON.stringify({ text: 123 }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: "empty message" })
  })

  it("rejects consumed invalid JSON before recording conversations or changing settings", async () => {
    const key = `invalid-json-${crypto.randomUUID()}`
    const malformed = await SELF.fetch(`${BASE}/api/conversations/${key}/messages`, {
      method: "POST", headers: { ...API, "content-type": "application/json" }, body: "{",
    })
    const nullBody = await SELF.fetch(`${BASE}/api/conversations/${key}/messages`, {
      method: "POST", headers: { ...API, "content-type": "application/json" }, body: "null",
    })
    const arrayBody = await SELF.fetch(`${BASE}/api/conversations/${key}/permissions/req-1`, {
      method: "POST", headers: { ...API, "content-type": "application/json" }, body: "[]",
    })
    const badField = await SELF.fetch(`${BASE}/api/conversations/${key}/messages`, {
      method: "POST", headers: { ...API, "content-type": "application/json" }, body: JSON.stringify({ text: "hi", user: 7 }),
    })
    const badIdempotencyKey = await SELF.fetch(`${BASE}/api/conversations/${key}/messages`, {
      method: "POST", headers: { ...API, "content-type": "application/json" }, body: JSON.stringify({ text: "hi", idempotencyKey: "bad key" }),
    })
    const numberText = await SELF.fetch(`${BASE}/api/conversations/${key}/messages`, {
      method: "POST", headers: { ...API, "content-type": "application/json" }, body: JSON.stringify({ text: 123 }),
    })
    const blankText = await SELF.fetch(`${BASE}/api/conversations/${key}/messages`, {
      method: "POST", headers: { ...API, "content-type": "application/json" }, body: JSON.stringify({ text: "  " }),
    })
    const missingText = await SELF.fetch(`${BASE}/api/conversations/${key}/messages`, {
      method: "POST", headers: { ...API, "content-type": "application/json" }, body: JSON.stringify({}),
    })
    expect([malformed.status, nullBody.status, arrayBody.status, badField.status, badIdempotencyKey.status, numberText.status, blankText.status, missingText.status]).toEqual([400, 400, 400, 400, 400, 400, 400, 400])
    expect(await numberText.json()).toMatchObject({ error: "empty message" })
    expect(await blankText.json()).toMatchObject({ error: "empty message" })
    expect(await missingText.json()).toMatchObject({ error: "text is required" })
    const conversations = await SELF.fetch(`${BASE}/api/conversations`, { headers: API })
    expect((await conversations.json() as { conversations: Array<{ key: string }> }).conversations.map((item) => item.key)).not.toContain(key)

    const beforeResponse = await SELF.fetch(`${BASE}/api/settings`, { headers: API })
    const before = await beforeResponse.json() as { version: number }
    for (const body of ["{", "null", "[]", JSON.stringify({ model: "bad" })]) {
      const invalidSettings = await SELF.fetch(`${BASE}/api/settings`, {
        method: "PUT", headers: { ...API, "content-type": "application/json" }, body,
      })
      expect(invalidSettings.status).toBe(400)
    }
    const afterResponse = await SELF.fetch(`${BASE}/api/settings`, { headers: API })
    const after = await afterResponse.json() as { version: number }
    expect(after.version).toBe(before.version)

    const invalidIntegration = await SELF.fetch(`${BASE}/api/onboarding/opencode/integrations/provider/connect/key`, {
      method: "POST", headers: { ...API, "content-type": "application/json" }, body: "[]",
    })
    expect(invalidIntegration.status).toBe(400)
  })

  it("rejects invalid integration bodies before transport and forwards valid JSON unchanged", async () => {
    const transportLog: { calls: number; integrationBodies: string[] } = {
      calls: 0,
      integrationBodies: [],
    }
    const stub = env.CONVERSATION.getByName("onboarding")
    await runInDurableObject(stub, async (instance) => {
      instance.transport = (port) => ({
        async fetch(input) {
          const request = input instanceof Request ? input : new Request(input)
          const path = new URL(request.url).pathname
          transportLog.calls++
          if (port === 4001 && path === "/status") {
            return Response.json({ initialized: true })
          }
          if (port === 4001 && path === "/configure") return Response.json({ ok: true })
          if (port === 4001 && path === "/start") return Response.json(accountingPolicyStart)
          if (port !== 4001 && path === "/api/config") return Response.json(accountingPolicyConfig)
          if (path.startsWith("/integrations/")) {
            transportLog.integrationBodies.push(await request.text())
          }
          return Response.json({ ok: true })
        },
      })
    })

    for (const body of ["{", "null", "[]"]) {
      const response = await SELF.fetch(`${BASE}/api/onboarding/opencode/integrations/provider/connect/key`, {
        method: "POST",
        headers: { ...API, "content-type": "application/json" },
        body,
      })
      expect(response.status).toBe(400)
    }
    expect(transportLog.calls).toBe(0)

    const originalBody = '{"apiKey":"secret-value","providerExtension":{"region":"test","flag":true}}'
    const validResponse = await SELF.fetch(`${BASE}/api/onboarding/opencode/integrations/provider/connect/key`, {
      method: "POST",
      headers: { ...API, "content-type": "application/json" },
      body: originalBody,
    })
    expect(validResponse.status).toBe(200)
    expect(transportLog.integrationBodies).toEqual([originalBody])
    expect(transportLog.calls).toBeGreaterThan(0)
  })

  it("does not expose control-plane routes through the onboarding proxy", async () => {
    for (const path of ["configure", "start", "restore", "seed-state", "checkpoint"]) {
      const res = await SELF.fetch(`${BASE}/api/onboarding/opencode/${path}`, {
        method: "POST",
        headers: { ...API, "content-type": "application/json" },
        body: "{}",
      })
      expect(res.status).toBe(404)
    }
  })

  it("rejects encoded traversal in the onboarding proxy", async () => {
    const res = await SELF.fetch(`${BASE}/api/onboarding/opencode/%2e%2e/configure`, {
      method: "POST",
      headers: { ...API, "content-type": "application/json" },
      body: "{}",
    })
    expect(res.status).toBe(404)
  })
})
