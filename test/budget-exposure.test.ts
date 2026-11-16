import { beforeEach, describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"

const settings = () => env.SETTINGS.getByName("global")
const today = () => new Date().toISOString().slice(0, 10)

async function post(path: string, body: unknown): Promise<Response> {
  return settings().fetch(`https://settings${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function reset(): Promise<void> {
  await runInDurableObject(settings(), async (_instance, state) => state.storage.deleteAll())
  const configured = await post("/put", { dailyBudgetUSD: 0.1 })
  expect(configured.ok).toBe(true)
}

describe("budget admission and actual usage exposure", () => {
  beforeEach(reset)

  it("records sourced actual usage above a hold and rejects the next reservation", async () => {
    const firstHold = await post("/usage/reserve", {
      conversationID: "conversationA",
      reservationID: "hold-a",
      costUSD: 0.1,
    })
    expect(firstHold.status).toBe(200)

    const report = await post("/usage", {
      conversationID: "conversationA",
      sessionID: "session-a",
      sourceID: "synthetic-assistant-message-a",
      date: today(),
      costUSD: 5,
      input: 12,
      output: 4,
    })
    expect(report.status).toBe(200)
    expect(await report.json()).toMatchObject({ ok: true, costUSD: 5 })

    const actual = await settings().fetch("https://settings/usage/today")
    expect(await actual.json()).toMatchObject({ costUSD: 5 })

    const secondHold = await post("/usage/reserve", {
      conversationID: "conversationB",
      reservationID: "hold-b",
      costUSD: 0.1,
    })
    expect(secondHold.status).toBe(429)
  })
})
