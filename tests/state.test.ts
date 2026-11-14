import { describe, expect, test } from "bun:test"
import { canTransition, ConversationStore, type KeyValueStorage, type QueuedMessage } from "../src/state"
import { DEFAULT_QUEUE_CAPACITY, MAX_QUEUE_CAPACITY, queueCapacity } from "../src/queue"

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
    expect(await store.get()).toEqual({ queue: [], seen: [], pending: {}, permissionNotifications: {} })
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
    const first = await store.appendEvent({ type: "assistant", text: "one" })
    const second = await store.appendEvent({ type: "settled" })

    expect([first, second]).toEqual([1, 2])
    expect((await store.eventsAfter(0)).map((entry) => entry.seq)).toEqual([1, 2])
    expect((await store.eventsAfter(1)).map((entry) => entry.seq)).toEqual([2])
    expect(await store.eventsAfter(2)).toEqual([])
  })

  test("serializes concurrent appends without duplicating ids or reordering", async () => {
    const store = new ConversationStore(fakeStorage())
    const seqs = await Promise.all([
      store.appendEvent({ type: "assistant", text: "one" }),
      store.appendEvent({ type: "settled" }),
      store.appendEvent({ type: "assistant", text: "two" }),
    ])

    expect(seqs).toEqual([1, 2, 3])
    const log = await store.eventsAfter(0)
    expect(log.map((entry) => entry.seq)).toEqual([1, 2, 3])
    expect(log.map((entry) => entry.event.type)).toEqual(["assistant", "settled", "assistant"])
  })

  test("caps the event log", async () => {
    const store = new ConversationStore(fakeStorage())
    for (let i = 0; i < 250; i++) await store.appendEvent({ type: "settled" })
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

  test("serializes concurrent patches so no field is lost", async () => {
    const store = new ConversationStore(fakeStorage())
    await Promise.all([
      store.patch({ sessionID: "ses_1" }),
      store.patch({ lastReply: "one" }),
      store.patch({ lastSlackReply: "two" }),
      store.patch({ checkpointFingerprint: "fp" }),
      store.patch({ lastTurnError: "boom" }),
    ])
    expect(await store.get()).toMatchObject({
      sessionID: "ses_1",
      lastReply: "one",
      lastSlackReply: "two",
      checkpointFingerprint: "fp",
      lastTurnError: "boom",
    })
  })

  test("admits a concurrently delivered event exactly once", async () => {
    const store = new ConversationStore(fakeStorage())
    const results = await Promise.all([
      store.claimEvent("evt_dup"),
      store.claimEvent("evt_dup"),
      store.claimEvent("evt_dup"),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect((await store.get()).seen).toEqual(["evt_dup"])
  })

  test("keeps a tombstone across UTC midnight after the seen window evicts it", async () => {
    const originalNow = Date.now
    let now = Date.UTC(2026, 0, 1, 23, 59)
    Date.now = () => now
    try {
      const store = new ConversationStore(fakeStorage())
      await store.markTombstone("cmd_before_midnight")
      for (let i = 0; i < 250; i++) await store.claimEvent(`other_${i}`)
      expect((await store.get()).seen).not.toContain("cmd_before_midnight")

      now = Date.UTC(2026, 0, 2, 0, 1)
      expect(await store.claimEvent("cmd_before_midnight")).toBe(false)
    } finally {
      Date.now = originalNow
    }
  })

  test("expires tombstones at 24 hours", async () => {
    const originalNow = Date.now
    const markedAt = Date.UTC(2026, 0, 1, 23, 59)
    let now = markedAt
    Date.now = () => now
    try {
      const store = new ConversationStore(fakeStorage())
      await store.markTombstone("cmd_expiring")
      now = markedAt + 24 * 60 * 60 * 1000
      expect(await store.claimEvent("cmd_expiring")).toBe(true)
    } finally {
      Date.now = originalNow
    }
  })

  test("serializes concurrent tombstone updates without losing either id", async () => {
    const originalNow = Date.now
    Date.now = () => Date.UTC(2026, 4, 3, 10)
    try {
      const store = new ConversationStore(fakeStorage())
      await Promise.all([store.markTombstone("cmd_a"), store.markTombstone("cmd_b")])
      for (let i = 0; i < 250; i++) await store.claimEvent(`noise_${i}`)
      expect(await store.claimEvent("cmd_a")).toBe(false)
      expect(await store.claimEvent("cmd_b")).toBe(false)
    } finally {
      Date.now = originalNow
    }
  })

  test("keeps every pending permission recorded concurrently", async () => {
    const store = new ConversationStore(fakeStorage())
    await Promise.all([
      store.rememberPermission("req_1", "ses_1"),
      store.rememberPermission("req_2", "ses_1"),
      store.rememberPermission("req_3", "ses_1"),
    ])
    expect((await store.get()).pending).toEqual({
      req_1: "ses_1",
      req_2: "ses_1",
      req_3: "ses_1",
    })
  })

  test("appends FIFO up to capacity without losing entries", async () => {
    const store = new ConversationStore(fakeStorage())
    const entry = (id: string): QueuedMessage => ({ id, enqueuedAt: Number(id.slice(1)), source: "http", text: id, attempts: 0 })
    expect(await store.enqueue(entry("q1"), 2)).toMatchObject({ kind: "enqueued", position: 1, depth: 1 })
    expect(await store.enqueue(entry("q2"), 2)).toMatchObject({ kind: "enqueued", position: 2, depth: 2 })
    expect(await store.enqueue(entry("q3"), 2)).toMatchObject({ kind: "queue_full", depth: 2, limit: 2 })
    expect((await store.get()).queue?.map(({ id }) => id)).toEqual(["q1", "q2"])
    expect((await store.get()).budgetReservation).toBeUndefined()
  })

  test("supports explicit replacement but refuses replacement during admission", async () => {
    const store = new ConversationStore(fakeStorage())
    const entry: QueuedMessage = { id: "q1", enqueuedAt: 1, source: "http", text: "first", attempts: 0 }
    await store.enqueue(entry)
    await store.enqueue({ ...entry, id: "q2", text: "second" })
    expect(await store.enqueue({ ...entry, id: "q3" }, 10, true)).toMatchObject({ kind: "enqueued", depth: 1 })
    await store.patch({ phase: "admitting" })
    expect(await store.enqueue({ ...entry, id: "q4" }, 10, true)).toMatchObject({ kind: "admission_in_progress" })
    expect((await store.get()).queue?.map(({ id }) => id)).toEqual(["q3"])
  })

  test("normalizes legacy singleton deterministically and persists it on mutation", async () => {
    const storage = fakeStorage()
    storage.map.set("state", { queued: { text: "old", attempts: 2, slack: { channel: "C1" } }, seen: [], pending: {} })
    const store = new ConversationStore(storage)
    expect((await store.get()).queue).toEqual([{ id: "legacy-queued", enqueuedAt: 0, source: "slack", text: "old", attempts: 2, slack: { channel: "C1" } }])
    expect((await store.get()).queued).toBeUndefined()
    await store.patch({ lastReply: "mutation" })
    expect(storage.map.get("state")).toMatchObject({ queue: [{ id: "legacy-queued", enqueuedAt: 0, source: "slack" }], lastReply: "mutation" })
    expect(storage.map.get("state")).not.toHaveProperty("queued")
  })

  test("dispatch marker consumes only a matching queue head and preserves the tail", async () => {
    const store = new ConversationStore(fakeStorage())
    const entry = (id: string): QueuedMessage => ({ id, enqueuedAt: 1, source: "http", text: id, attempts: 0 })
    await store.enqueue(entry("head"))
    await store.enqueue(entry("tail"))
    const reservation = await store.ensureBudgetReservation("r1")
    await store.setBudgetReservationDate(reservation.reservationID, "2026-11-14")
    expect(await store.markBudgetReservationDispatched("r1", "2026-11-14", undefined, "wrong")).toBe(false)
    expect(await store.markBudgetReservationDispatched("r1", "2026-11-14", undefined, "head")).toBe(true)
    const state = await store.get()
    expect(state.queue?.map(({ id }) => id)).toEqual(["tail"])
    expect(state.budgetReservation).toMatchObject({ reservationID: "r1", dispatched: true })
  })

  test("head removal is ID-fenced and leaves every later FIFO item in order", async () => {
    const store = new ConversationStore(fakeStorage())
    const entry = (id: string): QueuedMessage => ({ id, enqueuedAt: Number(id.slice(1)), source: "http", text: id, attempts: 0 })
    await store.enqueue(entry("q1"))
    await store.enqueue(entry("q2"))
    await store.enqueue(entry("q3"))
    expect(await store.removeQueueHead("q2")).toBe(false)
    expect(await store.removeQueueHead("q1")).toBe(true)
    expect((await store.get()).queue?.map(({ id }) => id)).toEqual(["q2", "q3"])
  })

  test("preserves idempotency metadata when recreating a queue head", async () => {
    const storage = fakeStorage()
    const store = new ConversationStore(storage)
    await store.enqueue({
      id: "same-queue-item",
      idempotencyKey: "request-1",
      enqueuedAt: 1,
      source: "http",
      text: "retry me",
      attempts: 0,
    })
    expect(await store.updateQueueHead("same-queue-item", { attempts: 1, lastError: "temporary" })).toBe(true)
    const restartedStore = new ConversationStore(storage)
    expect((await restartedStore.get()).queue?.[0]).toMatchObject({
      id: "same-queue-item",
      idempotencyKey: "request-1",
      attempts: 1,
      lastError: "temporary",
    })
  })

  test("queue capacity uses a documented bounded fallback", () => {
    expect(queueCapacity(undefined)).toBe(DEFAULT_QUEUE_CAPACITY)
    expect(queueCapacity("7")).toBe(7)
    expect(queueCapacity(0)).toBe(DEFAULT_QUEUE_CAPACITY)
    expect(queueCapacity(MAX_QUEUE_CAPACITY + 1)).toBe(DEFAULT_QUEUE_CAPACITY)
    expect(queueCapacity(2.5)).toBe(DEFAULT_QUEUE_CAPACITY)
  })

  test("increments a counter atomically", async () => {
    const store = new ConversationStore(fakeStorage())
    const values = await Promise.all([
      store.increment("containerStarts"),
      store.increment("containerStarts"),
      store.increment("containerStarts"),
    ])
    expect(values.sort((a, b) => a - b)).toEqual([1, 2, 3])
    expect((await store.get()).containerStarts).toBe(3)
  })

  test("preserves concurrent FIFO appends", async () => {
    const store = new ConversationStore(fakeStorage())
    const results = await Promise.all([
      store.enqueue({ id: "one", enqueuedAt: 1, source: "http", text: "one", attempts: 0 }),
      store.enqueue({ id: "two", enqueuedAt: 2, source: "http", text: "two", attempts: 0 }),
      store.enqueue({ id: "three", enqueuedAt: 3, source: "http", text: "three", attempts: 0 }),
    ])
    expect(results.every((result) => result.kind === "enqueued")).toBe(true)
    const state = await store.get()
    expect(state.phase).toBe("queued")
    expect(state.queue?.map(({ text }) => text)).toEqual(["one", "two", "three"])
  })

  test("fills missing fields from a record written by an older build", async () => {
    const storage = fakeStorage()
    storage.map.set("state", { phase: "idle", sessionID: "ses_old" })
    const store = new ConversationStore(storage)
    expect(await store.get()).toMatchObject({ phase: "idle", sessionID: "ses_old", seen: [], pending: {} })
    // A claim must not throw on the missing `seen` field.
    expect(await store.claimEvent("evt_1")).toBe(true)
    expect((await store.get()).seen).toEqual(["evt_1"])
  })
})
