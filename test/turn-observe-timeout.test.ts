import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { ConversationTurnExecution } from "../src/conversation/turn-execution"
import { ConversationStore, type ConversationState } from "../src/state"
import { makeClient } from "../src/opencode"
import { defaultSettings } from "../src/settings"

/**
 * One unresponsive runtime read used to hold `pumping` for the life of the Durable
 * Object instance: every later observation returned immediately, so a dispatched
 * turn was never settled and its container never closed. The read must be bounded.
 */

const running: ConversationState = {
  phase: "running",
  sessionID: "ses_silent",
  runStartedAt: Date.now() - 60_000,
  budgetReservation: { reservationID: "r1", date: "2026-11-20", dispatched: true },
  seen: [],
  pending: {},
}

function harness(runtime: DurableObjectState, store: ConversationStore, client: ReturnType<typeof makeClient>, calls: { context: number }) {
  return new ConversationTurnExecution({
    conversationID: runtime.id.toString(),
    storage: runtime.storage,
    store,
    usage: { refresh: async () => {}, recordContext: async () => {} },
    checkpoints: { capture: async () => true },
    controlPlane: { pendingForms: async () => [] },
    runtime: {
      openStream: async () => new Response(null),
      withClient: async (fn) => {
        calls.context++
        return fn(client)
      },
    },
    guards: { recovering: () => false, hasPendingUpgrade: async () => false },
    delivery: {
      event: async () => {},
      toSlack: async () => {},
      slack: async () => ({}),
      count: async () => {},
      slackBotToken: () => undefined,
    },
    conversationKey: () => "C1:observe-silent-runtime",
    jobs: { schedule: async () => {} },
    settings: async () => defaultSettings({}),
    releaseBudgetReservation: async () => true,
    waitUntil: () => {},
    observeTimeoutMs: 25,
  })
}

describe("turn observation timeout", () => {
  it("releases the pump when the runtime never answers", async () => {
    const stub = env.CONVERSATION.getByName("C1:observe-silent-runtime")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      const store = new ConversationStore(runtime.storage)
      await runtime.storage.put("state", running)
      const client = makeClient((_input, init) => {
        // A dead container accepts the connection and never answers.
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (!signal) return
          if (signal.aborted) return reject(signal.reason)
          signal.addEventListener("abort", () => reject(signal.reason))
        })
      })
      const calls = { context: 0 }
      const execution = harness(runtime, store, client, calls)

      const startedAt = Date.now()
      const failure = await execution.pumpOnce().then(() => undefined, (error: unknown) => error)
      return {
        failed: failure !== undefined,
        pumping: execution.isPumping,
        elapsedMs: Date.now() - startedAt,
      }
    })

    expect(result.failed).toBe(true)
    // Without the bound this flag stays true for the instance's lifetime.
    expect(result.pumping).toBe(false)
    expect(result.elapsedMs).toBeLessThan(2_000)
  }, 20_000)

  it("does not let a stale pump latch own the turn", async () => {
    const stub = env.CONVERSATION.getByName("C1:observe-stale-latch")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      await runtime.storage.put("state", running)
      const store = new ConversationStore(runtime.storage)
      const calls = { context: 0 }
      const client = makeClient(async (input) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.pathname.endsWith("/context")) return Response.json({ data: [] })
        return Response.json({ data: [] })
      })
      const execution = harness(runtime, store, client, calls)
      const latch = execution as unknown as { pumpStartedAt?: number }

      latch.pumpStartedAt = Date.now()
      const blocked = await execution.pumpOnce()
      const whileFresh = calls.context

      latch.pumpStartedAt = Date.now() - 11 * 60_000
      const ran = await execution.pumpOnce()
      return { blocked, ran, whileFresh, afterStale: calls.context }
    })

    // A latch inside its bound keeps the turn to one pump.
    expect(result.blocked).toBe(false)
    expect(result.whileFresh).toBe(0)
    // Past the bound it belongs to an await that will never return, so a new pump
    // must be allowed: that is the difference from the permanent slot leak.
    expect(result.afterStale).toBeGreaterThan(0)
  }, 20_000)
})
