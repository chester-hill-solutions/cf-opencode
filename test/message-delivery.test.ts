import { describe, expect, it } from "vitest"
import { env, runInDurableObject, SELF } from "cloudflare:test"
import { ConversationStore, type ConversationState } from "../src/state"
import { ConversationDeliveryControls } from "../src/conversation/delivery-controls"
import { driveConversationJobs } from "./helpers/conversation-jobs"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"

/** Exercise the real HTTP adapter and SDK serialization without provider inference. */
describe("HTTP delivery modes", () => {
  it("defaults to a bounded FIFO and validates delivery before admission", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("delivery:fifo"), async (instance, runtime) => {
      await runtime.storage.put("state", { phase: "running", sessionID: "ses_delivery", budgetReservation: { reservationID: "hold", date: "2026-11-14", dispatched: true } })
      const send = (body: unknown) => instance.fetch(new Request("https://conversation/message", { method: "POST", body: JSON.stringify(body) }))
      expect((await send({ text: "bad", delivery: "surprise" })).status).toBe(400)
      expect((await send({ text: "bad", delivery: "steer", replaceQueue: true })).status).toBe(400)
      for (let index = 0; index < 10; index++) {
        const response = await send({ text: `message-${index}` })
        expect(response.status).toBe(202)
        expect(await response.json()).toMatchObject({ delivery: "queue", queue: { position: index + 1, depth: index + 1 } })
      }
      expect((await send({ text: "overflow", idempotencyKey: "retry-full" })).status).toBe(429)
      const state = await runtime.storage.get<ConversationState>("state")
      expect(state?.queue?.map(entry => entry.text)).toEqual(Array.from({ length: 10 }, (_, i) => `message-${i}`))
      expect(state?.budgetReservation?.reservationID).toBe("hold")
      expect(state?.seen).not.toContain("msg:retry-full")
    })
  })

  it("forwards public delivery controls and returns the same pending entry on retry", async () => {
    const key = "delivery-public-options"
    const stub = env.CONVERSATION.getByName(key)
    await runInDurableObject(stub, async (_instance, runtime) => {
      await runtime.storage.put("state", { phase: "running", sessionID: "ses_delivery", budgetReservation: { reservationID: "public-hold", date: "2026-11-14", dispatched: true } })
    })
    const send = (body: unknown) => SELF.fetch(`https://harness.test/api/conversations/${key}/messages`, {
      method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" }, body: JSON.stringify(body),
    })
    expect((await send({ text: "bad", delivery: "invalid" })).status).toBe(400)
    expect((await send({ text: "bad", replaceQueue: "true" })).status).toBe(400)
    const first = await send({ text: "accepted", idempotencyKey: "pending-retry" })
    expect(first.status).toBe(202)
    const accepted = await first.json() as { queue: { id: string } }
    const duplicate = await send({ text: "accepted", idempotencyKey: "pending-retry" })
    expect(await duplicate.json()).toMatchObject({ duplicate: true, queued: true, queue: { id: accepted.queue.id, position: 1, depth: 1 } })
    expect((await send({ text: "replacement", replaceQueue: true })).status).toBe(202)
    await runInDurableObject(stub, async (_instance, runtime) => {
      expect((await new ConversationStore(runtime.storage).get()).queue?.map(entry => entry.text)).toEqual(["replacement"])
    })
    const idleKey = "delivery-public-idle"
    for (const delivery of ["steer", "interrupt"]) {
      const response = await SELF.fetch(`https://harness.test/api/conversations/${idleKey}/messages`, {
        method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" }, body: JSON.stringify({ text: "guidance", delivery }),
      })
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: "no_active_turn" })
    }
  })

  it("steers the active SDK session and interrupts with a durable fenced follow-up", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("delivery:controls"), async (instance, runtime) => {
      const calls: Array<{ path: string; body: Record<string, unknown> }> = []
      instance.transport = port => ({ async fetch(input: Request | string | URL, init?: RequestInit) {
        const request = input instanceof Request ? input : new Request(input, init)
        const path = new URL(request.url).pathname
        if (port === 4001) {
          if (path === "/status") return Response.json({ initialized: true })
          if (path === "/configure") return Response.json({ ok: true })
          if (path === "/start") return Response.json(accountingPolicyStart)
        }
        if (path === "/api/config") return Response.json(accountingPolicyConfig)
        if (path.endsWith("/prompt") || path.endsWith("/interrupt")) {
          calls.push({ path, body: path.endsWith("/interrupt") ? { resume: new URL(request.url).searchParams.get("resume") } : await request.json() as Record<string, unknown> })
          // The intent and follow-up must exist before the external interrupt.
          if (path.endsWith("/interrupt")) {
            expect(await runtime.storage.get("interruptIntent")).toMatchObject({ status: "requested", sessionID: "ses_delivery" })
            expect((await runtime.storage.get<ConversationState>("state"))?.queue?.map(entry => entry.text)).toEqual(["after stop"])
          }
          return Response.json({ data: {} })
        }
        return Response.json({ data: [] })
      } })
      const reservation = { reservationID: "delivery-hold", date: "2026-11-14", dispatched: true }
      await runtime.storage.put("state", { phase: "running", sessionID: "ses_delivery", runStartedAt: Date.now(), budgetReservation: reservation })
      const send = (body: unknown) => instance.fetch(new Request("https://conversation/message", { method: "POST", body: JSON.stringify(body) }))
      const steered = await send({ text: "adjust", delivery: "steer" })
      expect(steered.status).toBe(200)
      expect(await steered.json()).toMatchObject({ outcome: "acknowledged", consumed: null })
      const interrupted = await send({ text: "after stop", delivery: "interrupt", idempotencyKey: "interrupt-once" })
      expect(interrupted.status).toBe(200)
      const receipt = await interrupted.json() as { queue: { id: string } }
      expect(receipt).toMatchObject({ stopRequested: true, observedStop: null, settled: false })
      const retried = await send({ text: "after stop", delivery: "interrupt", idempotencyKey: "interrupt-once" })
      expect(retried.status).toBe(200)
      expect(await retried.json()).toMatchObject({ duplicate: true, queue: { id: receipt.queue.id, position: 1, depth: 1 } })
      expect(calls).toEqual([
        { path: "/api/session/ses_delivery/prompt", body: { text: "adjust", delivery: "steer", resume: false } },
        { path: "/api/session/ses_delivery/interrupt", body: { resume: "false" } },
      ])
      await driveConversationJobs(instance, runtime.storage, ["admission:retry"], { queued: true })
      expect(calls).toHaveLength(2) // A due follow-up cannot dispatch while the interrupted hold exists.
      expect((await runtime.storage.get<ConversationState>("state"))?.budgetReservation).toEqual(reservation)
      const status = await (await instance.fetch(new Request("https://conversation/state"))).json() as Record<string, unknown>
      expect(status.turnObservation).toMatchObject({ policy: "observe_and_alert", executionDeadlineEnforced: false })
    })
  })

  it("rolls back an idle follow-up when its durable wake cannot be scheduled", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("delivery:wake-failure"), async (_instance, runtime) => {
      const store = new ConversationStore(runtime.storage)
      await store.patch({ phase: "idle" })
      let externalCalls = 0
      const controls = new ConversationDeliveryControls({
        storage: runtime.storage, store, withLock: task => task(),
        unavailable: async () => false, admitting: () => false, queueLimit: 10,
        steer: async () => { externalCalls++ }, interrupt: async () => { externalCalls++ },
        schedule: async () => { throw new Error("scheduler write failed") }, event: async () => {},
      })
      expect(await controls.stop("follow-up", { replaceQueue: true })).toMatchObject({ ok: false, status: 503 })
      expect((await store.get()).queue).toEqual([])
      expect((await store.get()).phase).toBe("idle")
      expect(externalCalls).toBe(0)
    })
  })

  it("refuses steer and interrupt while idle without adding queued work", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("delivery:idle"), async (instance, runtime) => {
      for (const delivery of ["steer", "interrupt"]) {
        const response = await instance.fetch(new Request("https://conversation/message", { method: "POST", body: JSON.stringify({ text: "hello", delivery }) }))
        expect(response.status).toBe(409)
      }
      expect((await runtime.storage.get<ConversationState>("state"))?.queue ?? []).toEqual([])
    })
  })
})
