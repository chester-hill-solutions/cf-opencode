import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"

const settings = () => env.SETTINGS.getByName("global")

async function setTestBudget(dailyBudgetUSD: number): Promise<void> {
  await runInDurableObject(settings(), async (_instance, state) => {
    await state.storage.deleteAll()
  })
  await settings().fetch("https://settings/put", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dailyBudgetUSD, streaming: false }),
  })
}

/**
 * Concurrency regression: two deliveries of the same Slack event reach the same
 * Durable Object at once. The claim must admit exactly one prompt.
 *
 * The container is replaced with an injected transport inside the DO; no
 * network and no global fetch stubbing (the DO runs in its own isolate).
 */

function fakeContainer(prompts: { count: number }) {
  return (port: number) => ({
    async fetch(input: Request | string | URL): Promise<Response> {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

      if (port === 4001) {
        if (url.pathname === "/status") return json({ initialized: true })
        if (url.pathname === "/configure") return json({ ok: true })

        if (url.pathname === "/start") return json(accountingPolicyStart)
        return json({ error: "not found" }, 404)
      }

      if (url.pathname === "/api/config") return json(accountingPolicyConfig)

      if (url.pathname === "/api/session") return json({ data: { id: "ses_1" } })
      if (url.pathname === "/api/session/ses_1/model") return new Response(null, { status: 204 })
      if (url.pathname === "/api/session/ses_1/prompt") {
        prompts.count++
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
}

describe("admission queue", () => {
  it("queues when the container cannot start, then drains on the alarm", async () => {
    await setTestBudget(0.1)
    const stub = env.CONVERSATION.getByName("C1:queue")
    const result = await runInDurableObject(stub, async (instance) => {
      let starts = 2
      let prompts = 0
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

      instance.transport = (port) => ({
        async fetch(input: Request | string | URL): Promise<Response> {
          const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
          if (port === 4001) {
            if (url.pathname === "/status") return json({ initialized: true })
            if (url.pathname === "/configure") return json({ ok: true })
            if (url.pathname === "/start") {
              if (starts > 0) {
                starts--
                return json({ error: "capacity" }, 500)
              }
              return json(accountingPolicyStart)
            }
            return json({ error: "not found" }, 404)
          }
          if (url.pathname === "/api/config") return json(accountingPolicyConfig)
          if (url.pathname === "/api/session") return json({ data: { id: "ses_1" } })
          if (url.pathname === "/api/session/ses_1/model") return new Response(null, { status: 204 })
          if (url.pathname === "/api/session/ses_1/prompt") {
            prompts++
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

      const response = await instance.fetch(
        new Request("https://conversation/message", { method: "POST", body: JSON.stringify({ text: "hello" }) }),
      )
      const status = response.status
      const body = await response.text()
      const beforeDrain = await (await settings().fetch("https://settings/usage/today")).json() as {
        costUSD?: number
        reservedUSD?: number
      }
      for (let attempt = 0; attempt < 4; attempt++) await instance.alarm()
      const afterDrain = await (await settings().fetch("https://settings/usage/today")).json() as {
        costUSD?: number
        reservedUSD?: number
      }
      return { status, body, prompts, starts, beforeDrain, afterDrain }
    })

    expect(result.status).toBe(202)
    expect(result.body).toContain("queued")
    expect(result.prompts).toBe(1)
    expect(result.starts).toBe(0)
    expect(result.beforeDrain).toMatchObject({ costUSD: 0, reservedUSD: 0 })
    expect(result.afterDrain).toMatchObject({ costUSD: 0, reservedUSD: 0.1 })
  })

  it("queues when the pre-dispatch turn-baseline read fails without taking a hold", async () => {
    await setTestBudget(0.1)
    const stub = env.CONVERSATION.getByName("C1:baseline-read-fails")
    const result = await runInDurableObject(stub, async (instance) => {
      let contextReads = 0
      let prompts = 0
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
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
          if (url.pathname === "/api/session/ses_1/context") {
            contextReads++
            return contextReads === 1 ? json({ error: "context unavailable" }, 503) : json({ data: [] })
          }
          if (url.pathname === "/api/session/ses_1/prompt") {
            prompts++
            return json({ data: {} })
          }
          if (url.pathname === "/api/session/ses_1/permission") return json({ data: [] })
          return json({ error: "not found" }, 404)
        },
      })
      const response = await instance.fetch(new Request("https://conversation/message", {
        method: "POST", body: JSON.stringify({ text: "hello" }),
      }))
      const initialStatus = response.status
      const initial = await (await settings().fetch("https://settings/usage/today")).json() as {
        reservedUSD?: number
      }
      await instance.alarm()
      const recovered = await (await settings().fetch("https://settings/usage/today")).json() as {
        reservedUSD?: number
      }
      return { initialStatus, initial, recovered, prompts }
    })

    expect(result.initialStatus).toBe(202)
    expect(result.initial.reservedUSD).toBe(0)
    expect(result.prompts).toBe(1)
    expect(result.recovered.reservedUSD).toBe(0.1)
  })

  it("does not replay a queued prompt after an ambiguous provider response", async () => {
    await setTestBudget(0.1)
    const stub = env.CONVERSATION.getByName("C1:queue-prompt-loss")
    const result = await runInDurableObject(stub, async (instance) => {
      let starts = 1
      let prompts = 0
      let prompted = false
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
      instance.transport = (port) => ({
        async fetch(input: Request | string | URL): Promise<Response> {
          const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
          if (port === 4001) {
            if (url.pathname === "/status") return json({ initialized: true })
            if (url.pathname === "/configure") return json({ ok: true })
            if (url.pathname === "/start") {
              if (starts-- > 0) return json({ error: "temporary startup failure" }, 500)
              return json(accountingPolicyStart)
            }
            return json({ error: "not found" }, 404)
          }
          if (url.pathname === "/api/config") return json(accountingPolicyConfig)
          if (url.pathname === "/api/session") return json({ data: { id: "ses_1" } })
          if (url.pathname === "/api/session/ses_1/model") return new Response(null, { status: 204 })
          if (url.pathname === "/api/session/ses_1/prompt") {
            prompts++
            prompted = true
            throw new Error("connection reset after dispatch")
          }
          if (url.pathname === "/api/session/ses_1/context") {
            return json({ data: prompted ? [{ id: "u1", type: "user" }] : [] })
          }
          if (url.pathname === "/api/session/ses_1/permission") return json({ data: [] })
          if (url.pathname === "/api/event") return new Response("", { status: 200 })
          return json({ error: "not found" }, 404)
        },
      })

      const first = await instance.fetch(
        new Request("https://conversation/message", { method: "POST", body: JSON.stringify({ text: "hello" }) }),
      )
      const firstStatus = first.status
      const beforeDrain = await (await settings().fetch("https://settings/usage/today")).json() as {
        costUSD?: number
        reservedUSD?: number
      }
      await instance.alarm()
      const afterDispatch = await (await instance.fetch(new Request("https://conversation/state"))).json() as {
        phase?: string
        queued?: unknown
        budgetReservation?: { dispatched?: boolean }
      }
      await instance.alarm()
      return { firstStatus, beforeDrain, afterDispatch, prompts }
    })
    const usage = await (await settings().fetch("https://settings/usage/today")).json() as { reservedUSD?: number }

    expect(result.firstStatus).toBe(202)
    expect(result.beforeDrain).toMatchObject({ costUSD: 0, reservedUSD: 0 })
    expect(result.afterDispatch.phase).toBe("running")
    expect(result.afterDispatch.queued).toBeUndefined()
    expect(result.afterDispatch.budgetReservation).toMatchObject({ dispatched: true })
    expect(result.prompts).toBe(1)
    expect(usage.reservedUSD).toBe(0.1)
  })

  it("preserves a new follow-up queued while the drained prompt is in flight", async () => {
    await setTestBudget(0.1)
    const stub = env.CONVERSATION.getByName("C1:queue-followup-inflight")
    const result = await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("state", {
        phase: "queued",
        queued: { text: "original queued prompt", attempts: 0 },
        seen: [],
        pending: {},
      })
      let enterPrompt!: () => void
      let finishPrompt!: () => void
      const entered = new Promise<void>((resolve) => { enterPrompt = resolve })
      const gate = new Promise<void>((resolve) => { finishPrompt = resolve })
      let prompts = 0
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
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
          if (url.pathname === "/api/session/ses_1/prompt") {
            prompts++
            enterPrompt()
            await gate
            return json({ data: {} })
          }
          if (url.pathname === "/api/session/ses_1/context") return json({ data: [{
            id: "prior-assistant",
            type: "assistant",
            time: { created: Date.now() - 10_000, completed: Date.now() - 9_000 },
            finish: "stop",
            cost: 0,
            content: [{ type: "text", text: "prior turn" }],
          }] })
          if (url.pathname === "/api/session/ses_1/permission") return json({ data: [] })
          return json({ error: "not found" }, 404)
        },
      })

      const draining = instance.alarm()
      await entered
      const followup = await instance.fetch(
        new Request("https://conversation/message", {
          method: "POST",
          body: JSON.stringify({ text: "follow-up arriving during dispatch" }),
        }),
      )
      const followupStatus = followup.status
      finishPrompt()
      await draining
      const current = await (await instance.fetch(new Request("https://conversation/state"))).json() as {
        phase?: string
        queued?: { text?: string }
        runStartedAt?: number
        turnBaseline?: string
        sessionID?: string
        budgetReservation?: { dispatched?: boolean }
      }
      // Simulate a restart after the marker and a queued follow-up have both
      // been persisted. Recovery must resume the owner before queue drain.
      const stored = await state.storage.get<Record<string, unknown>>("state")
      await state.storage.put("state", { ...stored, phase: "queued" })
      await instance.alarm()
      const recovered = await (await instance.fetch(new Request("https://conversation/state"))).json() as {
        phase?: string
        queued?: { text?: string }
        runStartedAt?: number
        turnBaseline?: string
        sessionID?: string
        budgetReservation?: { dispatched?: boolean }
      }
      return { followupStatus, prompts, current, recovered }
    })

    expect(result.followupStatus).toBe(202)
    expect(result.prompts).toBe(1)
    expect(result.current.phase).toBe("running")
    expect(result.current.queued?.text).toBe("follow-up arriving during dispatch")
    expect(result.current.turnBaseline).toBe("prior-assistant")
    expect(result.current.budgetReservation).toMatchObject({ dispatched: true })
    expect(result.recovered.phase).toBe("running")
    expect(result.recovered.queued?.text).toBe("follow-up arriving during dispatch")
    expect(result.recovered.turnBaseline).toBe("prior-assistant")
    expect(result.recovered.runStartedAt).toBe(result.current.runStartedAt)
    expect(result.recovered.sessionID).toBe("ses_1")
    expect(result.recovered.budgetReservation).toMatchObject({ dispatched: true })
    expect(result.prompts).toBe(1)
  })

  it("keeps a queued message while container capacity is full", async () => {
    await setTestBudget(0)
    const stub = env.CONVERSATION.getByName("C1:capacity-queue")
    const result = await runInDurableObject(stub, async (instance) => {
      const prompts = { count: 0 }
      instance.transport = fakeContainer(prompts)

      // The transport seam bypasses the real lease path, so inject the same
      // error the Settings DO returns when the cap is full.
      const original = (instance as unknown as { ensureReady(): Promise<unknown> }).ensureReady.bind(
        instance,
      )
      let capacityFailures = 8
      ;(
        instance as unknown as { ensureReady(): Promise<unknown> }
      ).ensureReady = async () => {
        if (capacityFailures > 0) {
          capacityFailures--
          throw new Error("container capacity reached")
        }
        return original()
      }

      const response = await instance.fetch(
        new Request("https://conversation/message", {
          method: "POST",
          body: JSON.stringify({ text: "hello" }),
        }),
      )
      const status = response.status
      await response.text()

      // More alarms than the old bounded prompt-retry budget.
      for (let attempt = 0; attempt < 6; attempt++) await instance.alarm()
      const queuedAfterPressure = (await (
        await instance.fetch(new Request("https://conversation/state"))
      ).json()) as { queued?: unknown }

      // Capacity frees: the same queued message runs, it was not dropped.
      capacityFailures = 0
      await instance.alarm()
      const queuedAfterDrain = (await (
        await instance.fetch(new Request("https://conversation/state"))
      ).json()) as { queued?: unknown }

      return { status, prompts: prompts.count, queuedAfterPressure, queuedAfterDrain }
    })

    expect(result.status).toBe(202)
    expect(result.queuedAfterPressure.queued).toBeTruthy()
    expect(result.prompts).toBe(1)
    expect(result.queuedAfterDrain.queued).toBeUndefined()
  })
})

describe("conversation concurrency", () => {
  it("admits a duplicate Slack event exactly once", async () => {
    await setTestBudget(0)
    const stub = env.CONVERSATION.getByName("C1:dup")
    const result = await runInDurableObject(stub, async (instance) => {
      const prompts = { count: 0 }
      instance.transport = fakeContainer(prompts)
      ;(instance as unknown as { slack: unknown }).slack = async () => ({ ok: true, messages: [] })

      const body = JSON.stringify({
        eventID: "evt_dup",
        replyTs: "1",
        event: { type: "app_mention", channel: "C1", ts: "1", text: "<@UBOT> hello" },
      })

      const [first, second] = await Promise.all([
        instance.fetch(new Request("https://conversation/slack", { method: "POST", body })),
        instance.fetch(new Request("https://conversation/slack", { method: "POST", body })),
      ])

      const bodies = await Promise.all([first.text(), second.text()])
      return { statuses: [first.status, second.status], bodies, prompts: prompts.count }
    })

    expect(result.statuses).toEqual([200, 200])
    expect(result.prompts).toBe(1)
  })
})
