import { describe, expect, it } from "vitest"
import worker from "../src/index"
import type { Env } from "../src/env"

/**
 * Route-level coverage for the Slack adapters: the signature gate, the
 * interactivity decision mapping, and the conversation key each event uses.
 */

const SECRET = "test-secret"

async function sign(body: string, timestamp = String(Math.floor(Date.now() / 1000))): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${body}`))
  return `v0=${Array.from(new Uint8Array(mac)).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

function harness() {
  const calls: Array<{ key: string; path: string; body: Record<string, unknown> }> = []
  const pending: Promise<unknown>[] = []
  const env = {
    SLACK_SIGNING_SECRET: SECRET,
    CONVERSATION: {
      getByName(name: string) {
        return {
          async fetch(input: string, init?: RequestInit) {
            calls.push({
              key: name,
              path: new URL(input).pathname,
              body: JSON.parse(String(init?.body)) as Record<string, unknown>,
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

describe("Slack interactivity", () => {
  it("forwards an allow decision with the conversation key", async () => {
    const { env, ctx, calls, settle } = harness()
    const payload = JSON.stringify({
      type: "block_actions",
      actions: [
        {
          action_id: "oc_perm_always",
          value: JSON.stringify({ key: "C1:dm", requestID: "req_1" }),
        },
      ],
    })
    const body = new URLSearchParams({ payload }).toString()
    const timestamp = String(Math.floor(Date.now() / 1000))
    const response = await worker.fetch(
      new Request("https://harness.test/slack/interactivity", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": await sign(body, timestamp),
        },
        body,
      }),
      env,
      ctx,
    )
    await settle()

    expect(response.status).toBe(200)
    expect(calls).toEqual([
      { key: "C1:dm", path: "/permission", body: { requestID: "req_1", decision: "always" } },
    ])
  })

  it("rejects a bad signature without dispatching", async () => {
    const { env, ctx, calls, settle } = harness()
    const body = new URLSearchParams({ payload: JSON.stringify({ type: "block_actions", actions: [] }) }).toString()
    const response = await worker.fetch(
      new Request("https://harness.test/slack/interactivity", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
          "x-slack-signature": "v0=bad",
        },
        body,
      }),
      env,
      ctx,
    )
    await settle()

    expect(response.status).toBe(401)
    expect(calls).toEqual([])
  })
})

describe("Slack event routing", () => {
  async function dispatch(event: Record<string, unknown>, eventID: string) {
    const { env, ctx, calls, settle } = harness()
    const body = JSON.stringify({ type: "event_callback", event_id: eventID, event })
    const timestamp = String(Math.floor(Date.now() / 1000))
    const response = await worker.fetch(
      new Request("https://harness.test/slack/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": await sign(body, timestamp),
        },
        body,
      }),
      env,
      ctx,
    )
    await settle()
    return { status: response.status, calls }
  }

  it("uses one conversation per DM and replies without a thread", async () => {
    const { status, calls } = await dispatch(
      { type: "message", channel: "D1", channel_type: "im", ts: "10", text: "hello" },
      "evt_dm",
    )
    expect(status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ key: "D1:dm", path: "/slack" })
    expect(calls[0]!.body).not.toHaveProperty("replyTs")
  })

  it("uses the thread root for a threaded mention", async () => {
    const { calls } = await dispatch(
      { type: "app_mention", channel: "C1", ts: "11", thread_ts: "10", text: "<@UBOT> hello" },
      "evt_thread",
    )
    expect(calls[0]).toMatchObject({ key: "C1:10", path: "/slack" })
    expect(calls[0]!.body.replyTs).toBe("10")
  })

  it("roots a top-level mention at its own timestamp", async () => {
    const { calls } = await dispatch(
      { type: "app_mention", channel: "C1", ts: "12", text: "<@UBOT> hello" },
      "evt_top",
    )
    expect(calls[0]).toMatchObject({ key: "C1:12", path: "/slack" })
    expect(calls[0]!.body.replyTs).toBe("12")
  })
})
