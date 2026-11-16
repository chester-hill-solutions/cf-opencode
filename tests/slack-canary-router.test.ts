import { expect, test } from "bun:test"
import { routeSlackCanary, type SlackCanaryRouterBindings } from "../scripts/slack-canary-release/router"
import { verifySlackSignature } from "../src/adapters/slack"
const channel = "C0A5YNXLP6C", ts = "1794780000.000001", secret = "delegation-test-only-" + "a".repeat(32)
const event = (extra = {}) => JSON.stringify({ type: "event_callback", event: { type: "app_mention", channel, ts, ...extra } })
const request = (path = "/slack/events") => new Request("https://legacy.example" + path, { method: "POST", headers: { "x-slack-signature": "v0=real-secret-signature-do-not-forward", "x-slack-retry-num": "1" } })
function setup(proof: unknown = { route: "canary", channel, threadTs: ts }, options: { status?: number; dispatch?: string; dispatchStatus?: number } = {}) {
  const seen: string[] = [], bodies: string[] = []
  const env: SlackCanaryRouterBindings = { SLACK_CANARY_CHANNEL: channel, SLACK_CANARY_SIGNING_SECRET: secret, SLACK_CANARY_ORIGIN: "https://isolated.example", SLACK_CANARY: { async fetch(req) {
    seen.push(req.url); bodies.push(await req.text())
    expect(req.headers.get("x-slack-signature")).not.toBe(request().headers.get("x-slack-signature"))
    expect(await verifySlackSignature({ signingSecret: secret, timestamp: req.headers.get("x-slack-request-timestamp"), signature: req.headers.get("x-slack-signature"), body: bodies.at(-1)! })).toBe(true)
    expect(req.headers.get("x-slack-retry-num")).toBe("1")
    return new URL(req.url).pathname === "/slack/canary-route" ? Response.json(proof, { status: options.status ?? 200 }) : new Response(options.dispatch ?? "ok", { status: options.dispatchStatus ?? 200, headers: { "content-type": "application/json" } })
  } } }
  return { env, seen, bodies }
}

test("exact channel canary event re-signs unchanged bytes without forwarding the production secret", async () => {
  const f = setup(), body = event()
  expect((await routeSlackCanary(request(), body, f.env))?.status).toBe(200)
  expect(f.bodies).toEqual([body, body])
  expect(f.seen).toEqual(["https://isolated.example/slack/canary-route?kind=events", "https://isolated.example/slack/events"])
})

test("other channels, URL verification and missing opt-in remain legacy without touching canary", async () => {
  const f = setup()
  for (const body of [event({ channel: "COLD" }), JSON.stringify({ type: "url_verification", challenge: "abc" })]) expect(await routeSlackCanary(request(), body, f.env)).toBeUndefined()
  expect(await routeSlackCanary(request(), event(), { ...f.env, SLACK_CANARY_CHANNEL: undefined })).toBeUndefined()
  expect(f.seen).toHaveLength(0)
})

test("unowned old threads preserve legacy dispatch, while owned replies use existing root marker", async () => {
  const old = setup({ route: "legacy", channel, threadTs: ts })
  expect(await routeSlackCanary(request(), event({ type: "message", thread_ts: ts }), old.env)).toBeUndefined()
  expect(old.seen).toHaveLength(1)
  const owned = setup()
  expect((await routeSlackCanary(request(), event({ type: "message", ts: "1794780001.000001", thread_ts: ts }), owned.env))?.status).toBe(200)
  expect(owned.seen).toHaveLength(2)
})

test("interactive owned thread proof preserves bounded ephemeral response", async () => {
  const body = new URLSearchParams({ payload: JSON.stringify({ channel: { id: channel }, actions: [{ value: JSON.stringify({ key: channel + ":" + ts }) }] }) }).toString()
  const f = setup(undefined, { dispatch: '{"response_type":"ephemeral","text":"permission denied"}' })
  const response = await routeSlackCanary(request("/slack/interactivity"), body, f.env)
  expect(response?.status).toBe(200)
  expect(await response?.json()).toEqual({ response_type: "ephemeral", text: "permission denied" })
  expect(f.seen[0]).toEndWith("?kind=interactivity")
})

test("unavailable, malformed or mismatched proofs never fall back or forward actual payload", async () => {
  for (const proof of [null, { route: "canary", channel: "COTHER", threadTs: ts }, { route: "canary", channel, threadTs: "2.3" }, { route: "legacy", channel: "COTHER", threadTs: ts }, { route: "legacy", channel: null, threadTs: ts }]) {
    const f = setup(proof)
    expect((await routeSlackCanary(request(), event(), f.env))?.status).toBe(503)
    expect(f.seen).toHaveLength(1)
  }
  const f = setup(undefined, { status: 503 })
  expect((await routeSlackCanary(request(), event(), f.env))?.status).toBe(503)
  expect((await routeSlackCanary(request(), event(), { ...f.env, SLACK_CANARY: undefined }))?.status).toBe(503)
  expect((await routeSlackCanary(request(), event(), { ...f.env, SLACK_CANARY_ORIGIN: "https://user:password@wrong.example" }))?.status).toBe(503)
})

test("dispatch failure and oversized output fail closed", async () => {
  const f = setup(undefined, { dispatchStatus: 503 })
  expect((await routeSlackCanary(request(), event(), f.env))?.status).toBe(503)
  const large = setup(undefined, { dispatch: "x".repeat(8193) })
  expect((await routeSlackCanary(request(), event(), large.env))?.status).toBe(503)
})

test("uncooperative probe has a bounded deadline and cannot later forward actual payload", async () => {
  let calls = 0
  const f = setup(), started = Date.now()
  const response = await routeSlackCanary(request(), event(), { ...f.env, SLACK_CANARY: { fetch: async () => { calls++; return await new Promise<Response>(() => {}) } } })
  expect(response?.status).toBe(503); expect(Date.now() - started).toBeLessThan(2000); expect(calls).toBe(1)
})
