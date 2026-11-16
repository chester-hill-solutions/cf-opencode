import { describe, expect, it } from "vitest"
import worker from "../src/index"
import type { Env } from "../src/env"

const channel = "C0A5YNXLP6C", threadTs = "1794770000.000001", secret = "delegated-test-key"
function fixture() {
  const markers = new Set<string>(), effects: string[] = [], pending: Promise<unknown>[] = []
  const env = {
    SLACK_SIGNING_SECRET: secret, SLACK_CANARY_CHANNEL: channel,
    SLACK_CANARY_NEW_THREADS: "true", SLACK_CANARY_START_TS: "1794769999.000000",
    SETTINGS: { getByName() { return { async fetch(input: string, init?: RequestInit) {
      const path = new URL(input).pathname
      if (path !== "/slack/canary-thread") { effects.push("registry"); return Response.json({}) }
      const value = JSON.parse(String(init?.body)), key = `${value.channel}:${value.threadTs}`
      effects.push(value.action)
      if (value.action === "claim") markers.add(key)
      return Response.json({ owned: markers.has(key) })
    } } } },
    CONVERSATION: { getByName() { return { async fetch() { effects.push("dispatch"); return new Response("ok") } } } },
  } as unknown as Env
  const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p) } } as unknown as ExecutionContext
  return { env, ctx, markers, effects, async settle() { await Promise.all(pending) } }
}
async function request(path: string, event: Record<string, unknown>, valid = true) {
  const body = JSON.stringify({ type: "event_callback", event_id: "operator-test", event })
  const timestamp = String(Math.floor(Date.now() / 1000))
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`))
  const signature = "v0=" + [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, "0")).join("")
  return new Request("https://canary.test" + path, { method: "POST", body, headers: {
    "x-slack-request-timestamp": timestamp, "x-slack-signature": valid ? signature : "v0=invalid",
  } })
}
const root = { type: "app_mention", channel, ts: threadTs, user: "UOPERATOR", text: "!help" }

describe("signed canary ingress", () => {
  it("rejects invalid signatures before ownership or dispatch", async () => {
    const f = fixture()
    expect((await worker.fetch(await request("/slack/canary-route?kind=events", root, false), f.env, f.ctx)).status).toBe(401)
    expect(f.effects).toEqual([])
  })
  it("claims through a signed probe, then dispatches only the owned thread", async () => {
    const f = fixture()
    const probe = await worker.fetch(await request("/slack/canary-route?kind=events", root), f.env, f.ctx)
    expect(await probe.json()).toEqual({ route: "canary", channel, threadTs })
    expect(f.effects).toEqual(["lookup", "claim"])
    expect((await worker.fetch(await request("/slack/events", root), f.env, f.ctx)).status).toBe(200)
    await f.settle()
    expect(f.effects).toEqual(["lookup", "claim", "lookup", "registry", "dispatch"])
  })
  it("ignores direct unowned traffic and other channels before registry writes", async () => {
    const f = fixture()
    await worker.fetch(await request("/slack/events", root), f.env, f.ctx)
    await worker.fetch(await request("/slack/events", { ...root, channel: "COTHER" }), f.env, f.ctx)
    await f.settle()
    expect(f.effects).toEqual(["lookup"])
    expect(f.markers.size).toBe(0)
  })
  it("retains owned replies while new root adoption is disabled", async () => {
    const f = fixture()
    f.markers.add(`${channel}:${threadTs}`)
    f.env.SLACK_CANARY_NEW_THREADS = "false"
    f.env.SLACK_CANARY_START_TS = undefined
    const response = await worker.fetch(await request("/slack/canary-route?kind=events", { ...root, type: "message", thread_ts: threadTs, ts: "1794770001.000001" }), f.env, f.ctx)
    expect((await response.json() as { route: string }).route).toBe("canary")
    expect(f.effects).toEqual(["lookup"])
  })
})
