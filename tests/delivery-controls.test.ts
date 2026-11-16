import { describe, expect, it } from "bun:test"
import { ConversationStore, type KeyValueStorage, type QueuedMessage } from "../src/state"
import { ConversationDeliveryControls } from "../src/conversation/delivery-controls"

function fakeStorage() {
  const map = new Map<string, unknown>()
  const storage = {
    map,
    async get<T>(key: string): Promise<T | undefined> {
      return map.get(key) as T | undefined
    },
    async put(key: string, value: unknown): Promise<void> {
      map.set(key, value)
    },
    async transaction<T>(callback: () => Promise<T>): Promise<T> {
      const snapshot = structuredClone([...map.entries()])
      try {
        return await callback()
      } catch (error) {
        map.clear()
        for (const [key, value] of snapshot) map.set(key, value)
        throw error
      }
    },
  }
  return storage
}

function fakeKV(storage: ReturnType<typeof fakeStorage>): KeyValueStorage {
  return {
    get: (key) => storage.get(key),
    put: (key, value) => storage.put(key, value),
  }
}

function harness(options: {
  phase?: "idle" | "queued" | "admitting" | "running" | "settling"
  queue?: QueuedMessage[]
  hold?: boolean
  unavailable?: boolean
  admitting?: boolean
  queueLimit?: number
  interruptError?: boolean
  scheduleError?: boolean
} = {}) {
  const storage = fakeStorage()
  const store = new ConversationStore(fakeKV(storage))
  const calls: Array<[string, ...unknown[]]> = []
  const control = new ConversationDeliveryControls({
    storage,
    store,
    withLock: async (task) => task(),
    unavailable: async () => options.unavailable ?? false,
    admitting: () => options.admitting ?? false,
    queueLimit: options.queueLimit ?? 4,
    steer: async (sessionID, text) => { calls.push(["steer", sessionID, text]) },
    interrupt: async (sessionID) => {
      calls.push(["interrupt", sessionID])
      if (options.interruptError) throw new Error("provider transport lost")
    },
    schedule: async () => {
      calls.push(["schedule"])
      if (options.scheduleError) throw new Error("durable schedule unavailable")
    },
    event: async (event) => { calls.push(["event", event]) },
  })
  const setup = async () => {
    await store.setSession("session-a", "http")
    await store.patch({
      phase: options.phase ?? "running",
      runStartedAt: 100,
      ...(options.hold === false ? {} : { budgetReservation: { reservationID: "hold-a", date: "2026-11-14", dispatched: true } }),
      queue: options.queue ?? [],
    })
  }
  return { storage, store, control, calls, setup }
}

const queueItem = (id: string, text = `prompt ${id}`): QueuedMessage => ({
  id, enqueuedAt: 100, source: "http", text, attempts: 0,
})

describe("ConversationDeliveryControls", () => {
  it("steers only an active dispatched turn and never creates a reservation", async () => {
    const h = harness()
    await h.setup()
    const before = await h.store.get()
    const result = await h.control.steer("  be concise  ")
    const after = await h.store.get()

    expect(result).toMatchObject({ ok: true, status: 200, delivery: "steer", outcome: "acknowledged" })
    expect(h.calls).toContainEqual(["steer", "session-a", "be concise"])
    expect(after.budgetReservation).toEqual(before.budgetReservation)
    expect(after.phase).toBe("running")
    expect(h.storage.map.has("interruptIntent")).toBe(false)
  })

  it("refuses steer without a dispatched hold", async () => {
    const h = harness({ hold: false })
    await h.setup()
    expect(await h.control.steer("guidance")).toMatchObject({ ok: false, status: 409 })
    expect(h.calls).toEqual([])
  })

  it("persists an acknowledged stop intent and retains the hold and active phase", async () => {
    const h = harness()
    await h.setup()
    const result = await h.control.stop()
    const state = await h.store.get()

    expect(result).toMatchObject({
      ok: true, status: 200, delivery: "interrupt", outcome: "acknowledged",
      stopRequested: true, observedStop: null, settled: false,
    })
    expect(h.storage.map.get("interruptIntent")).toMatchObject({ status: "acknowledged", sessionID: "session-a" })
    expect(state.phase).toBe("running")
    expect(state.budgetReservation).toMatchObject({ reservationID: "hold-a", dispatched: true })
    expect(h.calls.filter(([name]) => name === "interrupt")).toHaveLength(1)
  })

  it("retains ambiguous stop intent and does not retry after service recreation", async () => {
    const h = harness({ interruptError: true })
    await h.setup()
    const first = await h.control.stop()
    const recreated = new ConversationDeliveryControls({
      storage: h.storage,
      store: h.store,
      withLock: async (task) => task(),
      unavailable: async () => false,
      admitting: () => false,
      queueLimit: 4,
      steer: async () => {},
      interrupt: async () => { h.calls.push(["interrupt-again"]) },
      schedule: async () => {},
      event: async () => {},
    })
    const repeated = await recreated.stop()

    expect(first).toMatchObject({ ok: false, status: 502, outcome: "ambiguous", observedStop: null })
    expect(h.storage.map.get("interruptIntent")).toMatchObject({ status: "ambiguous" })
    expect(repeated).toMatchObject({ ok: false, status: 409, error: "interrupt_pending" })
    expect(h.calls.filter(([name]) => String(name).startsWith("interrupt"))).toHaveLength(1)
    expect((await h.store.get()).budgetReservation).toMatchObject({ reservationID: "hold-a", dispatched: true })
  })

  it("rejects a full queue before persisting an intent or calling the provider", async () => {
    const h = harness({ queueLimit: 1, queue: [queueItem("existing")] })
    await h.setup()
    const result = await h.control.stop("follow up")

    expect(result).toMatchObject({ ok: false, status: 429, error: "queue_full" })
    expect(h.storage.map.has("interruptIntent")).toBe(false)
    expect(h.calls.filter(([name]) => name === "interrupt")).toHaveLength(0)
    expect((await h.store.get()).queue?.map((item) => item.id)).toEqual(["existing"])
  })

  it("clears an idle Slack queue or replaces it with an explicit follow-up without SDK calls", async () => {
    const h = harness({ phase: "queued", hold: false, queue: [queueItem("old")] })
    await h.setup()
    const cleared = await h.control.stop(undefined, { slack: { channel: "C1" } })
    expect(cleared).toMatchObject({ ok: true, stopRequested: false })
    expect((await h.store.get()).queue).toEqual([])
    expect((await h.store.get()).phase).toBe("idle")

    const replaced = await h.control.stop("fresh", { replaceQueue: true, slack: { channel: "C1" } })
    const state = await h.store.get()
    expect(replaced).toMatchObject({ ok: true, status: 202, stopRequested: false, queue: { position: 1, depth: 1 } })
    expect(state.queue).toHaveLength(1)
    expect(state.queue?.[0]).toMatchObject({ text: "fresh", source: "slack", slack: { channel: "C1" } })
    expect(h.calls.filter(([name]) => name === "interrupt")).toHaveLength(0)
    expect(h.calls.filter(([name]) => name === "schedule")).toHaveLength(1)
  })

  it("rolls back an idle follow-up when its durable queue wake cannot be scheduled", async () => {
    const h = harness({ phase: "idle", hold: false, scheduleError: true })
    await h.setup()
    const result = await h.control.stop("retry later", { replaceQueue: true, slack: { channel: "C1" } })

    expect(result).toMatchObject({ ok: false, status: 503, error: "conversation_unavailable" })
    expect((await h.store.get()).queue).toEqual([])
    expect((await h.store.get()).phase).toBe("idle")
    expect(h.calls.filter(([name]) => name === "interrupt")).toHaveLength(0)
    expect(h.calls.filter(([name]) => name === "schedule")).toHaveLength(1)
  })

  it("rejects stop while admitting and honors requireActive on idle HTTP stop", async () => {
    const admitting = harness({ phase: "admitting" })
    await admitting.setup()
    expect(await admitting.control.stop("replace", { replaceQueue: true })).toMatchObject({ ok: false, status: 409 })
    expect((await admitting.store.get()).queue).toEqual([])
    const idle = harness({ phase: "idle", hold: false })
    await idle.setup()
    expect(await idle.control.stop(undefined, { requireActive: true })).toMatchObject({ ok: false, status: 409 })
    expect(idle.calls).toEqual([])
  })

  it("blocks all controls when the conversation is unavailable", async () => {
    const h = harness({ unavailable: true })
    await h.setup()
    expect(await h.control.steer("guidance")).toMatchObject({ ok: false, status: 503 })
    expect(await h.control.stop()).toMatchObject({ ok: false, status: 503 })
    expect(h.calls).toEqual([])
    expect(h.storage.map.has("interruptIntent")).toBe(false)
  })
})
