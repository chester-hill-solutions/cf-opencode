import { expect, test } from "bun:test"
import { handleSlackCanaryRoute, SLACK_CANARY_CHANNEL, type SlackCanaryOptions } from "../src/slack-canary"

const TS = "1794773000.000002", START = "1794773000.000001"
const event = (changes: Record<string, unknown> = {}) => JSON.stringify({ type: "event_callback", event_id: "EV1", event: { type: "app_mention", channel: SLACK_CANARY_CHANNEL, ts: TS, user: "U123", text: "<@UBOT> !repo", ...changes } })
function fixture() {
  const owned = new Set<string>(), calls: string[][] = []
  const options: SlackCanaryOptions = { channel: SLACK_CANARY_CHANNEL, newThreads: "true", startTS: START, botUserID: "UBOT",
    ownership: async (action, channel, threadTs) => { calls.push([action, channel, threadTs]); if (action === "claim") owned.add(threadTs); return owned.has(threadTs) },
  }
  return { owned, calls, options }
}
const interaction = (options: { thread?: string; key?: string; channel?: string } = {}) => new URLSearchParams({ payload: JSON.stringify({ type: "block_actions", channel: { id: options.channel ?? SLACK_CANARY_CHANNEL }, message: { ts: "1794773001.000000", ...(options.thread ? { thread_ts: options.thread } : {}) }, actions: [{ action_id: "oc_perm_once", value: JSON.stringify({ key: options.key ?? `${SLACK_CANARY_CHANNEL}:${TS}`, channel: options.channel ?? SLACK_CANARY_CHANNEL, requestID: "permission-1" }) }] }) }).toString()

test("new root mentions claim once and await ownership persistence before acknowledging", async () => {
  const f = fixture()
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), waiting = new Promise<void>(resolve => { entered = resolve })
  const original = f.options.ownership
  f.options.ownership = async (action, channel, threadTs) => { if (action === "claim") { entered(); await held }; return original(action, channel, threadTs) }
  let settled = false
  const response = handleSlackCanaryRoute(event(), "events", f.options).then(value => { settled = true; return value })
  await waiting
  expect(settled).toBe(false)
  expect(f.owned.has(TS)).toBe(false)
  release()
  expect(await (await response).json()).toEqual({ route: "canary", channel: SLACK_CANARY_CHANNEL, threadTs: TS })
  await handleSlackCanaryRoute(event(), "events", f.options)
  expect(f.calls.filter(([action]) => action === "claim")).toHaveLength(1)
})

test("old thread replies and mentions are lookup-only; unrelated root messages, bots and subtypes are never adopted", async () => {
  const f = fixture()
  for (const type of ["message", "app_mention"]) {
    const response = await handleSlackCanaryRoute(event({ type, thread_ts: "1794700000.000001" }), "events", f.options)
    expect(await response.json()).toEqual({ route: "legacy", channel: SLACK_CANARY_CHANNEL, threadTs: "1794700000.000001" })
  }
  expect(f.calls.every(([action]) => action === "lookup")).toBe(true)
  const before = f.calls.length
  for (const changes of [{ type: "message" }, { bot_id: "B123" }, { user: "UBOT" }, { subtype: "file_share", files: [] }, { subtype: "message_changed" }, { channel: "C_OTHER" }, { channel_type: "im" }]) {
    expect(await (await handleSlackCanaryRoute(event(changes), "events", f.options)).json()).toEqual({ route: "legacy", channel: null, threadTs: null })
  }
  expect(f.calls).toHaveLength(before)
  // Files on an ordinary app_mention remain eligible; no special subtype is adopted.
  expect((await handleSlackCanaryRoute(event({ files: [{ id: "F1" }] }), "events", f.options)).status).toBe(200)
  expect(f.owned.has(TS)).toBe(true)
  const beforeImage = f.calls.length
  expect(await (await handleSlackCanaryRoute(event({ type: "message", thread_ts: TS, ts: "1794773001.000000", subtype: "file_share", files: [{ id: "F1" }] }), "events", f.options)).json()).toEqual({ route: "canary", channel: SLACK_CANARY_CHANNEL, threadTs: TS })
  expect(f.calls.slice(beforeImage)).toEqual([["lookup", SLACK_CANARY_CHANNEL, TS]])
})

test("cutover is exact and mandatory for new roots, while drain preserves already owned threads", async () => {
  const f = fixture()
  const old = await handleSlackCanaryRoute(event({ ts: "1794773000.000000" }), "events", f.options)
  expect((await old.json() as { route: string }).route).toBe("legacy")
  expect(f.calls.some(([action]) => action === "claim")).toBe(false)
  for (const startTS of [undefined, "not-a-timestamp"]) {
    expect((await handleSlackCanaryRoute(event(), "events", { ...f.options, startTS })).status).toBe(503)
  }
  f.owned.add(TS)
  expect((await (await handleSlackCanaryRoute(event(), "events", { ...f.options, newThreads: "false", startTS: undefined })).json() as { route: string }).route).toBe("canary")
  f.owned.clear()
  expect((await (await handleSlackCanaryRoute(event(), "events", { ...f.options, newThreads: "false" })).json() as { route: string }).route).toBe("legacy")
  // BigInt comparison avoids rounding a pre-cutover microsecond into equality.
  expect((await (await handleSlackCanaryRoute(event({ ts: "9999999999999.000001" }), "events", { ...f.options, startTS: "9999999999999.000002" })).json() as { route: string }).route).toBe("legacy")
})

test("buttons use matching thread or embedded conversation key, never the bot message timestamp", async () => {
  const f = fixture(); f.owned.add(TS)
  for (const body of [interaction({ thread: TS }), interaction(), interaction({ key: `tenant:tenant1:agent:agent1:${SLACK_CANARY_CHANNEL}:${TS}` })]) {
    expect(await (await handleSlackCanaryRoute(body, "interactivity", f.options)).json()).toEqual({ route: "canary", channel: SLACK_CANARY_CHANNEL, threadTs: TS })
  }
  expect(f.calls.every(([action, , thread]) => action === "lookup" && thread === TS)).toBe(true)
  const calls = f.calls.length
  for (const body of [interaction({ thread: "1794773001.000000" }), interaction({ key: "C_OTHER:" + TS }), interaction() + "&payload={}"]) {
    expect((await handleSlackCanaryRoute(body, "interactivity", f.options)).status).toBe(400)
  }
  expect(f.calls).toHaveLength(calls)
})

test("unknown ownership, missing claim acknowledgement and stalled probes fail closed", async () => {
  const f = fixture()
  expect((await handleSlackCanaryRoute(event(), "events", { ...f.options, ownership: async () => { throw new Error("PRIVATE") } })).status).toBe(503)
  expect((await handleSlackCanaryRoute(event(), "events", { ...f.options, ownership: async () => false })).status).toBe(503)
  const start = Date.now()
  const stalled = await handleSlackCanaryRoute(event(), "events", { ...f.options, ownership: async () => new Promise<boolean>(() => {}) })
  expect(stalled.status).toBe(503)
  expect(Date.now() - start).toBeLessThan(2000)
  expect(await stalled.text()).not.toContain("PRIVATE")
  expect((await handleSlackCanaryRoute(event(), "events", { ...f.options, channel: "OTHER" })).status).toBe(503)
  expect((await handleSlackCanaryRoute(event(), "unknown", f.options)).status).toBe(400)
  expect((await handleSlackCanaryRoute("x".repeat(256 * 1024 + 1), "events", f.options)).status).toBe(400)
})
