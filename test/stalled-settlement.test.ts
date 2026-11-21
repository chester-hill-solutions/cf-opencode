import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { ConversationTurnExecution } from "../src/conversation/turn-execution"
import { ConversationStore, type ConversationState } from "../src/state"
import { makeClient } from "../src/opencode"
import { defaultSettings } from "../src/settings"
import type { ConversationEvent } from "../src/events"

/**
 * A dispatched turn whose provider outcome never arrives can never settle. Polling
 * it forever keeps a container slot alive for a turn no operator can act on, so a
 * turn past the stall ceiling is closed with its reservation retained.
 */

const STALLED_AGE_MS = 61 * 60_000

function harness(runtime: DurableObjectState, state: ConversationState, events: ConversationEvent[], jobs: number[]) {
  const store = new ConversationStore(runtime.storage)
  const client = makeClient(async () => Response.json({ data: [] }))
  const execution = new ConversationTurnExecution({
    conversationID: runtime.id.toString(),
    storage: runtime.storage,
    store,
    usage: { refresh: async () => {}, recordContext: async () => {} },
    checkpoints: { capture: async () => true },
    controlPlane: { pendingForms: async () => [] },
    runtime: { openStream: async () => new Response(null), withClient: async (fn) => fn(client) },
    guards: { recovering: () => false, hasPendingUpgrade: async () => false },
    delivery: {
      event: async (event) => { events.push(event) },
      toSlack: async () => {},
      slack: async () => ({}),
      count: async () => {},
      slackBotToken: () => undefined,
    },
    conversationKey: () => "C1:stalled-settlement",
    jobs: { schedule: async () => { jobs.push(Date.now()) } },
    settings: async () => defaultSettings({}),
    releaseBudgetReservation: async () => true,
    waitUntil: () => {},
  })
  return { store, execution, state }
}

describe("stalled settlement", () => {
  it("closes a turn that outlived the ceiling instead of polling it forever", async () => {
    const stub = env.CONVERSATION.getByName("C1:stalled-settlement")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      await runtime.storage.deleteAll()
      const events: ConversationEvent[] = []
      const jobs: number[] = []
      const state: ConversationState = {
        phase: "running",
        sessionID: "ses_stalled",
        runStartedAt: Date.now() - STALLED_AGE_MS,
        budgetReservation: { reservationID: "r-stalled", date: "2026-11-20", dispatched: true },
        seen: [],
        pending: {},
      }
      await runtime.storage.put("state", state)
      const h = harness(runtime, state, events, jobs)

      await h.execution.pauseSettlement("terminal usage is unavailable")

      return {
        state: await runtime.storage.get<ConversationState>("state"),
        jobs,
        events,
      }
    })

    expect(result.state?.phase).toBe("idle")
    expect(result.state?.runStartedAt).toBeUndefined()
    expect(result.state?.closedTurn).toMatchObject({ reason: "settlement_expired", sessionID: "ses_stalled" })
    // The reservation is an operator decision, not a write-off.
    expect(result.state?.budgetReservation?.reservationID).toBe("r-stalled")
    // A closed turn schedules nothing: that is what frees the container slot.
    expect(result.jobs).toEqual([])
    expect(result.events.some((event) => event.type === "error")).toBe(true)
  })

  it("still pauses a fresh turn within the ceiling", async () => {
    const stub = env.CONVERSATION.getByName("C1:fresh-settlement")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      await runtime.storage.deleteAll()
      const events: ConversationEvent[] = []
      const jobs: number[] = []
      const state: ConversationState = {
        phase: "running",
        sessionID: "ses_fresh",
        runStartedAt: Date.now() - 60_000,
        budgetReservation: { reservationID: "r-fresh", date: "2026-11-20", dispatched: true },
        seen: [],
        pending: {},
      }
      await runtime.storage.put("state", state)
      const h = harness(runtime, state, events, jobs)

      await h.execution.pauseSettlement("terminal usage is unavailable")

      return { state: await runtime.storage.get<ConversationState>("state"), jobs }
    })

    expect(result.state?.closedTurn).toBeUndefined()
    expect(result.state?.settlementError).toBe("terminal usage is unavailable")
    expect(result.jobs.length).toBeGreaterThan(0)
  })
})
