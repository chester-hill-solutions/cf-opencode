import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import type { ConversationState } from "../src/state"
import { runtimeCache } from "./helpers/runtime-cache"
import { usageLogResponse } from "./helpers/usage-log"

function installContainer(instance: unknown, calls: { destroy: number; snapshot: number }) {
  const container = {
    running: true,
    async destroy() { calls.destroy++; this.running = false },
    async setInactivityTimeout() {},
    async snapshotContainer() { calls.snapshot++; return { id: "captured-old", size: 99 } },
  }
  const context = (instance as { ctx: object }).ctx
  Object.defineProperty(context, "container", { configurable: true, value: container })
}

async function recycle(instance: { fetch(request: Request): Promise<Response> }) {
  return instance.fetch(new Request("https://conversation/recycle", { method: "POST" }))
}

describe("image upgrade recycle", () => {
  it("checkpoints, clears the old image snapshot, and preserves conversation data", async () => {
    const stub = env.CONVERSATION.getByName("recycle-current-image-success")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const state: ConversationState = { sessionID: "ses_keep", phase: "idle", seen: [], pending: {}, checkpointKey: "r2-archive" }
      await runtime.storage.put("state", state)
      await runtime.storage.put("usage-source:keep", { sourceID: "source-1", amount: 1 })
      await runtime.storage.put("snapshot", { id: "old-image-snapshot", size: 10 })
      const calls = { checkpoint: 0, capture: 0, destroy: 0, snapshot: 0 }
      installContainer(instance, calls)
      const internal = instance as unknown as {
        checkpoints: { captureOwned(): Promise<boolean> }
        captureSnapshot(): Promise<void>
      }
      const cache = runtimeCache(instance)
      internal.checkpoints.captureOwned = async () => { calls.checkpoint++; return true }
      internal.captureSnapshot = async () => { calls.capture++ }
      cache.markVerified({ fetch: async (input) => usageLogResponse(input, "ses_keep", []) }, "old-generation", true)
      cache.applyInactivity((instance as unknown as { ctx: { container: { setInactivityTimeout(ms: number): Promise<void> } } }).ctx.container)
      const response = await recycle(instance)
      return {
        status: response.status,
        body: await response.json(),
        calls,
        state: await runtime.storage.get<ConversationState>("state"),
        source: await runtime.storage.get("usage-source:keep"),
        snapshot: await runtime.storage.get("snapshot"),
        ready: cache.ready,
        opencodePort: cache.apiPort,
        generation: cache.generation,
        inactivitySet: cache.inactivitySet,
      }
    })

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true })
    expect(result.calls).toEqual({ checkpoint: 1, capture: 0, destroy: 1, snapshot: 0 })
    expect(result.snapshot).toBeUndefined()
    expect(result.state).toMatchObject({
      sessionID: "ses_keep", phase: "idle", seen: [], pending: {}, checkpointKey: "r2-archive",
    })
    expect(result.source).toEqual({ sourceID: "source-1", amount: 1 })
    expect(result.ready).toBe(false)
    expect(result.opencodePort).toBeUndefined()
    expect(result.generation).toBeUndefined()
    expect(result.inactivitySet).toBe(false)
  })

  it("rejects a busy or held conversation before checkpointing or destroying", async () => {
    const stub = env.CONVERSATION.getByName("recycle-current-image-busy")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      await runtime.storage.put("state", {
        sessionID: "ses_busy", phase: "running", seen: [], pending: [],
        budgetReservation: { reservationID: "hold", dispatched: true },
      })
      await runtime.storage.put("snapshot", { id: "old-image-snapshot", size: 10 })
      const calls = { checkpoint: 0, capture: 0, destroy: 0, snapshot: 0 }
      installContainer(instance, calls)
      ;(instance as unknown as { checkpoints: { captureOwned(): Promise<boolean> } }).checkpoints.captureOwned = async () => { calls.checkpoint++; return true }
      const response = await recycle(instance)
      return { status: response.status, calls, snapshot: await runtime.storage.get("snapshot") }
    })
    expect(result.status).toBe(409)
    expect(result.calls).toEqual({ checkpoint: 0, capture: 0, destroy: 0, snapshot: 0 })
    expect(result.snapshot).toEqual({ id: "old-image-snapshot", size: 10 })
  })

  it("leaves the old snapshot and container untouched when checkpointing fails", async () => {
    const stub = env.CONVERSATION.getByName("recycle-current-image-checkpoint-fail")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      await runtime.storage.put("state", { sessionID: "ses_keep", phase: "idle", seen: [], pending: {} })
      await runtime.storage.put("snapshot", { id: "old-image-snapshot", size: 10 })
      const calls = { checkpoint: 0, capture: 0, destroy: 0, snapshot: 0 }
      installContainer(instance, calls)
      const internal = instance as unknown as { checkpoints: { captureOwned(): Promise<boolean> }; captureSnapshot(): Promise<void> }
      internal.checkpoints.captureOwned = async () => { calls.checkpoint++; return false }
      internal.captureSnapshot = async () => { calls.capture++ }
      runtimeCache(instance).markVerified({ fetch: async (input) => usageLogResponse(input, "ses_keep", []) }, "old-generation", true)
      const response = await recycle(instance)
      return { status: response.status, body: await response.json(), calls, snapshot: await runtime.storage.get("snapshot") }
    })
    expect(result.status).toBe(503)
    expect(result.body).toMatchObject({ ok: false })
    expect(result.calls).toEqual({ checkpoint: 1, capture: 0, destroy: 0, snapshot: 0 })
    expect(result.snapshot).toEqual({ id: "old-image-snapshot", size: 10 })
  })
})
