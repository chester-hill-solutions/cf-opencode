import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { ConversationTurnExecution } from "../src/conversation/turn-execution"
import { ConversationStore, type ConversationState } from "../src/state"
import { makeClient } from "../src/opencode"
import { defaultSettings } from "../src/settings"
import type { ConversationEvent } from "../src/events"

function harness(runtime: DurableObjectState, post: () => Promise<Record<string, unknown>>) {
  const store = new ConversationStore(runtime.storage)
  const events: ConversationEvent[] = []
  const counts: string[] = []
  let terminal = false
  let releases = 0
  const client = makeClient(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname.endsWith("/permission")) return Response.json({ data: [] })
    if (url.pathname.endsWith("/context")) return Response.json({ data: terminal ? [
      { id: "u1", type: "user" },
      { id: "a1", type: "assistant", content: [{ type: "text", text: "done" }], cost: 0.1,
        finish: "stop", time: { created: Date.now(), completed: Date.now() } },
    ] : [{ id: "u1", type: "user" }] })
    throw new Error(`unexpected request: ${url.pathname}`)
  })
  const create = () => new ConversationTurnExecution({
    conversationID: runtime.id.toString(), storage: runtime.storage, store,
    usage: { refresh: async () => {}, recordContext: async () => {} },
    checkpoints: { capture: async () => true },
    controlPlane: { pendingForms: async () => [{ id: "form1", title: "Choose", fields: [] }] },
    runtime: { openStream: async () => new Response(null), withClient: async (fn) => fn(client) },
    guards: { recovering: () => false, hasPendingUpgrade: async () => false },
    delivery: {
      event: async (event) => { events.push(event) }, toSlack: async () => {},
      slack: post, count: async (name) => { counts.push(name) }, slackBotToken: () => "synthetic",
    },
    conversationKey: () => "C1:question", jobs: { schedule: async () => {} },
    settings: async () => defaultSettings({}),
    releaseBudgetReservation: async () => {
      releases++
      await store.patch({ budgetReservation: undefined })
      return true
    },
    waitUntil: () => {}, telemetry: () => {},
  })
  return { store, events, counts, create, complete: () => { terminal = true }, releases: () => releases }
}

const running: ConversationState = {
  phase: "running", sessionID: "ses_question", slack: { channel: "C1" },
  budgetReservation: { reservationID: "r1", date: "2026-11-14", dispatched: true },
  seen: [], pending: {},
}

describe("Slack question delivery", () => {
  it("backs off a transient error across service recreation and announces success once", async () => {
    const stub = env.CONVERSATION.getByName("question-transient")
    await runInDurableObject(stub, async (_instance, runtime) => {
      let attempts = 0
      const h = harness(runtime, async () => {
        if (++attempts === 1) throw new Error("chat.postMessage: internal_error")
        return { ok: true }
      })
      await h.store.patch(running)
      expect(await h.create().pumpOnce()).toBe(false)
      expect((await h.store.get()).announcedForms).toBeUndefined()
      await h.create().pumpOnce()
      expect(attempts).toBe(1)
      const retry = await runtime.storage.get<{ sessionID: string; forms: Record<string, { attempts: number; nextAttemptAt: number }> }>("slackFormRetries")
      expect(retry?.forms.form1.attempts).toBe(1)
      await runtime.storage.put("slackFormRetries", {
        ...retry, forms: { form1: { attempts: 1, nextAttemptAt: Date.now() - 1 } },
      })
      await h.create().pumpOnce()
      await h.create().pumpOnce()
      expect(attempts).toBe(2)
      expect((await h.store.get()).announcedForms).toEqual(["form1"])
      expect(h.counts).toEqual(["slack.form.failed"])
    })
  })

  it("settles and releases acknowledged usage even when every question post fails", async () => {
    const stub = env.CONVERSATION.getByName("question-permanent")
    await runInDurableObject(stub, async (_instance, runtime) => {
      let attempts = 0
      const h = harness(runtime, async () => {
        attempts++
        throw new Error("chat.postMessage: missing_scope")
      })
      await h.store.patch(running)
      h.complete()
      expect(await h.create().pumpOnce()).toBe(true)
      expect((await h.store.get()).phase).toBe("idle")
      expect(h.releases()).toBe(1)
      expect(h.counts).toContain("slack.form.failed")
      expect(h.events).toContainEqual(expect.objectContaining({ type: "error", message: expect.stringContaining("question") }))
      expect(h.events).toContainEqual({ type: "settled" })
      await h.create().pumpOnce()
      expect(attempts).toBe(1)
    })
  })

  it("caps permanent-failure backoff at five minutes and does not retry early", async () => {
    const stub = env.CONVERSATION.getByName("question-backoff-cap")
    await runInDurableObject(stub, async (_instance, runtime) => {
      let attempts = 0
      const h = harness(runtime, async () => { attempts++; throw new Error("missing_scope") })
      await h.store.patch(running)
      for (let index = 0; index < 9; index++) {
        const before = Date.now()
        await h.create().pumpOnce()
        const retry = await runtime.storage.get<{ sessionID: string; forms: Record<string, { attempts: number; nextAttemptAt: number }> }>("slackFormRetries")
        const delay = Math.min(5_000 * 2 ** index, 300_000)
        expect(retry?.forms.form1.nextAttemptAt).toBeGreaterThanOrEqual(before + delay)
        expect(retry?.forms.form1.nextAttemptAt).toBeLessThanOrEqual(Date.now() + delay)
        await h.create().pumpOnce()
        expect(attempts).toBe(index + 1)
        await runtime.storage.put("slackFormRetries", {
          ...retry, forms: { form1: { attempts: index + 1, nextAttemptAt: Date.now() - 1 } },
        })
      }
    })
  })
})

describe("settlement observability", () => {
  it("alerts immediately once per pause episode and clears a reservation-less success", async () => {
    const stub = env.CONVERSATION.getByName("settlement-pause-observability")
    await runInDurableObject(stub, async (_instance, runtime) => {
      const h = harness(runtime, async () => ({ ok: true }))
      await h.store.patch({ ...running, budgetReservation: undefined, slack: undefined })
      await h.create().pauseSettlement("usage unavailable")
      await h.create().pauseSettlement("usage unavailable")
      await h.create().pauseSettlement("usage still unavailable")
      expect(h.counts.filter((name) => name === "settlement.paused")).toHaveLength(1)
      expect(h.events.filter((event) => event.type === "error")).toHaveLength(2)
      h.complete()
      await h.create().pumpOnce()
      expect((await h.store.get()).settlementError).toBeUndefined()
      expect((await h.store.get()).phase).toBe("idle")
      expect(h.releases()).toBe(0)
      await h.store.patch({ phase: "running" })
      await h.create().pauseSettlement("another pause")
      expect(h.counts.filter((name) => name === "settlement.paused")).toHaveLength(2)
    })
  })
})
