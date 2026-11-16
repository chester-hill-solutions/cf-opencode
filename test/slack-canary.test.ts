import { beforeEach, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { handleSlackCanaryRoute, SLACK_CANARY_CHANNEL } from "../src/slack-canary"

const TS = "1794773000.000002"
beforeEach(async () => { await runInDurableObject(env.SETTINGS.getByName("global"), async (_instance, state) => state.storage.deleteAll()) })
async function ownership(action: "claim" | "lookup", channel = SLACK_CANARY_CHANNEL, threadTs = TS) {
  return env.SETTINGS.getByName("global").fetch("https://settings/slack/canary-thread", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, channel, threadTs }) })
}

it("Settings lookup is passive and concurrent claims retain one durable owner marker", async () => {
  expect(await (await ownership("lookup")).json()).toEqual({ owned: false })
  await runInDurableObject(env.SETTINGS.getByName("global"), async (_instance, state) => expect((await state.storage.list()).size).toBe(0))
  const claims = await Promise.all([ownership("claim"), ownership("claim")])
  for (const response of claims) expect(await response.json()).toEqual({ owned: true })
  await runInDurableObject(env.SETTINGS.getByName("global"), async (_instance, state) => {
    const rows = await state.storage.list()
    expect(rows.size).toBe(1)
    expect(rows.get(`slackCanaryThread:${SLACK_CANARY_CHANNEL}:${TS}`)).toMatchObject({ channel: SLACK_CANARY_CHANNEL, threadTs: TS })
  })
})

it("Settings corruption is unknown and cannot be overwritten into a valid ownership claim", async () => {
  const key = `slackCanaryThread:${SLACK_CANARY_CHANNEL}:${TS}`
  await runInDurableObject(env.SETTINGS.getByName("global"), async (_instance, state) => state.storage.put(key, { channel: "OTHER", threadTs: TS, claimedAt: 1 }))
  expect((await ownership("lookup")).status).toBe(503)
  expect((await ownership("claim")).status).toBe(503)
  await runInDurableObject(env.SETTINGS.getByName("global"), async (_instance, state) => expect(await state.storage.get(key)).toEqual({ channel: "OTHER", threadTs: TS, claimedAt: 1 }))
})

it("the routing helper observes real Settings persistence without touching a conversation/runtime", async () => {
  const body = JSON.stringify({ type: "event_callback", event: { type: "app_mention", channel: SLACK_CANARY_CHANNEL, ts: TS, user: "U123", text: "hello" } })
  const response = await handleSlackCanaryRoute(body, "events", { channel: SLACK_CANARY_CHANNEL, newThreads: "true", startTS: "1794773000.000001",
    ownership: async (action, channel, threadTs) => {
      const result = await ownership(action, channel, threadTs)
      if (!result.ok) throw new Error("unknown ownership")
      const value = await result.json() as { owned: boolean }
      return value.owned
    },
  })
  expect(await response.json()).toEqual({ route: "canary", channel: SLACK_CANARY_CHANNEL, threadTs: TS })
  expect(await (await ownership("lookup")).json()).toEqual({ owned: true })
})
