import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { ConversationTurnExecution, type PermissionSummary } from "../src/conversation/turn-execution"
import { ConversationStore, type ConversationState } from "../src/state"
import { makeClient } from "../src/opencode"
import { defaultSettings } from "../src/settings"
import type { ConversationEvent } from "../src/events"

const running: ConversationState = {
  phase: "running", sessionID: "ses_permission", slack: { channel: "C1" },
  budgetReservation: { reservationID: "r1", date: "2026-11-14", dispatched: true },
  seen: [], pending: {},
}
const permission = (id: string): PermissionSummary => ({ id, action: "shell", resources: ["synthetic-command"] })

function harness(runtime: DurableObjectState, post: (id: string) => Promise<void>) {
  let store = new ConversationStore(runtime.storage)
  let pending = [permission("p1")]
  let terminal = false
  let unavailable = false
  let contextReads = 0
  let recordedUsage = 0
  let releases = 0
  const attempts: string[] = []
  const events: ConversationEvent[] = []
  const counts: string[] = []
  const client = makeClient(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname.endsWith("/permission")) return unavailable
      ? Response.json({ error: "synthetic unavailable" }, { status: 503 })
      : Response.json({ data: pending })
    if (url.pathname.endsWith("/context")) {
      contextReads++
      return Response.json({ data: terminal ? [
        { id: "u1", type: "user" },
        { id: "a1", type: "assistant", content: [{ type: "text", text: "done" }],
          cost: 0.1, finish: "stop", time: { created: Date.now(), completed: Date.now() } },
      ] : [{ id: "u1", type: "user" }] })
    }
    throw new Error("unexpected synthetic route")
  })
  const create = () => {
    store = new ConversationStore(runtime.storage)
    return new ConversationTurnExecution({
      conversationID: runtime.id.toString(), storage: runtime.storage, store,
      usage: { refresh: async () => {}, recordContext: async () => { recordedUsage++ } },
      checkpoints: { capture: async () => true }, controlPlane: { pendingForms: async () => [] },
      runtime: { openStream: async () => new Response(null), withClient: async (fn) => fn(client) },
      guards: { recovering: () => false, hasPendingUpgrade: async () => false },
      delivery: {
        // Match the production seam: the event can persist/publish before the
        // connector throws, so retries may repeat an unacknowledged SSE event.
        event: async (event) => {
          events.push(event)
          if (event.type === "permission") { attempts.push(event.requestID); await post(event.requestID) }
        },
        toSlack: async () => {}, slack: async () => ({}),
        count: async (name) => { counts.push(name) }, slackBotToken: () => "synthetic",
      },
      conversationKey: () => "C1:permission", jobs: { schedule: async () => {} },
      settings: async () => defaultSettings({}), waitUntil: () => {}, telemetry: () => {},
      releaseBudgetReservation: async () => {
        releases++
        await store.patch({ budgetReservation: undefined })
        return true
      },
    })
  }
  return {
    get store() { return store }, attempts, events, counts, create,
    setPending: (value: PermissionSummary[]) => { pending = value },
    complete: () => { terminal = true }, unavailable: (value: boolean) => { unavailable = value },
    observations: () => ({ contextReads, recordedUsage, releases }),
    async due(id: string) {
      const state = await store.get()
      const notification = state.permissionNotifications?.[id]
      if (!notification) throw new Error("missing durable permission notification")
      await store.patch({ permissionNotifications: {
        ...state.permissionNotifications, [id]: { ...notification, nextAttemptAt: Date.now() - 1 },
      } })
    },
  }
}

describe("permission notification recovery", () => {
  it("retries a failed first request across recreation without losing or repeating the rest of the batch", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("permission-batch-retry"), async (_instance, runtime) => {
      let first = true
      const h = harness(runtime, async (id) => {
        if (id === "p1" && first) { first = false; throw new Error("synthetic transient") }
      })
      await h.store.patch(running)
      h.setPending([permission("p1"), permission("p2")])
      expect(await h.create().pumpOnce()).toBe(false)
      expect(h.attempts).toEqual(["p1", "p2"])
      expect((await h.store.get()).pending).toEqual({ p1: "ses_permission", p2: "ses_permission" })
      await h.create().pumpOnce()
      expect(h.attempts).toEqual(["p1", "p2"])
      await h.due("p1")
      await h.create().pumpOnce()
      await h.create().pumpOnce()
      expect(h.attempts).toEqual(["p1", "p2", "p1"])
      expect(h.counts).toEqual(["permission.notification.failed"])
    })
  })

  it("caps durable retry backoff at five minutes and never retries early", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("permission-backoff"), async (_instance, runtime) => {
      const h = harness(runtime, async () => { throw new Error("synthetic permanent") })
      await h.store.patch(running)
      for (let index = 0; index < 9; index++) {
        const before = Date.now()
        await h.create().pumpOnce()
        const notification = (await h.store.get()).permissionNotifications?.p1
        const delay = Math.min(5_000 * 2 ** index, 300_000)
        expect(notification?.nextAttemptAt).toBeGreaterThanOrEqual(before + delay)
        expect(notification?.nextAttemptAt).toBeLessThanOrEqual(Date.now() + delay)
        await h.create().pumpOnce()
        expect(h.attempts).toHaveLength(index + 1)
        await h.due("p1")
      }
    })
  })

  it("keeps observation and terminal accounting independent of permanent connector failure without exposing its error", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("permission-settlement"), async (_instance, runtime) => {
      const h = harness(runtime, async () => { throw new Error("Bearer synthetic-secret-must-not-leak") })
      await h.store.patch(running)
      expect(await h.create().pumpOnce()).toBe(false)
      expect((await h.store.get()).budgetReservation).toEqual(running.budgetReservation)
      await h.due("p1")
      h.complete()
      expect(await h.create().pumpOnce()).toBe(true)
      expect(h.observations()).toEqual({ contextReads: 2, recordedUsage: 1, releases: 1 })
      expect((await h.store.get()).phase).toBe("idle")
      expect(h.events).toContainEqual({ type: "settled" })
      expect(h.events).toContainEqual(expect.objectContaining({ type: "error", message: expect.stringContaining("notification") }))
      expect(JSON.stringify(h.events)).not.toContain("synthetic-secret-must-not-leak")
    })
  })

  it("prunes resolved and stale-session notifications but retains known ownership during permission-list outages", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("permission-pruning"), async (_instance, runtime) => {
      const h = harness(runtime, async () => { throw new Error("synthetic transient") })
      await h.store.patch(running)
      await h.create().pumpOnce()
      h.unavailable(true)
      await h.create().pumpOnce()
      expect((await h.store.get()).pending).toEqual({ p1: "ses_permission" })
      expect((await h.store.get()).permissionNotifications?.p1).toBeDefined()
      h.unavailable(false)
      h.setPending([])
      await h.create().pumpOnce()
      expect((await h.store.get()).pending).toEqual({})
      expect((await h.store.get()).permissionNotifications).toEqual({})
      h.setPending([permission("p2")])
      await h.create().pumpOnce()
      h.setPending([])
      await h.store.patch({ sessionID: "ses_new" })
      await h.create().pumpOnce()
      expect((await h.store.get()).pending).toEqual({})
      expect((await h.store.get()).permissionNotifications).toEqual({})
      expect(h.attempts).toEqual(["p1", "p2"])
    })
  })

  it("clears a replied request's retry state and does not recreate it after an in-flight notification completes", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("permission-reply-race"), async (_instance, runtime) => {
      const h = harness(runtime, async (id) => { await h.store.clearPermission(id) })
      await h.store.patch(running)
      await h.create().pumpOnce()
      expect((await h.store.get()).pending).toEqual({})
      expect((await h.store.get()).permissionNotifications).toEqual({})
    })
  })
})
