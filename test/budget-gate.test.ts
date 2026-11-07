import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"

/**
 * The daily budget is a ceiling for every transport. HTTP checked it; Slack
 * and queue drains did not, so the main interface bypassed the safety setting.
 */

function fakeContainer() {
  const counters = { prompts: 0 }
  const transport = (port: number) => ({
    async fetch(input: Request | string | URL): Promise<Response> {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      )
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        })

      if (port === 4001) {
        if (url.pathname === "/status") return json({ initialized: true })
        if (url.pathname === "/configure" || url.pathname === "/start") return json({ ok: true })
        if (url.pathname === "/checkpoint") return new Response(null, { status: 204 })
        return json({ error: "not found" }, 404)
      }

      if (url.pathname === "/api/session") return json({ data: { id: "ses_1" } })
      if (url.pathname === "/api/session/ses_1/model") return new Response(null, { status: 204 })
      if (url.pathname === "/api/session/ses_1/prompt") {
        counters.prompts++
        return json({ data: {} })
      }
      if (url.pathname === "/api/session/ses_1/context") return json({ data: [] })
      if (url.pathname === "/api/session/ses_1/permission") return json({ data: [] })
      if (url.pathname === "/api/event") {
        return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } })
      }
      return json({ error: "not found" }, 404)
    },
  })
  return { transport, counters }
}

const settings = () => env.SETTINGS.getByName("global")

async function spendOverBudget(): Promise<void> {
  await runInDurableObject(settings(), async (_instance, state) => {
    await state.storage.deleteAll()
  })
  const configured = await settings().fetch("https://settings/put", {
    method: "POST",
    body: JSON.stringify({ streaming: false, dailyBudgetUSD: 1 }),
  })
  expect(configured.ok).toBe(true)
  const today = new Date().toISOString().slice(0, 10)
  await settings().fetch("https://settings/usage", {
    method: "POST",
    body: JSON.stringify({ conversationID: "other", date: today, costUSD: 5 }),
  })
}

describe("daily budget admission", () => {
  it("refuses a Slack mention after the budget is spent", async () => {
    await spendOverBudget()
    const stub = env.CONVERSATION.getByName("C1:slack-budget")
    const result = await runInDurableObject(stub, async (instance) => {
      const fake = fakeContainer()
      instance.transport = fake.transport
      const response = await instance.fetch(
        new Request("https://conversation/slack", {
          method: "POST",
          body: JSON.stringify({
            eventID: "evt_budget",
            replyTs: "1",
            event: {
              type: "app_mention",
              channel: "C1",
              ts: "1",
              text: "<@UBOT> hello",
            },
          }),
        }),
      )
      return { status: response.status, prompts: fake.counters.prompts }
    })

    expect(result.status).toBe(200)
    expect(result.prompts).toBe(0)
  })

  it("refuses an HTTP message after the budget is spent", async () => {
    await spendOverBudget()
    const stub = env.CONVERSATION.getByName("C1:http-budget")
    const result = await runInDurableObject(stub, async (instance) => {
      const fake = fakeContainer()
      instance.transport = fake.transport
      const response = await instance.fetch(
        new Request("https://conversation/message", {
          method: "POST",
          body: JSON.stringify({ text: "hello" }),
        }),
      )
      return { status: response.status, prompts: fake.counters.prompts }
    })

    expect(result.status).toBe(429)
    expect(result.prompts).toBe(0)
  })
})
