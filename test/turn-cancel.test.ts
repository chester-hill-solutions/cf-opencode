import { describe, expect, it } from "vitest"
import { env, runInDurableObject, SELF } from "cloudflare:test"
import { ConversationStore, type ConversationState } from "../src/state"
import { cancelTurn } from "../src/conversation/turn-replies"
import { newTurn } from "../src/turns"
import type { ConversationDeliveryControls } from "../src/conversation/delivery-controls"

/**
 * R1-4b cancellation targets exactly one turn. A cancel must never clear a
 * newer follow-up, and an acknowledgement never settles accounting.
 */

const store = (runtime: DurableObjectState) => new ConversationStore(runtime.storage)

function delivery(result: Awaited<ReturnType<ConversationDeliveryControls["stop"]>>) {
  return { stop: async () => result } as unknown as ConversationDeliveryControls
}

describe("turn cancellation", () => {
  it("clears only the queued turn it targets", async () => {
    const stub = env.CONVERSATION.getByName("cancel:queued")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      const turns = store(runtime)
      const turn = newTurn({ delivery: "queue", digest: "d", state: "queued" })
      await turns.beginTurn({ ...turn, queueID: "q1" })
      await runtime.storage.put("state", {
        ...(await runtime.storage.get<ConversationState>("state")),
        phase: "queued",
        queue: [
          { id: "q1", enqueuedAt: 1, source: "http", text: "first", turnID: turn.id, attempts: 0 },
          { id: "q2", enqueuedAt: 2, source: "http", text: "newer", attempts: 0 },
        ],
      })
      const response = await cancelTurn(turns, delivery({ ok: true, status: 200, delivery: "interrupt" }), turn.id)
      return {
        status: response.status,
        body: await response.json(),
        state: await runtime.storage.get<ConversationState>("state"),
      }
    })

    expect(result.status).toBe(202)
    expect(result.body).toMatchObject({ ok: true, cancellation: { requested: true, queuedCleared: true, settled: true } })
    expect(result.state?.queue?.map((entry) => entry.id)).toEqual(["q2"])
    expect(result.state?.turns?.[0]?.state).toBe("cancelled")
  })

  it("stops the active turn and preserves the waiting queue", async () => {
    const stub = env.CONVERSATION.getByName("cancel:active")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      const turns = store(runtime)
      const turn = newTurn({ delivery: "queue", digest: "d", state: "running" })
      await turns.beginTurn(turn, { active: true })
      await runtime.storage.put("state", {
        ...(await runtime.storage.get<ConversationState>("state")),
        phase: "running",
        sessionID: "ses_c",
        queue: [{ id: "q-next", enqueuedAt: 3, source: "http", text: "follow-up", attempts: 0 }],
      })
      const response = await cancelTurn(
        turns,
        delivery({ ok: true, status: 200, delivery: "interrupt", stopRequested: true, observedStop: null, settled: false }),
        turn.id,
      )
      const state = await runtime.storage.get<ConversationState>("state")
      return { status: response.status, body: await response.json(), queue: state?.queue, turn: state?.turns?.[0] }
    })

    expect(result.status).toBe(202)
    expect(result.body).toMatchObject({ cancellation: { requested: true, queuedCleared: false, observedStop: true, settled: false } })
    expect(result.queue?.map((entry) => entry.id)).toEqual(["q-next"])
    expect(result.turn?.cancellation).toEqual({ requested: true, observedStop: true, settled: false })
  })

  it("refuses a terminal turn and a turn that is not the active one", async () => {
    const stub = env.CONVERSATION.getByName("cancel:refusals")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      const turns = store(runtime)
      const done = newTurn({ delivery: "queue", digest: "d", state: "completed" })
      const other = newTurn({ delivery: "queue", digest: "e", state: "running" })
      await turns.beginTurn(done)
      await turns.beginTurn(other, { active: true })
      const terminal = await cancelTurn(turns, delivery({ ok: true, status: 200, delivery: "interrupt" }), done.id)
      const wrong = await cancelTurn(turns, delivery({ ok: true, status: 200, delivery: "interrupt" }), "turn_missing")
      return {
        terminal: { status: terminal.status, body: await terminal.json() },
        unknown: { status: wrong.status, body: await wrong.json() },
      }
    })

    expect(result.terminal).toEqual({ status: 409, body: { ok: false, error: "already_terminal" } })
    expect(result.unknown).toEqual({ status: 404, body: { error: "unknown_turn" } })
  })

  it("serves the public cancel route without starting a turn", async () => {
    const stub = env.CONVERSATION.getByName("cancel:route")
    const turn = await runInDurableObject(stub, async (_instance, runtime) => {
      const turns = store(runtime)
      const record = newTurn({ delivery: "queue", digest: "d", state: "queued" })
      await turns.beginTurn({ ...record, queueID: "q-route" })
      await runtime.storage.put("state", {
        ...(await runtime.storage.get<ConversationState>("state")),
        phase: "queued",
        queue: [{ id: "q-route", enqueuedAt: 1, source: "http", text: "waiting", turnID: record.id, attempts: 0 }],
      })
      return record.id
    })
    const response = await SELF.fetch(`https://harness.test/api/conversations/cancel:route/turns/${turn}/cancel`, {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
    })
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ ok: true, cancellation: { queuedCleared: true, settled: true } })
  })
})
