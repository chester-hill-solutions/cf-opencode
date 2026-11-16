import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { ConversationStore } from "../src/state"
import { formatSse } from "../src/events"
import { turnStatusReceipt } from "../src/conversation/turn-replies"
import { newTurn } from "../src/turns"

/**
 * R1-4b: replayable frames name the turn that produced them, and turn status
 * reports output availability from the retained log rather than promising a
 * replay it cannot serve.
 */

describe("turn-correlated frames", () => {
  it("serialises turnID into the SSE payload", () => {
    const frame = formatSse({ type: "assistant", text: "hello", turnID: "turn_1" }, 7)
    expect(frame).toContain("id: 7")
    expect(frame).toContain('"turnID":"turn_1"')
    expect(formatSse({ type: "settled" })).not.toContain("turnID")
  })

  it("stamps the active turn when an event is delivered", async () => {
    const stub = env.CONVERSATION.getByName("turn-events:deliver")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      await runtime.storage.put("state", { phase: "running", sessionID: "ses_e", turnID: "turn_active" })
      const deliver = (event: Parameters<typeof formatSse>[0]) =>
        (instance as unknown as { deliver(event: unknown): Promise<void> }).deliver(event)
      await deliver({ type: "assistant", text: "hello" })
      return new ConversationStore(runtime.storage).eventsAfter(0)
    })

    expect(result).toHaveLength(1)
    expect(result[0]?.event).toEqual({ type: "assistant", text: "hello", turnID: "turn_active" })
  })
})

describe("turn output availability", () => {
  it("distinguishes retained, expired and never-produced output", async () => {
    const stub = env.CONVERSATION.getByName("turn-events:output")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      const store = new ConversationStore(runtime.storage)
      const retained = newTurn({ delivery: "queue", digest: "a", state: "completed", acceptedAt: Date.now() - 1000 })
      const expired = newTurn({ delivery: "queue", digest: "b", state: "completed", acceptedAt: Date.now() - 1000 })
      const queued = newTurn({ delivery: "queue", digest: "c", state: "queued", acceptedAt: Date.now() })
      await store.beginTurn(retained)
      await store.beginTurn(expired)
      await store.beginTurn(queued)
      await store.transitionTurn(retained.id, { startedAt: 1, finishedAt: 2 })
      await store.transitionTurn(expired.id, { startedAt: 1, finishedAt: 2 })
      await store.appendEvent({ type: "assistant", text: "kept", turnID: retained.id })
      const read = async (id: string) => {
        const response = await turnStatusReceipt(store, id)
        return (await response.json() as { turn: { output: unknown } }).turn.output
      }
      return { retained: await read(retained.id), expired: await read(expired.id), queued: await read(queued.id) }
    })

    expect(result.retained).toEqual({ available: true, replay: "retained" })
    expect(result.expired).toEqual({ available: false, replay: "expired" })
    expect(result.queued).toEqual({ available: false, replay: "none" })
  })
})
