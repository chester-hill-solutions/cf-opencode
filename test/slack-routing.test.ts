import { afterEach, describe, expect, it, vi } from "vitest"
import worker from "../src/index"
import type { Env } from "../src/env"

const SECRET = "test-secret"

async function signature(body: string, timestamp = String(Math.floor(Date.now() / 1000))): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`))
  return `v0=${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

function harness(options: { binding?: { tenant_id: string; agent_id: string } | null } = {}) {
  const calls: Array<{ key: string; path: string; body: Record<string, unknown> }> = []
  const pending: Promise<unknown>[] = []
  const env = {
    SLACK_SIGNING_SECRET: SECRET,
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_BOT_USER_ID: "UBOT",
    ...(options.binding !== undefined ? {
      TENANCY: {
        prepare: () => ({ bind: () => ({ first: async () => options.binding }) }),
      },
    } : {}),
    CONVERSATION: {
      getByName(name: string) {
        return {
          async fetch(input: string | URL | Request, init?: RequestInit) {
            const request = input instanceof Request ? input : new Request(input, init)
            calls.push({
              key: request.headers.get("x-conversation-key") ?? name,
              path: new URL(request.url).pathname,
              body: await request.clone().json() as Record<string, unknown>,
            })
            return new Response("ok")
          },
        }
      },
    },
  } as unknown as Env
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext
  return { env, ctx, calls, settle: () => Promise.all(pending) }
}

async function sendEvent(event: Record<string, unknown>, eventID: string) {
  const state = harness()
  const body = JSON.stringify({ type: "event_callback", team_id: "T1", event_id: eventID, event })
  const timestamp = String(Math.floor(Date.now() / 1000))
  const response = await worker.fetch(new Request("https://harness.test/slack/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": await signature(body, timestamp),
    },
    body,
  }), state.env, state.ctx)
  await state.settle()
  return { response, calls: state.calls }
}

async function sendAction(payload: Record<string, unknown>, opts: Parameters<typeof harness>[0] = {}) {
  const state = harness(opts)
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString()
  const timestamp = String(Math.floor(Date.now() / 1000))
  const response = await worker.fetch(new Request("https://harness.test/slack/interactivity", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": await signature(body, timestamp),
    },
    body,
  }), state.env, state.ctx)
  await state.settle()
  return { response, calls: state.calls }
}

function formPayload(actionID: "form_answer" | "form_cancel", opts: {
  channel?: string
  buttonChannel?: string
  user?: string
  key?: string
} = {}) {
  return {
    type: "block_actions",
    team: { id: "T1" },
    channel: { id: opts.channel ?? "C1" },
    ...(opts.user === undefined ? {} : { user: { id: opts.user } }),
    actions: [{
      action_id: actionID,
      value: JSON.stringify({
        key: opts.key ?? "C1:10.0",
        requestID: "form_123",
        channel: opts.buttonChannel ?? "C1",
        sessionID: "ses_456",
        ...(actionID === "form_answer" ? { field: "choice", value: "fast" } : {}),
      }),
    }],
  }
}

function membersResponse(result: { ok: boolean; members?: string[] }) {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(result), {
    headers: { "content-type": "application/json" },
  }))
}

afterEach(() => vi.unstubAllGlobals())

describe("signed Slack event routing", () => {
  it("ignores bot, subtype, self, top-level channel messages, and mention text on message events", async () => {
    const ignored = [
      { type: "message", channel: "C1", ts: "1", bot_id: "B1", text: "bot" },
      { type: "message", channel: "C1", ts: "2", subtype: "message_changed", text: "edit" },
      { type: "message", channel: "C1", ts: "3", user: "UBOT", text: "self" },
      { type: "message", channel: "C1", ts: "4", user: "U1", text: "ordinary channel message" },
      { type: "message", channel: "C1", ts: "5", user: "U1", text: "<@UBOT> duplicate mention event" },
    ]
    for (const [index, event] of ignored.entries()) {
      const { response, calls } = await sendEvent(event, `ignored-${index}`)
      expect(response.status).toBe(200)
      expect(calls).toEqual([])
    }
  })

  it("accepts app mentions, DMs, and threaded followups", async () => {
    const mentioned = await sendEvent({ type: "app_mention", channel: "C1", ts: "10", text: "<@UBOT> hi" }, "mention")
    expect(mentioned.calls).toContainEqual(expect.objectContaining({ key: "C1:10", path: "/slack" }))

    const dm = await sendEvent({ type: "message", channel: "D1", channel_type: "im", ts: "11", text: "hello" }, "dm")
    expect(dm.calls).toContainEqual(expect.objectContaining({ key: "D1:dm", path: "/slack" }))

    const followup = await sendEvent({ type: "message", channel: "C1", ts: "12", thread_ts: "10", text: "follow up" }, "thread")
    expect(followup.calls).toContainEqual(expect.objectContaining({ key: "C1:10", path: "/slack" }))
  })
})

describe("Slack form action routing", () => {
  it("verifies channel membership and forwards an answer to /form, never /permission", async () => {
    membersResponse({ ok: true, members: ["U1", "U2"] })
    const { response, calls } = await sendAction(formPayload("form_answer", { user: "U1" }))
    expect(response.status).toBe(200)
    expect(calls).toEqual([{
      key: "C1:10.0",
      path: "/form",
      body: { sessionID: "ses_456", formID: "form_123", channel: "C1", field: "choice", value: "fast" },
    }])
  })

  it("forwards cancel as a cancel action after membership verification", async () => {
    membersResponse({ ok: true, members: ["U1"] })
    const { calls } = await sendAction(formPayload("form_cancel", { user: "U1" }))
    expect(calls).toEqual([{
      key: "C1:10.0",
      path: "/form",
      body: { sessionID: "ses_456", formID: "form_123", channel: "C1", cancel: true },
    }])
  })

  it("blocks wrong channel, missing user, and unverifiable membership", async () => {
    membersResponse({ ok: true, members: ["U1"] })
    const wrongChannel = await sendAction(formPayload("form_answer", { user: "U1", channel: "C1", buttonChannel: "C2" }))
    expect(wrongChannel.calls).toEqual([])

    const missingUser = await sendAction(formPayload("form_answer"))
    expect(missingUser.calls).toEqual([])

    membersResponse({ ok: false })
    const unavailable = await sendAction(formPayload("form_cancel", { user: "U1" }))
    expect(unavailable.calls).toEqual([])
  })

  it("blocks a stale button whose conversation key belongs to another tenant", async () => {
    membersResponse({ ok: true, members: ["U1"] })
    const { response, calls } = await sendAction(formPayload("form_answer", {
      user: "U1", key: "tenant:t1:agent:a1:C1:10.0",
    }), { binding: { tenant_id: "t2", agent_id: "a2" } })
    expect(response.status).toBe(200)
    expect(calls).toEqual([])
    expect(await response.json()).toMatchObject({ response_type: "ephemeral" })
  })
})
