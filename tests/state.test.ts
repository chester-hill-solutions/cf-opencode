import { describe, expect, test } from "bun:test"
import { ConversationStore, type KeyValueStorage } from "../src/state"

function fakeStorage(): KeyValueStorage & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>()
  return {
    map,
    async get<T>(key: string): Promise<T | undefined> {
      return map.get(key) as T | undefined
    },
    async put(key: string, value: unknown): Promise<void> {
      map.set(key, value)
    },
  }
}

describe("ConversationStore", () => {
  test("starts empty", async () => {
    const store = new ConversationStore(fakeStorage())
    expect(await store.get()).toEqual({ seen: [], pending: {} })
  })

  test("dedupes event ids", async () => {
    const store = new ConversationStore(fakeStorage())
    expect(await store.seenBefore("evt_1")).toBe(false)
    expect(await store.seenBefore("evt_1")).toBe(true)
    expect(await store.seenBefore("evt_2")).toBe(false)
  })

  test("keeps the session, transport and Slack target", async () => {
    const store = new ConversationStore(fakeStorage())
    await store.setSession("ses_1", "slack", { channel: "C1", replyTs: "111.222" })
    const state = await store.get()
    expect(state.sessionID).toBe("ses_1")
    expect(state.transport).toBe("slack")
    expect(state.slack).toEqual({ channel: "C1", replyTs: "111.222" })
  })

  test("remembers and consumes pending permissions once", async () => {
    const store = new ConversationStore(fakeStorage())
    await store.rememberPermission("req_1", "ses_1")
    expect(await store.takePermission("req_1")).toBe("ses_1")
    expect(await store.takePermission("req_1")).toBeUndefined()
  })

  test("caps the dedupe list", async () => {
    const storage = fakeStorage()
    const store = new ConversationStore(storage)
    for (let i = 0; i < 250; i++) await store.seenBefore(`evt_${i}`)
    const state = await store.get()
    expect(state.seen.length).toBe(200)
    expect(state.seen[state.seen.length - 1]).toBe("evt_249")
  })
})
