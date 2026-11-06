import { describe, expect, test } from "bun:test"
import { canTransition, ConversationStore, type KeyValueStorage } from "../src/state"

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

  test("claims event ids and releases failed ones", async () => {
    const store = new ConversationStore(fakeStorage())
    expect(await store.claimEvent("evt_1")).toBe(true)
    expect(await store.claimEvent("evt_1")).toBe(false)
    expect(await store.claimEvent("evt_2")).toBe(true)
    await store.releaseEvent("evt_1")
    expect(await store.claimEvent("evt_1")).toBe(true)
  })

  test("patch merges into the latest state without clobbering other fields", async () => {
    const store = new ConversationStore(fakeStorage())
    await store.setSession("ses_1", "slack", { channel: "C1" })
    await store.rememberPermission("req_1", "ses_1")
    await store.patch({ lastReply: "hello" })
    const state = await store.get()
    expect(state.lastReply).toBe("hello")
    expect(state.pending).toEqual({ req_1: "ses_1" })
    expect(state.sessionID).toBe("ses_1")
  })

  test("guards lifecycle transitions", async () => {
    const store = new ConversationStore(fakeStorage())
    // A run cannot start before it is admitted.
    expect(await store.advance("running")).toBe(false)
    expect(await store.advance("admitting")).toBe(true)
    expect(await store.advance("running")).toBe(true)
    // A running turn cannot be demoted to the queue.
    expect(await store.advance("queued")).toBe(false)
    expect(await store.advance("settling")).toBe(true)
    expect(await store.advance("idle")).toBe(true)
  })

  test("transition table", () => {
    expect(canTransition("idle", "admitting")).toBe(true)
    expect(canTransition("admitting", "running")).toBe(true)
    expect(canTransition("running", "settling")).toBe(true)
    expect(canTransition("settling", "idle")).toBe(true)
    expect(canTransition("idle", "running")).toBe(false)
    expect(canTransition("running", "queued")).toBe(false)
    expect(canTransition("settling", "admitting")).toBe(false)
  })

  test("records a batch of pending permissions with one write", async () => {
    const storage = fakeStorage()
    const store = new ConversationStore(storage)
    await store.rememberPermissions(["req_1", "req_2", "req_3"], "ses_1")
    expect(await store.get()).toMatchObject({
      pending: { req_1: "ses_1", req_2: "ses_1", req_3: "ses_1" },
    })
    await store.rememberPermissions([], "ses_1")
    expect(Object.keys((await store.get()).pending)).toHaveLength(3)
  })

  test("keeps the session, transport and Slack target", async () => {
    const store = new ConversationStore(fakeStorage())
    await store.setSession("ses_1", "slack", { channel: "C1", replyTs: "111.222" })
    const state = await store.get()
    expect(state.sessionID).toBe("ses_1")
    expect(state.transport).toBe("slack")
    expect(state.slack).toEqual({ channel: "C1", replyTs: "111.222" })
  })

  test("peeks a permission, then clears it after the reply", async () => {
    const store = new ConversationStore(fakeStorage())
    await store.rememberPermission("req_1", "ses_1")
    expect(await store.peekPermission("req_1")).toBe("ses_1")
    expect(await store.peekPermission("req_1")).toBe("ses_1")
    await store.clearPermission("req_1")
    expect(await store.peekPermission("req_1")).toBeUndefined()
  })

  test("sequences SSE events and replays after an id", async () => {
    const store = new ConversationStore(fakeStorage())
    const first = await store.nextSeq()
    await store.appendEvent({ seq: first, event: { type: "assistant", text: "one" } })
    const second = await store.nextSeq()
    await store.appendEvent({ seq: second, event: { type: "settled" } })

    expect([first, second]).toEqual([1, 2])
    expect((await store.eventsAfter(0)).map((entry) => entry.seq)).toEqual([1, 2])
    expect((await store.eventsAfter(1)).map((entry) => entry.seq)).toEqual([2])
    expect(await store.eventsAfter(2)).toEqual([])
  })

  test("caps the event log", async () => {
    const store = new ConversationStore(fakeStorage())
    for (let i = 0; i < 250; i++) {
      const seq = await store.nextSeq()
      await store.appendEvent({ seq, event: { type: "settled" } })
    }
    const all = await store.eventsAfter(0)
    expect(all.length).toBe(200)
    expect(all[all.length - 1]!.seq).toBe(250)
  })

  test("caps the dedupe list", async () => {
    const storage = fakeStorage()
    const store = new ConversationStore(storage)
    for (let i = 0; i < 250; i++) await store.claimEvent(`evt_${i}`)
    const state = await store.get()
    expect(state.seen.length).toBe(200)
    expect(state.seen[state.seen.length - 1]).toBe("evt_249")
  })
})
