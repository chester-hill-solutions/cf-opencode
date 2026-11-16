import { afterEach, describe, expect, it, vi } from "vitest"
import worker from "../src/index"
import type { Env } from "../src/env"

const secret = "interaction-feedback-synthetic"
type SlackCall = { method: string; body: Record<string, unknown> }

async function setup(actionID: string, options: {
  result?: () => Promise<Response>
  members?: () => Promise<Response>
  update?: () => Promise<Response>
  value?: string | boolean
} = {}) {
  const slack: SlackCall[] = [], dispatches: Record<string, unknown>[] = [], pending: Promise<unknown>[] = []
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const method = new URL(request.url).pathname.split("/").at(-1)!
    if (method === "conversations.members") return options.members?.() ?? Response.json({ ok: true, members: ["U1"] })
    slack.push({ method, body: await request.json() })
    return method === "chat.update" && options.update ? options.update() : Response.json({ ok: true })
  })
  const env = {
    SLACK_SIGNING_SECRET: secret, SLACK_BOT_TOKEN: "synthetic-bot-token",
    CONVERSATION: { getByName: () => ({ fetch: async (_input: string, init?: RequestInit) => {
      dispatches.push(JSON.parse(String(init?.body)))
      return options.result?.() ?? Response.json({ ok: true })
    } }) },
  } as unknown as Env
  const form = actionID.startsWith("form_")
  const payload = {
    type: "block_actions", user: { id: "U1" }, channel: { id: "C1" },
    container: { type: "message", channel_id: "C1", message_ts: "12.345" },
    message: { ts: "12.345", text: "Choose how to proceed", blocks: [
      { type: "section", text: { type: "mrkdwn", text: "Choose how to proceed" } },
      { type: "actions", elements: [{ type: "button", action_id: actionID }] },
    ] },
    actions: [{ action_id: actionID, text: { type: "plain_text", text: "Fast" }, value: JSON.stringify({
      key: "C1:10.0", requestID: form ? "form1" : "perm1", channel: "C1",
      ...(form ? { sessionID: "ses1", field: "choice", value: options.value ?? "fast" } : {}),
    }) }],
  }
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString()
  const timestamp = String(Math.floor(Date.now() / 1000))
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`))
  const signature = "v0=" + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")
  return { slack, dispatches, pending,
    send: () => worker.fetch(new Request("https://test/slack/interactivity", { method: "POST", body, headers: {
      "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": timestamp, "x-slack-signature": signature,
    } }), env, { waitUntil: promise => { pending.push(promise) } } as ExecutionContext),
    settle: () => Promise.all(pending),
  }
}

afterEach(() => vi.unstubAllGlobals())

describe("Slack interaction feedback", () => {
  for (const action of ["form_answer", "form_cancel", "oc_perm_once", "oc_perm_always", "oc_perm_reject"]) {
    it(`removes ${action} controls only after the answer is accepted`, async () => {
      let accept!: (response: Response) => void
      const accepted = new Promise<Response>(resolve => { accept = resolve })
      const h = await setup(action, { result: () => accepted })
      expect((await h.send()).status).toBe(200)
      expect(h.slack.some(call => call.method === "chat.update")).toBe(false)
      accept(Response.json({ ok: true }))
      await h.settle()
      expect(h.dispatches).toHaveLength(1)
      const update = h.slack.find(call => call.method === "chat.update")
      expect(update?.body).toMatchObject({ channel: "C1", ts: "12.345" })
      expect(JSON.stringify(update?.body.blocks)).not.toContain('"type":"actions"')
      expect(JSON.stringify(update?.body)).toContain("Choose how to proceed")
    })
  }

  for (const [action, error, notice] of [
    ["form_answer", "stale question or wrong channel", "stale question"],
    ["oc_perm_once", "unknown request", "no longer pending"],
  ]) {
    it(`reports a rejected ${action} privately and leaves the buttons usable`, async () => {
      const h = await setup(action!, { result: async () => Response.json({ error }, { status: 409 }) })
      expect((await h.send()).status).toBe(200)
      await h.settle()
      expect(h.slack.some(call => call.method === "chat.update")).toBe(false)
      expect(h.slack).toContainEqual({ method: "chat.postEphemeral", body: expect.objectContaining({ channel: "C1", user: "U1", text: expect.stringContaining(notice!) }) })
    })
  }

  it("reports an ambiguous transport failure without retrying the answer or exposing upstream details", async () => {
    const h = await setup("form_answer", { result: async () => { throw new Error("synthetic-provider-secret") } })
    await h.send()
    await h.settle()
    expect(h.dispatches).toHaveLength(1)
    expect(h.slack.some(call => call.method === "chat.update")).toBe(false)
    expect(h.slack).toContainEqual({ method: "chat.postEphemeral", body: expect.objectContaining({ text: expect.stringContaining("could not be confirmed") }) })
    expect(JSON.stringify(h.slack)).not.toContain("synthetic-provider-secret")
  })

  it("does not mistake a failed card update for a failed answer", async () => {
    const h = await setup("form_answer", { update: async () => Response.json({ ok: false, error: "internal_error" }) })
    await h.send()
    await h.settle()
    expect(h.dispatches).toHaveLength(1)
    expect(h.slack).toContainEqual({ method: "chat.postEphemeral", body: expect.objectContaining({ text: expect.stringContaining("Your response was recorded") }) })
  })

  it("keeps false as a boolean answer and records the selected label", async () => {
    const h = await setup("form_answer", { value: false })
    await h.send()
    await h.settle()
    expect(h.dispatches).toEqual([expect.objectContaining({ value: false })])
    expect(h.slack).toContainEqual({ method: "chat.update", body: expect.objectContaining({ text: expect.stringContaining("Answered: Fast") }) })
  })

  it("cannot dispatch or retire controls for a nonmember", async () => {
    const h = await setup("form_answer", { members: async () => Response.json({ ok: true, members: ["U2"] }) })
    await h.send()
    await h.settle()
    expect(h.dispatches).toHaveLength(0)
    expect(h.slack.map(call => call.method)).toEqual(["chat.postEphemeral"])
  })

  it("requires an affirmative application acknowledgement before showing success", async () => {
    const h = await setup("oc_perm_once", { result: async () => Response.json({ ok: false, error: "synthetic-provider-secret" }) })
    await h.send()
    await h.settle()
    expect(h.slack.map(call => call.method)).toEqual(["chat.postEphemeral"])
    expect(JSON.stringify(h.slack)).not.toContain("synthetic-provider-secret")
  })

  it("acknowledges the click before a slow membership lookup finishes", async () => {
    let release!: (response: Response) => void
    const members = new Promise<Response>(resolve => { release = resolve })
    const h = await setup("form_answer", { members: () => members })
    let acknowledged = false
    const response = h.send().then(value => { acknowledged = true; return value })
    await new Promise(resolve => setTimeout(resolve, 20))
    const acknowledgedBeforeLookup = acknowledged
    release(Response.json({ ok: true, members: ["U1"] }))
    await response
    await h.settle()
    expect(acknowledgedBeforeLookup).toBe(true)
  })
})
