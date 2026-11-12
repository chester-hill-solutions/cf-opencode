import { beforeEach, describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { usageLogResponse } from "./helpers/usage-log"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"

function fakeContainer(promptFailure = false, contextMessages: unknown[] = []) {
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
      if (url.pathname === "/api/session/ses_1") return json({ data: { id: "ses_1" } })
      if (url.pathname === "/api/session/ses_1/model") return new Response(null, { status: 204 })
      if (url.pathname === "/api/session/ses_1/prompt") {
        counters.prompts++
        if (promptFailure) throw new Error("connection reset after dispatch")
        return json({ data: {} })
      }
      if (url.pathname === "/api/session/ses_1/context") return json({ data: contextMessages })
      if (url.pathname === "/api/experimental/session/ses_1/log") {
        return usageLogResponse(input, "ses_1", contextMessages as Parameters<typeof usageLogResponse>[2])
      }
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

async function post(path: string, body: unknown): Promise<Response> {
  return settings().fetch(`https://settings${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function clearSettings(): Promise<void> {
  await runInDurableObject(settings(), async (_instance, state) => {
    await state.storage.deleteAll()
  })
  await settings().fetch("https://settings/put", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ streaming: false, dailyBudgetUSD: 0 }),
  })
}

describe("HTTP budget admission", () => {
  beforeEach(clearSettings)

  it("fails closed when Settings cannot grant a reservation", async () => {
    const stub = env.CONVERSATION.getByName("C1:http-budget-conflict")
    const conversationID = await runInDurableObject(stub, async (_instance, state) => state.id.toString())
    await runInDurableObject(settings(), async (_instance, state) => {
      await state.storage.put(`usage:2020-01-01:reserve:${conversationID}`, {
        costUSD: 0.1,
        reserved: true,
      })
    })

    const result = await runInDurableObject(stub, async (instance) => {
      const fake = fakeContainer()
      instance.transport = fake.transport
      const response = await instance.fetch(
        new Request("https://conversation/message", {
          method: "POST",
          body: JSON.stringify({ text: "hello" }),
        }),
      )
      return {
        status: response.status,
        body: await response.json() as { ok?: boolean; reservation?: string },
        prompts: fake.counters.prompts,
      }
    })

    expect(result.status).toBe(503)
    expect(result.body).toMatchObject({ ok: false, reservation: "conflict" })
    expect(result.prompts).toBe(0)
  })

  it("retains the dispatched hold and never queues after a prompt transport failure", async () => {
    const stub = env.CONVERSATION.getByName("C1:http-budget-prompt-loss")
    const result = await runInDurableObject(stub, async (instance) => {
      const fake = fakeContainer(true)
      instance.transport = fake.transport
      const response = await instance.fetch(
        new Request("https://conversation/message", {
          method: "POST",
          body: JSON.stringify({ text: "hello", idempotencyKey: "http-prompt-loss" }),
        }),
      )
      const body = await response.json() as { error?: string }
      const state = await (await instance.fetch(new Request("https://conversation/state"))).json() as {
        phase?: string
        queued?: unknown
        budgetReservation?: { dispatched?: boolean }
      }
      return { status: response.status, body, state, prompts: fake.counters.prompts }
    })
    const usage = await (await settings().fetch("https://settings/usage/today")).json() as { reservedUSD?: number }

    expect(result.status).toBe(502)
    expect(result.body.error).toContain("outcome is unknown")
    expect(result.state.phase).toBe("running")
    expect(result.state.queued).toBeUndefined()
    expect(result.state.budgetReservation).toMatchObject({ dispatched: true })
    expect(result.prompts).toBe(1)
    expect(usage.reservedUSD).toBe(0.1)
  })

  it("arms recovery atomically before a direct HTTP prompt can return", async () => {
    const stub = env.CONVERSATION.getByName("C1:http-dispatch-alarm")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      let enterPrompt!: () => void
      let finishPrompt!: () => void
      const promptEntered = new Promise<void>((resolve) => { enterPrompt = resolve })
      const promptGate = new Promise<void>((resolve) => { finishPrompt = resolve })
      let prompts = 0
      const json = (body: unknown, status = 200) => Response.json(body, { status })
      instance.transport = (port) => ({
        async fetch(input: Request | string | URL): Promise<Response> {
          const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
          if (port === 4001) {
            if (url.pathname === "/status") return json({ initialized: true })
            if (url.pathname === "/configure") return json({ ok: true })

            if (url.pathname === "/start") return json(accountingPolicyStart)
            return json({ error: "not found" }, 404)
          }
          if (url.pathname === "/api/config") return json(accountingPolicyConfig)
          if (url.pathname === "/api/session") return json({ data: { id: "ses_1" } })
          if (url.pathname === "/api/session/ses_1/model") return new Response(null, { status: 204 })
          if (url.pathname === "/api/session/ses_1/context") return json({ data: [] })
          if (url.pathname === "/api/session/ses_1/prompt") {
            prompts++
            enterPrompt()
            await promptGate
            return json({ data: {} })
          }
          if (url.pathname === "/api/session/ses_1/permission") return json({ data: [] })
          return json({ error: "not found" }, 404)
        },
      })
      const responsePromise = instance.fetch(new Request("https://conversation/message", {
        method: "POST", body: JSON.stringify({ text: "hello" }),
      }))
      await promptEntered
      const alarm = await runtime.storage.getAlarm()
      const marked = await (await instance.fetch(new Request("https://conversation/state"))).json() as {
        phase?: string
        budgetReservation?: { dispatched?: boolean }
      }
      // A poll alarm can fire while prompt() is still waiting. It must rearm
      // recovery instead of consuming the only restart path.
      await instance.alarm()
      const rearmedAlarm = await runtime.storage.getAlarm()
      finishPrompt()
      const response = await responsePromise
      return { alarm, rearmedAlarm, marked, status: response.status, prompts }
    })

    expect(result.alarm).toEqual(expect.any(Number))
    expect(result.rearmedAlarm).toEqual(expect.any(Number))
    expect(result.marked.phase).toBe("admitting")
    expect(result.marked.budgetReservation).toMatchObject({ dispatched: true })
    expect(result.status).toBe(200)
    expect(result.prompts).toBe(1)
  })

  it("does not allow HTTP dispatch when committing its recovery alarm fails", async () => {
    const stub = env.CONVERSATION.getByName("C1:http-dispatch-alarm-failure")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const fake = fakeContainer()
      instance.transport = fake.transport
      const storage = runtime.storage
      const originalSetAlarm = storage.setAlarm.bind(storage)
      storage.setAlarm = async () => { throw new Error("alarm write failed") }
      let response: Response
      try {
        response = await instance.fetch(new Request("https://conversation/message", {
          method: "POST", body: JSON.stringify({ text: "hello" }),
        }))
      } finally {
        storage.setAlarm = originalSetAlarm
      }
      const state = await (await instance.fetch(new Request("https://conversation/state"))).json() as {
        budgetReservation?: { dispatched?: boolean }
      }
      return { status: response.status, state, prompts: fake.counters.prompts }
    })

    expect(result.status).toBe(503)
    expect(result.prompts).toBe(0)
    expect(result.state.budgetReservation).toMatchObject({ dispatched: false })
  })

  it("resumes an old dispatched turn without replacing its baseline or start time", async () => {
    const stub = env.CONVERSATION.getByName("C1:http-budget-old-dispatch")
    const startedAt = Date.now() - 1_000
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("state", {
        phase: "idle",
        runStartedAt: startedAt,
        turnBaseline: "old-assistant",
        sessionID: "ses_1",
        seen: [],
        pending: {},
        budgetReservation: { reservationID: "old-reference", date: "2026-11-11", dispatched: true },
      })
    })

    const result = await runInDurableObject(stub, async (instance) => {
      const fake = fakeContainer(false, [{
        id: "old-assistant",
        type: "assistant",
        time: { created: Date.now() - 5_000, completed: Date.now() - 4_000 },
        finish: "stop",
        content: [{ type: "text", text: "old completed turn" }],
      }])
      instance.transport = fake.transport
      const response = await instance.fetch(
        new Request("https://conversation/message", {
          method: "POST",
          body: JSON.stringify({ text: "a new message" }),
        }),
      )
      const state = await (await instance.fetch(new Request("https://conversation/state"))).json() as {
        runStartedAt?: number
        turnBaseline?: string
        phase?: string
      }
      return { status: response.status, state, prompts: fake.counters.prompts }
    })

    const afterOldAssistantPoll = await runInDurableObject(stub, async (instance) => {
      await instance.alarm()
      return await (await instance.fetch(new Request("https://conversation/state"))).json() as {
        phase?: string
        runStartedAt?: number
        turnBaseline?: string
      }
    })

    expect(result.status).toBe(503)
    expect(result.prompts).toBe(0)
    expect(result.state.phase).toBe("running")
    expect(result.state.runStartedAt).toBe(startedAt)
    expect(result.state.turnBaseline).toBe("old-assistant")
    expect(afterOldAssistantPoll.phase).toBe("running")
    expect(afterOldAssistantPoll.runStartedAt).toBe(startedAt)
    expect(afterOldAssistantPoll.turnBaseline).toBe("old-assistant")
  })

  it("recovers a crash after the dispatch marker without settling on the old assistant", async () => {
    const stub = env.CONVERSATION.getByName("C1:http-budget-crash-after-marker")
    const startedAt = Date.now() - 1_000
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("state", {
        phase: "admitting",
        runStartedAt: startedAt,
        turnBaseline: "old-assistant",
        sessionID: "ses_1",
        seen: [],
        pending: {},
        budgetReservation: { reservationID: "dispatch-ref", date: "2026-11-11", dispatched: true },
      })
    })

    const result = await runInDurableObject(stub, async (instance) => {
      const fake = fakeContainer(false, [{
        id: "old-assistant",
        type: "assistant",
        time: { created: Date.now() - 5_000, completed: Date.now() - 4_000 },
        finish: "stop",
        content: [{ type: "text", text: "previous answer" }],
      }])
      instance.transport = fake.transport
      await instance.alarm()
      const state = await (await instance.fetch(new Request("https://conversation/state"))).json() as {
        phase?: string
        runStartedAt?: number
        turnBaseline?: string
        budgetReservation?: { dispatched?: boolean }
      }
      return { state, prompts: fake.counters.prompts }
    })

    expect(result.state.phase).toBe("running")
    expect(result.state.runStartedAt).toBe(startedAt)
    expect(result.state.turnBaseline).toBe("old-assistant")
    expect(result.state.budgetReservation).toMatchObject({ dispatched: true })
    expect(result.prompts).toBe(0)
  })

  it("keeps an expired dispatched turn running and polls without releasing its hold", async () => {
    const stub = env.CONVERSATION.getByName("C1:http-budget-timeout-hold")
    const conversationID = await runInDurableObject(stub, async (_instance, state) => state.id.toString())
    await post("/usage/reserve", {
      conversationID,
      reservationID: "timeout-ref",
      costUSD: 0.1,
    })
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("state", {
        phase: "running",
        runStartedAt: Date.now() - 16 * 60_000,
        turnBaseline: "old-assistant",
        sessionID: "ses_1",
        seen: [],
        pending: {},
        budgetReservation: { reservationID: "timeout-ref", date: "2026-11-11", dispatched: true },
      })
    })

    const result = await runInDurableObject(stub, async (instance, state) => {
      const fake = fakeContainer(false, [{
        id: "old-assistant",
        type: "assistant",
        time: { created: Date.now() - 30_000, completed: Date.now() - 29_000 },
        finish: "stop",
        content: [{ type: "text", text: "previous answer" }],
      }])
      instance.transport = fake.transport
      await instance.alarm()
      await instance.alarm()
      const current = await (await instance.fetch(new Request("https://conversation/state"))).json() as {
        phase?: string
        runStartedAt?: number
        budgetReservation?: { dispatched?: boolean }
        settlementError?: string
      }
      const events = await state.storage.get<Array<{ event: { type: string; message?: string } }>>("events")
      return { current, prompts: fake.counters.prompts, warnings: events?.filter((entry) =>
        entry.event.type === "error" && entry.event.message?.includes("exceeded its time limit"),
      ).length }
    })
    const usage = await (await settings().fetch("https://settings/usage/today")).json() as { reservedUSD?: number }

    expect(result.current.phase).toBe("running")
    expect(result.current.budgetReservation).toMatchObject({ dispatched: true })
    expect(result.current.settlementError).toContain("exceeded its time limit")
    expect(result.prompts).toBe(0)
    expect(result.warnings).toBe(1)
    expect(usage.reservedUSD).toBe(0.1)
  })
})
