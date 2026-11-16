import { describe, expect, it } from "vitest"
import { env, runInDurableObject, SELF } from "cloudflare:test"
import { ConversationStore, type ConversationState } from "../src/state"
import { newTurn, TURN_RETENTION_COUNT, TURN_RETENTION_MS, turnDigest } from "../src/turns"

/**
 * R1-4a D1: one turn reference per accepted request, replayable, conflict
 * checked, retained and pruned without breaking a live reference.
 */

const auth = { authorization: "Bearer test-token", "content-type": "application/json" }

function send(key: string, body: Record<string, unknown>) {
  return SELF.fetch(`https://harness.test/api/conversations/${key}/messages`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(body),
  })
}

function status(key: string, turnID: string) {
  return SELF.fetch(`https://harness.test/api/conversations/${key}/turns/${turnID}`, {
    headers: { authorization: "Bearer test-token" },
  })
}

async function queuedConversation(key: string) {
  const stub = env.CONVERSATION.getByName(key)
  await runInDurableObject(stub, async (_instance, runtime) => {
    await runtime.storage.put("state", {
      phase: "running",
      sessionID: "ses_turns",
      budgetReservation: { reservationID: "turn-hold", date: "2026-11-16", dispatched: true },
    })
  })
  return stub
}

describe("turn identity", () => {
  it("returns a turn for a queued submission and serves it from status", async () => {
    await queuedConversation("turns:identity")
    const first = await send("turns:identity", { text: "work", idempotencyKey: "k1" })
    expect(first.status).toBe(202)
    const body = await first.json() as {
      replayed: boolean
      queue: { position: number; id: string }
      turn: { id: string; state: string; queuePosition: number }
    }
    expect(body.replayed).toBe(false)
    expect(body.turn.id).toMatch(/^turn_/)
    expect(body.turn).toMatchObject({ state: "queued", queuePosition: body.queue.position })

    const response = await status("turns:identity", body.turn.id)
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(JSON.parse(text).turn).toMatchObject({
      id: body.turn.id,
      state: "queued",
      accounting: { state: "unknown" },
      configuration: { settingsVersion: null, fingerprint: null },
      cancellation: { requested: false, observedStop: false, settled: false },
      recovery: { available: false, fromTurnID: null, restored: false },
    })
    // The digest, the queue entry and the R2 key never reach the caller.
    expect(text).not.toContain("digest")
    expect(text).not.toContain(body.queue.id)
    expect(text).not.toContain("checkpointKey")
  })

  it("replays the same turn for a repeated key and rejects different content", async () => {
    await queuedConversation("turns:replay")
    const first = await send("turns:replay", { text: "work", idempotencyKey: "same" })
    const body = await first.json() as { turn: { id: string } }

    const replay = await send("turns:replay", { text: "work", idempotencyKey: "same" })
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({
      replayed: true,
      duplicate: true,
      turn: { id: body.turn.id },
    })

    const conflict = await send("turns:replay", { text: "different", idempotencyKey: "same" })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: "idempotency_conflict", turnID: body.turn.id })

    const state = await runInDurableObject(env.CONVERSATION.getByName("turns:replay"), async (_instance, runtime) =>
      runtime.storage.get<ConversationState>("state"))
    // The conflict and the replay never added a second queue entry.
    expect(state?.queue).toHaveLength(1)
  })

  it("reports an unknown turn as 404 and a pruned replay as 410", async () => {
    const stub = await queuedConversation("turns:pruned")
    expect((await status("turns:pruned", "turn_missing")).status).toBe(404)

    const digest = await turnDigest({ text: "gone", delivery: "queue" })
    await runInDurableObject(stub, async (_instance, runtime) => {
      await runtime.storage.put("state", {
        phase: "running",
        turns: [],
        turnKeys: { pruned: { turnID: "turn_pruned", digest, at: Date.now() } },
      })
    })
    const replay = await send("turns:pruned", { text: "gone", idempotencyKey: "pruned" })
    expect(replay.status).toBe(410)
    expect(await replay.json()).toMatchObject({ error: "turn_expired" })
  })
})

describe("turn retention", () => {
  it("keeps the newest window and never prunes a referenced turn", async () => {
    const stub = env.CONVERSATION.getByName("turns:retention")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      const store = new ConversationStore(runtime.storage)
      const old = Date.now() - TURN_RETENTION_MS - 60_000
      let oldest = ""
      for (let index = 0; index < TURN_RETENTION_COUNT + 10; index++) {
        const turn = newTurn({
          delivery: "queue",
          digest: `digest-${index}`,
          state: "completed",
          acceptedAt: old - index * 1_000,
        })
        if (index === TURN_RETENTION_COUNT + 9) oldest = turn.id
        await store.beginTurn(turn, index === 0 ? { active: true } : {})
      }
      const kept = await store.get()
      return { count: kept.turns?.length ?? 0, active: kept.turnID, hasOldest: kept.turns?.some((turn) => turn.id === oldest) }
    })
    expect(result.count).toBe(TURN_RETENTION_COUNT + 1)
    expect(result.hasOldest).toBe(true)
    expect(result.active).toBeDefined()
  })
})
