import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { usageLogResponse, type UsageLogOptions } from "./helpers/usage-log"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"
import { driveConversationJobs } from "./helpers/conversation-jobs"

/**
 * Turn settlement: a new user message must not be considered finished just
 * because an earlier assistant message completed. The baseline is the last
 * assistant id from before the prompt.
 */

interface Message {
  id: string
  type: "user" | "assistant" | "idle"
  content?: Array<{ type: string; text: string }>
  time?: { created?: number; completed?: number }
  finish?: string
  cost?: number
  tokens?: { input?: number; output?: number }
  error?: { message: string }
}

function fakeContainer(options: {
  beforePrompt: Message[]
  afterPrompt: () => Message[]
  checkpoints?: { count: number }
  logOptions?: (messages: readonly Message[]) => UsageLogOptions
}) {
  let prompted = false
  return (port: number) => ({
    async fetch(input: Request | string | URL): Promise<Response> {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

      if (port === 4001) {
        if (url.pathname === "/status") return json({ initialized: true })
        if (url.pathname === "/configure") return json({ ok: true })

        if (url.pathname === "/start") return json(accountingPolicyStart)
        if (url.pathname === "/checkpoint") {
          if (options.checkpoints) options.checkpoints.count++
          return new Response(null, { status: 204 })
        }
        return json({ error: "not found" }, 404)
      }

      if (url.pathname === "/api/config") return json(accountingPolicyConfig)

      if (url.pathname === "/api/session") return json({ data: { id: "ses_1" } })
      if (url.pathname === "/api/session/ses_1/model") return new Response(null, { status: 204 })
      if (url.pathname === "/api/session/ses_1/prompt") {
        prompted = true
        return json({ data: {} })
      }
      if (url.pathname === "/api/session/ses_1/context") {
        return json({ data: prompted ? options.afterPrompt() : options.beforePrompt })
      }
      if (url.pathname === "/api/experimental/session/ses_1/log") {
        const messages = prompted ? options.afterPrompt() : options.beforePrompt
        return usageLogResponse(input, "ses_1", messages, options.logOptions?.(messages))
      }
      if (url.pathname === "/api/session/ses_1/permission") return json({ data: [] })
      if (url.pathname === "/api/event") return new Response("", { status: 200 })
      return json({ error: "not found" }, 404)
    },
  })
}

async function state(instance: { fetch(request: Request): Promise<Response> }) {
  const response = await instance.fetch(new Request("https://conversation/state"))
  return (await response.json()) as {
    phase?: string
    lastReply?: string
    pending?: Record<string, string>
    budgetReservation?: unknown
    settlementError?: string
  }
}

const user = (id: string, text: string): Message => ({
  id,
  type: "user",
  content: [{ type: "text", text }],
})

const assistant = (id: string, text: string, finish = "stop"): Message => ({
  id,
  type: "assistant",
  content: [{ type: "text", text }],
  time: { created: 1, completed: 2 },
  finish,
})

function interceptSettings(instance: object, intercept: (url: URL) => Response | undefined): void {
  type Stub = {
    fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>
  }
  type Namespace = { getByName(name: string): Stub }
  const envHolder = instance as unknown as { env?: { SETTINGS: Namespace } }
  const originalEnv = envHolder.env!
  const original = originalEnv.SETTINGS
  const wrapped: Namespace = {
    getByName(name: string): Stub {
      const stub = original.getByName(name)
      if (name !== "global") return stub
      return {
        fetch(input, init) {
          const url = new URL(
            input instanceof Request ? input.url : input instanceof URL ? input.toString() : input,
          )
          return Promise.resolve(intercept(url) ?? stub.fetch(input, init))
        },
      }
    },
  }
  const isolatedEnv = Object.create(originalEnv) as { SETTINGS: Namespace }
  Object.defineProperty(isolatedEnv, "SETTINGS", { value: wrapped, enumerable: true })
  envHolder.env = isolatedEnv
}

describe("turn settlement", () => {
  it("keeps a length step held through foreground compaction and continuation", async () => {
    const settings = env.SETTINGS.getByName("global")
    const originalSettings = await (await settings.fetch("https://settings/get")).json() as { streaming?: boolean }
    await settings.fetch("https://settings/put", {
      method: "POST",
      body: JSON.stringify({ streaming: false }),
    })
    const stub = env.CONVERSATION.getByName("C1:length-continuation")
    let current: Message[] = [
      user("u1", "write a long answer"),
      {
        ...assistant("a_length", "partial", "length"),
        time: { created: Date.now(), completed: Date.now() + 1 },
        cost: 0.3,
        tokens: { input: 30, output: 10 },
      },
    ]
    const conversationID = await runInDurableObject(stub, async (_instance, state) => state.id.toString())
    await runInDurableObject(stub, async (instance, runtime) => {
      instance.transport = fakeContainer({
        beforePrompt: [user("u0", "start")],
        afterPrompt: () => current,
        logOptions: (messages) => messages.some((message) => message.id === "a_continue")
          ? {
              execution: "succeeded",
              auxiliary: [{
                id: "compaction-after-length",
                afterAssistantMessageID: "a_length",
                cost: 0.2,
                tokens: { input: 20, output: 0 },
                source: "compaction",
              }],
            }
          : { execution: "running" },
      })
      const admitted = await instance.fetch(new Request("https://conversation/message", {
        method: "POST",
        body: JSON.stringify({ text: "write a long answer" }),
      }))
      expect(admitted.status).toBe(200)
      await driveConversationJobs(instance, runtime.storage, ["turn:observe"])
      const held = await state(instance)
      expect(held.phase).toBe("settling")
      expect(held.settlementError).toContain("terminal assistant usage")
      expect(held.budgetReservation).toBeTruthy()

      current = [
        ...current,
        {
          ...assistant("a_continue", "complete", "stop"),
          time: { created: Date.now() + 1, completed: Date.now() + 2 },
          cost: 0.5,
          tokens: { input: 50, output: 20 },
        },
      ]
      await driveConversationJobs(instance, runtime.storage, ["turn:observe"])
      const settled = await state(instance)
      expect(settled.phase).toBe("idle")
      expect(settled.budgetReservation).toBeUndefined()
    })
    const today = new Date().toISOString().slice(0, 10)
    const actual = await runInDurableObject(settings, async (_instance, storage) =>
      storage.storage.get<{ costUSD: number; input: number; output: number }>(`usage:${today}:${conversationID}`),
    )
    expect(actual).toMatchObject({ costUSD: 1, input: 100, output: 30 })
    await settings.fetch("https://settings/put", {
      method: "POST",
      body: JSON.stringify({ streaming: originalSettings.streaming ?? true }),
    })
  })

  it("keeps an unanswered turn running until its own assistant completes", async () => {
    const stub = env.CONVERSATION.getByName("C1:unanswered")
    await runInDurableObject(stub, async (instance, runtime) => {
      const old = assistant("a_old", "first answer")
      const messages: Message[] = [user("u1", "one"), old]
      instance.transport = fakeContainer({
        beforePrompt: messages,
        afterPrompt: () => messages,
      })

      const sent = await instance.fetch(
        new Request("https://conversation/message", { method: "POST", body: JSON.stringify({ text: "two" }) }),
      )
      await sent.text()
      expect(sent.status).toBe(200)

      // The new user message is in history, but the model has not answered it.
      messages.push(user("u2", "two"))
      await driveConversationJobs(instance, runtime.storage, ["turn:observe"])
      expect(await state(instance)).toMatchObject({ phase: "running" })
      expect((await state(instance)).lastReply).toBeUndefined()

      // The model now answers this turn.
      const now = Date.now()
      messages.push({ ...assistant("a_new", "second answer"), time: { created: now - 1, completed: now }, cost: 0 })
      await driveConversationJobs(instance, runtime.storage, ["turn:observe"])
      expect(await state(instance)).toMatchObject({ phase: "idle", lastReply: "second answer" })
    })
  })

  it("settles once, even if a late alarm arrives", async () => {
    const stub = env.CONVERSATION.getByName("C1:settle-once")
    const settings = env.SETTINGS.getByName("global")
    const conversationID = await runInDurableObject(stub, async (_instance, state) => state.id.toString())
    await runInDurableObject(settings, async (_instance, state) => {
      await state.storage.deleteAll()
    })
    await runInDurableObject(stub, async (instance, runtime) => {
      const checkpoints = { count: 0 }
      const messages: Message[] = [user("u1", "hello")]
      const now = Date.now()
      const answers: Message[] = [
        ...messages,
        { ...assistant("a1", "done"), time: { created: now, completed: now }, cost: 0 },
      ]
      instance.transport = fakeContainer({
        beforePrompt: messages,
        afterPrompt: () => answers,
        checkpoints,
      })

      const sent = await instance.fetch(
        new Request("https://conversation/message", { method: "POST", body: JSON.stringify({ text: "hello" }) }),
      )
      await sent.text()
      await driveConversationJobs(instance, runtime.storage, ["turn:observe"])
      expect(await state(instance)).toMatchObject({ phase: "idle", lastReply: "done" })
      expect(checkpoints.count).toBe(1)

      // An alarm armed by the warm stream must not settle (or checkpoint) again.
      await driveConversationJobs(instance, runtime.storage, ["turn:observe"])
      expect(checkpoints.count).toBe(1)
    })
    const stored = await runInDurableObject(settings, async (_settings, storage) =>
      storage.storage.get(`usage:${new Date().toISOString().slice(0, 10)}:${conversationID}`),
    )
    expect(stored).toMatchObject({ costUSD: 0, input: 0, output: 0 })
    const today = await (await settings.fetch("https://settings/usage/today")).json() as {
      reservedUSD?: number
    }
    expect(today.reservedUSD).toBe(0)
  })

  it("records usage at settle when streaming is off", async () => {
    const settings = env.SETTINGS.getByName("global")
    await runInDurableObject(settings, async (_instance, storage) => {
      await storage.storage.deleteAll()
    })
    const configured = await settings.fetch("https://settings/put", {
      method: "POST",
      body: JSON.stringify({ streaming: false }),
    })
    expect(configured.ok).toBe(true)

    const stub = env.CONVERSATION.getByName("C1:usage")
    const phase = await runInDurableObject(stub, async (instance, runtime) => {
      const now = Date.now()
      const messages: Message[] = [user("u1", "hello")]
      const answers: Message[] = [
        ...messages,
        {
          id: "a1",
          type: "assistant",
          content: [{ type: "text", text: "done" }],
          time: { created: now, completed: now },
          finish: "stop",
          cost: 0.25,
          tokens: { input: 100, output: 20 },
        },
      ]
      instance.transport = fakeContainer({
        beforePrompt: messages,
        afterPrompt: () => answers,
      })

      const sent = await instance.fetch(
        new Request("https://conversation/message", {
          method: "POST",
          body: JSON.stringify({ text: "hello" }),
        }),
      )
      await sent.text()
      await driveConversationJobs(instance, runtime.storage, ["turn:observe"])
      return (await state(instance)).phase
    })

    expect(phase).toBe("idle")
    const usage = (await (await settings.fetch("https://settings/usage/today")).json()) as {
      costUSD: number
      input: number
      output: number
    }
    expect(usage.costUSD).toBeCloseTo(0.25)
    expect(usage.input).toBe(100)
    expect(usage.output).toBe(20)
  })

  it("keeps the hold and settling state when the terminal usage report is rejected", async () => {
    const settings = env.SETTINGS.getByName("global")
    await runInDurableObject(settings, async (_instance, storage) => {
      await storage.storage.deleteAll()
    })
    await settings.fetch("https://settings/put", {
      method: "POST",
      body: JSON.stringify({ streaming: false }),
    })

    const stub = env.CONVERSATION.getByName("C1:usage-report-rejected")
    const result = await runInDurableObject(stub, async (instance, storage) => {
      const now = Date.now()
      const before: Message[] = [user("u1", "hello")]
      const answers: Message[] = [
        ...before,
        { ...assistant("a1", "done"), time: { created: now, completed: now }, cost: 0.25 },
      ]
      instance.transport = fakeContainer({ beforePrompt: before, afterPrompt: () => answers })
      let reports = 0
      let releases = 0
      interceptSettings(instance, (url) => {
        if (url.pathname === "/usage" && url.search === "") {
          // POST /usage is the absolute actual report. /usage/today is a GET.
          reports++
          return Response.json({ error: "temporary failure" }, { status: 503 })
        }
        if (url.pathname === "/usage/release") releases++
        return undefined
      })

      const sent = await instance.fetch(
        new Request("https://conversation/message", { method: "POST", body: JSON.stringify({ text: "hello" }) }),
      )
      await sent.text()
      await driveConversationJobs(instance, storage.storage, ["turn:observe"])
      await driveConversationJobs(instance, storage.storage, ["turn:observe"])
      const current = await state(instance)
      const events = await storage.storage.get<Array<{ event: { type: string } }>>("events")
      return { current, reports, releases, errorEvents: events?.filter((entry) => entry.event.type === "error").length }
    })
    const usage = await (await settings.fetch("https://settings/usage/today")).json() as {
      reservedUSD?: number
      costUSD?: number
    }

    expect(result.current.phase).toBe("settling")
    expect(result.current.budgetReservation).toBeDefined()
    expect(result.current.settlementError).toContain("usage report failed")
    expect(result.reports).toBe(2)
    expect(result.releases).toBe(0)
    expect(result.errorEvents).toBe(1)
    expect(usage).toMatchObject({ costUSD: 0, reservedUSD: 0.1 })
  })

  it("retries a failed release after the actual report is acknowledged", async () => {
    const settings = env.SETTINGS.getByName("global")
    await runInDurableObject(settings, async (_instance, storage) => {
      await storage.storage.deleteAll()
    })
    await settings.fetch("https://settings/put", {
      method: "POST",
      body: JSON.stringify({ streaming: false }),
    })

    const stub = env.CONVERSATION.getByName("C1:release-retry")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const now = Date.now()
      const before: Message[] = [user("u1", "hello")]
      const answers: Message[] = [
        ...before,
        { ...assistant("a1", "done"), time: { created: now, completed: now }, cost: 0.25 },
      ]
      instance.transport = fakeContainer({ beforePrompt: before, afterPrompt: () => answers })
      const telemetry: Array<{ event: string; result?: string; reasonCode?: string }> = []
      const execution = instance as unknown as {
        turnExecution: { options: { telemetry?: (input: { event: string; result?: string; reasonCode?: string }) => void } }
      }
      execution.turnExecution.options.telemetry = (input) => telemetry.push(input)
      let releaseCalls = 0
      interceptSettings(instance, (url) => {
        if (url.pathname === "/usage/release" && ++releaseCalls === 1) {
          return Response.json({ error: "temporary failure" }, { status: 503 })
        }
        return undefined
      })

      const sent = await instance.fetch(
        new Request("https://conversation/message", { method: "POST", body: JSON.stringify({ text: "hello" }) }),
      )
      await sent.text()
      await driveConversationJobs(instance, runtime.storage, ["turn:observe"])
      const paused = await state(instance)
      const pausedSettledTelemetry = telemetry.filter((event) => event.event === "turn.settled").length
      const savedState = await runtime.storage.get<Record<string, unknown>>("state")
      await runtime.storage.put("state", { ...savedState, runStartedAt: Date.now() - 20 * 60_000 })
      await driveConversationJobs(instance, runtime.storage, ["turn:observe"])
      const completed = await state(instance)
      return { paused, completed, releaseCalls, pausedSettledTelemetry, telemetry }
    })
    const usage = await (await settings.fetch("https://settings/usage/today")).json() as {
      reservedUSD?: number
      costUSD?: number
    }

    expect(result.paused.phase).toBe("settling")
    expect(result.paused.budgetReservation).toBeDefined()
    expect(result.completed.phase).toBe("idle")
    expect(result.completed.budgetReservation).toBeUndefined()
    expect(result.completed.settlementError).toBeUndefined()
    expect(result.releaseCalls).toBe(2)
    expect(result.pausedSettledTelemetry).toBe(0)
    expect(result.telemetry.filter((event) => event.event === "turn.settled")).toEqual([{
      event: "turn.settled",
      conversationID: expect.any(String),
      sessionID: "ses_1",
      turnID: expect.any(String),
      durationMs: expect.any(Number),
      result: "settled",
      reasonCode: "terminal_usage_acknowledged",
    }])
    expect(usage).toMatchObject({ costUSD: 0.25, reservedUSD: 0 })
  })

  it("retains the hold when a current-day assistant has no readable cost", async () => {
    const settings = env.SETTINGS.getByName("global")
    await runInDurableObject(settings, async (_instance, storage) => {
      await storage.storage.deleteAll()
    })
    await settings.fetch("https://settings/put", {
      method: "POST",
      body: JSON.stringify({ streaming: false }),
    })

    const stub = env.CONVERSATION.getByName("C1:missing-terminal-cost")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const before: Message[] = [user("u1", "hello")]
      const now = Date.now()
      const answers: Message[] = [
        ...before,
        { ...assistant("a1", "done"), time: { created: now, completed: now } },
      ]
      instance.transport = fakeContainer({ beforePrompt: before, afterPrompt: () => answers })
      const sent = await instance.fetch(
        new Request("https://conversation/message", { method: "POST", body: JSON.stringify({ text: "hello" }) }),
      )
      await sent.text()
      await driveConversationJobs(instance, runtime.storage, ["turn:observe"])
      return await state(instance)
    })
    const usage = await (await settings.fetch("https://settings/usage/today")).json() as {
      costUSD?: number
      reservedUSD?: number
    }

    expect(result.phase).toBe("settling")
    expect(result.budgetReservation).toBeDefined()
    expect(result.settlementError).toContain("current-turn assistant usage")
    expect(usage).toMatchObject({ costUSD: 0, reservedUSD: 0.1 })
  })

  it("reports an idle provider error but retains the hold without assistant usage", async () => {
    const settings = env.SETTINGS.getByName("global")
    await runInDurableObject(settings, async (_instance, storage) => { await storage.storage.deleteAll() })
    await settings.fetch("https://settings/put", { method: "POST", body: JSON.stringify({ streaming: false }) })

    const stub = env.CONVERSATION.getByName("C1:idle-error-no-usage")
    const result = await runInDurableObject(stub, async (instance, storage) => {
      const now = Date.now() + 10_000
      const before = [user("u1", "hello")]
      const after: Message[] = [...before, { id: "idle1", type: "idle", time: { created: now }, error: { message: "provider unavailable" } }]
      instance.transport = fakeContainer({ beforePrompt: before, afterPrompt: () => after })
      const sent = await instance.fetch(new Request("https://conversation/message", {
        method: "POST", body: JSON.stringify({ text: "hello" }),
      }))
      await sent.text()
      await driveConversationJobs(instance, storage.storage, ["turn:observe"])
      const current = await state(instance)
      const events = await storage.storage.get<Array<{ event: { type: string; message?: string } }>>("events")
      return { current, events }
    })
    const usage = await (await settings.fetch("https://settings/usage/today")).json() as {
      costUSD?: number
      reservedUSD?: number
    }

    expect(result.current.phase).toBe("settling")
    expect(result.current.budgetReservation).toBeDefined()
    expect(result.current.settlementError).toContain("current-turn assistant usage")
    expect(result.events?.some((entry) => entry.event.message === "provider unavailable")).toBe(true)
    expect(usage).toMatchObject({ costUSD: 0, reservedUSD: 0.1 })
  })

  it("does not use a prior-turn assistant cost as terminal usage proof", async () => {
    const settings = env.SETTINGS.getByName("global")
    await runInDurableObject(settings, async (_instance, storage) => { await storage.storage.deleteAll() })
    await settings.fetch("https://settings/put", { method: "POST", body: JSON.stringify({ streaming: false }) })

    const stub = env.CONVERSATION.getByName("C1:prior-turn-cost-not-proof")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const now = Date.now() + 10_000
      const previous: Message = { ...assistant("a_old", "old answer"), time: { created: now - 1000, completed: now - 900 }, cost: 0.4 }
      const before = [previous]
      const after: Message[] = [
        previous,
        { ...user("u1", "hello"), time: { created: now } },
        { id: "idle1", type: "idle", time: { created: now + 1 }, error: { message: "provider unavailable" } },
      ]
      instance.transport = fakeContainer({ beforePrompt: before, afterPrompt: () => after })
      const sent = await instance.fetch(new Request("https://conversation/message", {
        method: "POST", body: JSON.stringify({ text: "hello" }),
      }))
      await sent.text()
      await driveConversationJobs(instance, runtime.storage, ["turn:observe"])
      return await state(instance)
    })
    const usage = await (await settings.fetch("https://settings/usage/today")).json() as {
      costUSD?: number
      reservedUSD?: number
    }

    expect(result.phase).toBe("settling")
    expect(result.budgetReservation).toBeDefined()
    expect(result.settlementError).toContain("current-turn assistant usage")
    expect(usage).toMatchObject({ costUSD: 0, reservedUSD: 0.1 })
  })
})
