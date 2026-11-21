import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { ConversationStore, type ConversationState } from "../src/state"
import { STATE_VERSION } from "../src/conversation-state"

/**
 * A Durable Object outlives any single build, so the stored record can predate a
 * field. The shape version is stamped by the store on every write, giving a future
 * migration something to branch on instead of inferring from absent fields.
 */

describe("state shape version", () => {
  it("stamps the version on write and tolerates a record that predates it", async () => {
    const stub = env.CONVERSATION.getByName("C1:state-version")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      await runtime.storage.put("state", { phase: "idle", seen: [], pending: {} })
      const store = new ConversationStore(runtime.storage)
      const legacy = await store.get()

      await store.patch({ lastTurnError: "operator note" })
      const patched = await runtime.storage.get<ConversationState>("state")

      await store.advance("admitting")
      const advanced = await runtime.storage.get<ConversationState>("state")

      return { legacy: legacy.stateVersion, patched: patched?.stateVersion, advanced: advanced?.stateVersion }
    })

    // Reading does not invent history; the first write establishes it.
    expect(result.legacy).toBeUndefined()
    expect(result.patched).toBe(STATE_VERSION)
    expect(result.advanced).toBe(STATE_VERSION)
  })

  it("keeps one current version", () => {
    expect(STATE_VERSION).toBe(1)
  })
})
