import { beforeEach, describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { ConversationStore } from "../src/state"
import { runtimeCache } from "./helpers/runtime-cache"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"
import { usageLogResponse } from "./helpers/usage-log"
import { driveConversationJobs } from "./helpers/conversation-jobs"
import type { Conversation } from "../src/conversation"
import type { ConversationTurnExecution } from "../src/conversation/turn-execution"
import { ConversationFinalReplies } from "../src/conversation/final-replies"
import { chunkText } from "../src/adapters/slack"
import type { ConversationScheduler } from "../src/conversation/scheduler"

async function fixture(instance: Conversation, runtime: DurableObjectState, failFirst: boolean, text: string | null = "A concrete final answer.") {
  const store = new ConversationStore(runtime.storage), now = Date.now(), sessionID = "ses_reply_delivery"
  const messages = [
    { id: "u1", type: "user", content: [{ type: "text", text: "reply once" }], time: { created: now - 10 } },
    { id: "a1", type: "assistant", content: text === null ? [{ type: "reasoning", text: "PRIVATE_REASONING" }, { type: "tool-call", text: "PRIVATE_TOOL" }] : [{ type: "text", text }], finish: "stop", cost: 0.01,
      tokens: { input: 1, output: 1 }, time: { created: now - 5, completed: now } },
  ]
  let contextReads = 0, attempts = 0, checkpointCaptures = 0
  const delivered: { text: string; channel: string; thread: string }[] = []
  instance.transport = port => ({ async fetch(input, init) {
    const request = input instanceof Request ? input : new Request(input, init), path = new URL(request.url).pathname
    if (path === "/health") return Response.json({ ok: true })
    if (port === 4001 && path === "/status") return Response.json({ initialized: true })
    if (port === 4001 && path === "/start") return Response.json(accountingPolicyStart)
    if (path === "/api/config") return Response.json(accountingPolicyConfig)
    if (path.endsWith("/context")) { contextReads++; return Response.json({ data: messages }) }
    if (path.endsWith("/permission") || path.endsWith("/form")) return Response.json({ data: [] })
    if (path.endsWith("/log")) return usageLogResponse(request, sessionID, messages)
    throw new Error("Unexpected provider/session/control side effect")
  } })
  await Reflect.get(instance, "controlPlane").token()
  runtimeCache(instance).markVerified(instance.transport(4000), accountingPolicyStart.opencodeGeneration, true)
  const reservationID = crypto.randomUUID(), central = env.SETTINGS.getByName("global")
  const reserve = await central.fetch("https://settings/usage/reserve", { method: "POST", body: JSON.stringify({ conversationID: runtime.id.toString(), reservationID, costUSD: 0.1 }) })
  expect(reserve.status).toBe(200)
  const { date } = await reserve.json() as { date: string }
  await store.patch({ phase: "running", sessionID, transport: "slack", slack: { channel: "CREPLYTEST", replyTs: "100.1" }, runStartedAt: now - 20,
    budgetReservation: { reservationID, date, dispatched: true } })
  const turn = Reflect.get(instance, "turnExecution") as ConversationTurnExecution
  const options = Reflect.get(turn, "options")
  options.checkpoints = { capture: async () => { checkpointCaptures++; return true } }
  const finalReplies = Reflect.get(instance, "finalReplies"), replyOptions = Reflect.get(finalReplies, "options")
  const realSchedule = replyOptions.schedule
  replyOptions.schedule = (at: number) => realSchedule(at + 60000) // Test clock owns physical wakes.
  replyOptions.send = async (target: { channel: string; replyTs?: string }, text: string) => {
    attempts++
    if (failFirst && attempts === 1) throw new Error("Synthetic transient Slack response failure")
    delivered.push({ text, channel: target.channel, thread: target.replyTs! })
  }
  const scheduler = Reflect.get(instance, "scheduler") as ConversationScheduler
  await scheduler.schedule("turn:observe", Date.now(), { reservationID, reservationDate: date, sessionID, reason: "reply-regression" })
  async function dueReplies() {
    for (const [key, value] of await runtime.storage.list<Record<string, unknown>>({ prefix: "finalReply:" })) {
      if (value.status === "pending") await runtime.storage.put(key, { ...value, nextAttemptAt: Date.now() - 1 })
    }
  }
  async function delivery() { await dueReplies(); await driveConversationJobs(instance, runtime.storage, ["reply:deliver"]) }
  return { store, scheduler, finalReplies, replyOptions, delivered, delivery, dueReplies, attempts: () => attempts, contextReads: () => contextReads, checkpoints: () => checkpointCaptures }
}

beforeEach(async () => {
  await runInDurableObject(env.SETTINGS.getByName("global"), async (_instance, runtime) => runtime.storage.deleteAll())
  await env.SETTINGS.getByName("global").fetch("https://settings/put", { method: "POST", body: JSON.stringify({ streaming: false, dailyBudgetUSD: 1 }) })
})

describe("final Slack response acknowledgement", () => {
  it("delivers a terminal text reply through normal settlement without an outage", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("CREPLYTEST:delivery-control"), async (instance, runtime) => {
      const f = await fixture(instance, runtime, false)
      await driveConversationJobs(instance, runtime.storage, ["turn:observe"])
      await f.delivery()
      expect(f.delivered).toEqual([{ text: "A concrete final answer.", channel: "CREPLYTEST", thread: "100.1" }])
      expect((await f.store.get()).phase).toBe("idle")
      expect((await f.store.get()).budgetReservation).toBeUndefined()
    })
  })

  it("delivers an identical answer in a new turn after accepted-turn job bookkeeping fails", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("CREPLYTEST:identical-after-start-fault"), async (instance, runtime) => {
      const f = await fixture(instance, runtime, false)
      await f.store.patch({ lastReply: "A concrete final answer.", lastSlackReply: "A concrete final answer." })
      const admissions = Reflect.get(instance, "admissions"), options = Reflect.get(admissions, "options")
      const schedule = options.jobs.schedule
      let first = true
      options.jobs.schedule = async (...args: unknown[]) => {
        if (first) { first = false; throw new Error("Synthetic accepted-turn job write failure") }
        return schedule(...args)
      }
      await admissions.recordAccepted(undefined, "acknowledged")
      await driveConversationJobs(instance, runtime.storage, ["turn:observe"])
      await f.delivery()
      expect(f.delivered).toEqual([{ text: "A concrete final answer.", channel: "CREPLYTEST", thread: "100.1" }])
      expect((await f.store.get()).phase).toBe("idle")
    })
  })

  it("retries the final Slack reply after successful accounting releases its reservation", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("CREPLYTEST:delivery-after-release"), async (instance, runtime) => {
      const f = await fixture(instance, runtime, true)
      await driveConversationJobs(instance, runtime.storage, ["turn:observe"])
      await f.delivery()
      const afterFailure = await f.store.get()
      expect(f.attempts()).toBe(1)
      expect(afterFailure.budgetReservation).toBeUndefined()
      const usage = await (await env.SETTINGS.getByName("global").fetch("https://settings/usage/today")).json() as { costUSD: number; reservedUSD: number }
      expect(usage.costUSD).toBeCloseTo(0.01)
      expect(usage.reservedUSD).toBe(0)
      // The independent job owns delivery after the old budget fence is gone.
      const readsBeforeRetry = f.contextReads()
      await f.delivery()
      expect(f.contextReads()).toBe(readsBeforeRetry)
      await f.delivery()
      expect(f.delivered).toEqual([{ text: "A concrete final answer.", channel: "CREPLYTEST", thread: "100.1" }])
      expect((await f.store.get()).lastSlackReply).toBe("A concrete final answer.")
      expect((await f.store.get()).budgetReservation).toBeUndefined()
    })
  })
  it("keeps the frozen target across a new session and reconstructs its delivery wake from durable rows", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("CREPLYTEST:frozen-old-turn"), async (instance, runtime) => {
      const f = await fixture(instance, runtime, true)
      await driveConversationJobs(instance, runtime.storage, ["turn:observe"])
      await f.delivery()
      await f.store.patch({ phase: "idle", sessionID: "ses_next", runStartedAt: Date.now() + 100, slack: { channel: "COTHER", replyTs: "200.1" }, lastSlackReply: "new turn marker" })
      const reads = f.contextReads()
      Reflect.set(instance, "finalReplies", new ConversationFinalReplies(f.replyOptions))
      await f.scheduler.capability.cancel("reply:deliver")
      await Reflect.get(f.scheduler, "installLegacyAlarmBootstrap").call(f.scheduler)
      expect(f.scheduler.has("reply:deliver")).toBe(true)
      await f.delivery()
      expect(f.delivered).toEqual([{ text: "A concrete final answer.", channel: "CREPLYTEST", thread: "100.1" }])
      expect((await f.store.get()).lastSlackReply).toBe("new turn marker")
      expect(f.contextReads()).toBe(reads)
    })
  })

  it("does not repeat acknowledged chunks when a later Slack chunk fails", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("CREPLYTEST:chunk-progress"), async (instance, runtime) => {
      const text = "A".repeat(3900) + "\n" + "B".repeat(3000)
      const f = await fixture(instance, runtime, false, text), accepted: string[] = []
      let attempts = 0
      f.replyOptions.send = async (_target: unknown, chunk: string) => {
        attempts++
        if (attempts === 2) throw new Error("Synthetic later chunk refusal")
        accepted.push(chunk)
      }
      await driveConversationJobs(instance, runtime.storage, ["turn:observe"])
      await f.delivery(); await f.delivery()
      expect(accepted).toEqual(chunkText(text))
      expect(attempts).toBe(chunkText(text).length + 1)
      expect((await f.store.get()).lastSlackReply).toBe(text)
    })
  })

  it("retains at-least-once semantics when Slack accepted a chunk but its acknowledgement was lost", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("CREPLYTEST:ack-loss"), async (instance, runtime) => {
      const f = await fixture(instance, runtime, false), accepted: string[] = []
      f.replyOptions.send = async (_target: unknown, text: string) => {
        accepted.push(text)
        if (accepted.length === 1) throw new Error("Synthetic accepted Slack response lost")
      }
      await driveConversationJobs(instance, runtime.storage, ["turn:observe"])
      const reads = f.contextReads()
      await f.delivery(); await f.delivery()
      expect(accepted).toEqual(["A concrete final answer.", "A concrete final answer."])
      expect(f.contextReads()).toBe(reads)
      expect((await f.store.get()).budgetReservation).toBeUndefined()
    })
  })

  it("sends an honest fallback when successful terminal content contains no public text", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("CREPLYTEST:no-public-text"), async (instance, runtime) => {
      const f = await fixture(instance, runtime, false, null)
      await driveConversationJobs(instance, runtime.storage, ["turn:observe"])
      await f.delivery()
      expect(f.delivered).toHaveLength(1)
      expect(f.delivered[0]?.text).toContain("without a public answer")
      expect(JSON.stringify(f.delivered)).not.toContain("PRIVATE_")
      expect(JSON.stringify([...await runtime.storage.list({ prefix: "finalReply:" })])).not.toContain("PRIVATE_")
    })
  })

  it("preserves pending replies through sealed startup and republishes them with the resumed epoch", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("CREPLYTEST:sealed-recovery"), async (instance, runtime) => {
      const f = await fixture(instance, runtime, true)
      await driveConversationJobs(instance, runtime.storage, ["turn:observe"])
      await f.delivery()
      await f.scheduler.capability.cancel("reply:deliver")
      await runtime.storage.put("lifecycleJobsSealed", true)
      await f.store.patch({ lifecycleJobsSealed: true })
      await Reflect.get(f.scheduler, "installLegacyAlarmBootstrap").call(f.scheduler)
      expect(f.scheduler.has("reply:deliver")).toBe(false)
      await f.scheduler.resumeSealedIdle(await f.scheduler.evidence(), await f.store.get())
      expect(f.scheduler.has("reply:deliver")).toBe(true)
      await f.delivery()
      expect(f.delivered).toHaveLength(1)
      expect(f.delivered[0]?.text).toBe("A concrete final answer.")
    })
  })

  it("bounds a delivery wake to four attempted chunks even when every pending reply fails", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("CREPLYTEST:outage-attempt-bound"), async (instance, runtime) => {
      const f = await fixture(instance, runtime, false)
      await driveConversationJobs(instance, runtime.storage, ["turn:observe"])
      for (let index = 1; index <= 4; index++) {
        await f.store.patch({ runStartedAt: Date.now() + index })
        await f.finalReplies.prepare(await f.store.get(), `Public answer ${index}`, `assistant-${index}`)
      }
      let attempts = 0
      f.replyOptions.send = async () => { attempts++; throw new Error("Synthetic total Slack outage") }
      await f.delivery()
      expect(attempts).toBe(4)
      expect([...await runtime.storage.list<{ status: string }>({ prefix: "finalReply:" })].filter(([, row]) => row.status === "pending")).toHaveLength(5)
    })
  })

})
