import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"

/**
 * A prompt may be sent at most once per message. Two failure modes used to
 * break that: an idempotency key was burned when admission returned 429/503,
 * and a bookkeeping failure after OpenCode accepted the prompt re-queued it.
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
        if (url.pathname === "/configure") return json({ ok: true })

        if (url.pathname === "/start") return json(accountingPolicyStart)
        if (url.pathname === "/checkpoint") return new Response(null, { status: 204 })
        return json({ error: "not found" }, 404)
      }

      if (url.pathname === "/api/config") return json(accountingPolicyConfig)

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

async function configure(body: Record<string, unknown>): Promise<void> {
  await runInDurableObject(settings(), async (_instance, state) => {
    await state.storage.deleteAll()
  })
  const response = await settings().fetch("https://settings/put", {
    method: "POST",
    body: JSON.stringify({ streaming: false, ...body }),
  })
  expect(response.ok).toBe(true)
}

async function send(
  instance: { fetch(request: Request): Promise<Response> },
  text: string,
  idempotencyKey?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await instance.fetch(
    new Request("https://conversation/message", {
      method: "POST",
      body: JSON.stringify({ text, ...(idempotencyKey ? { idempotencyKey } : {}) }),
    }),
  )
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe("idempotency", () => {
  it("does not burn the key when the budget rejects the message", async () => {
    await configure({ dailyBudgetUSD: 1 })
    const today = new Date().toISOString().slice(0, 10)
    await settings().fetch("https://settings/usage", {
      method: "POST",
      body: JSON.stringify({ conversationID: "other", date: today, costUSD: 5 }),
    })

    const stub = env.CONVERSATION.getByName("C1:idem-budget")
    const result = await runInDurableObject(stub, async (instance) => {
      const fake = fakeContainer()
      instance.transport = fake.transport

      const blocked = await send(instance, "hello", "retry-me")
      // Lift the cap, then retry with the same key. Without the release the
      // key is already spent and this returns duplicate without prompting.
      const lift = await settings().fetch("https://settings/put", {
        method: "POST",
        body: JSON.stringify({ dailyBudgetUSD: 0 }),
      })
      expect(lift.ok).toBe(true)
      const retried = await send(instance, "hello", "retry-me")
      return { blocked, retried, prompts: fake.counters.prompts }
    })

    expect(result.blocked.status).toBe(429)
    expect(result.retried.status).toBe(200)
    expect(result.retried.body.duplicate).toBeUndefined()
    expect(result.prompts).toBe(1)
  })

  it("does not re-queue a prompt OpenCode already accepted", async () => {
    await configure({})
    const stub = env.CONVERSATION.getByName("C1:no-requeue")
    const result = await runInDurableObject(stub, async (instance) => {
      const fake = fakeContainer()
      instance.transport = fake.transport

      // Fail the first bookkeeping write after the prompt is accepted, the
      // way a transient storage error would.
      const store = (instance as unknown as { store: { patch: (patch: unknown) => Promise<unknown> } })
        .store
      const original = store.patch.bind(store)
      let failed = false
      store.patch = async (patch: unknown) => {
        if (!failed && Object.prototype.hasOwnProperty.call(patch, "runStartedAt")) {
          failed = true
          throw new Error("bookkeeping failed")
        }
        return original(patch)
      }

      const { status, body } = await send(instance, "hello")
      const state = (await (
        await instance.fetch(new Request("https://conversation/state"))
      ).json()) as { queued?: unknown }

      for (let attempt = 0; attempt < 3; attempt++) await instance.alarm()
      return { status, body, state, prompts: fake.counters.prompts }
    })

    expect(result.status).toBe(200)
    expect(result.body.queued).toBeUndefined()
    expect(result.state.queued).toBeUndefined()
    expect(result.prompts).toBe(1)
  })
})
