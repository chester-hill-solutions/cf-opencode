import { beforeEach, describe, expect, it } from "vitest"
import { env, runInDurableObject, SELF } from "cloudflare:test"
import type { Conversation } from "../src/conversation"
import { usageLogResponse } from "./helpers/usage-log"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"

const API = { authorization: "Bearer test-token" }
const settings = () => env.SETTINGS.getByName("global")

async function clearSettings(): Promise<void> {
  await runInDurableObject(settings(), async (_instance, state) => state.storage.deleteAll())
  await settings().fetch("https://settings/put", {
    method: "POST",
    body: JSON.stringify({ dailyBudgetUSD: 0 }),
  })
}

function stub(key: string) {
  return env.CONVERSATION.getByName(`C1:${key}`)
}

function internals(instance: Conversation) {
  return instance as unknown as { ctx: { id: { toString(): string } } }
}

async function reserve(conversationID: string, reservationID: string) {
  const response = await settings().fetch("https://settings/usage/reserve", {
    method: "POST",
    body: JSON.stringify({ conversationID, reservationID, costUSD: 0.1 }),
  })
  return { response, body: await response.json() as Record<string, unknown> }
}

function releaseBeforeCancellation(instance: object, conversationID: string, reservationID: string, date: string): void {
  type Stub = { fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> }
  type Namespace = { getByName(name: string): Stub }
  const envHolder = instance as unknown as { env: { SETTINGS: Namespace } }
  const originalEnv = envHolder.env
  const original = originalEnv.SETTINGS
  const wrapped: Namespace = {
    getByName(name) {
      const stub = original.getByName(name)
      if (name !== "global") return stub
      return {
        async fetch(input, init) {
          const url = new URL(input instanceof Request ? input.url : input instanceof URL ? input.toString() : input)
          if (url.pathname === "/usage/cancel") {
            const released = await stub.fetch("https://settings/usage/release", {
              method: "POST",
              body: JSON.stringify({ conversationID, reservationID, date }),
            })
            if (!released.ok) return released
          }
          return stub.fetch(input, init)
        },
      }
    },
  }
  const isolatedEnv = Object.create(originalEnv) as { SETTINGS: Namespace }
  Object.defineProperty(isolatedEnv, "SETTINGS", { value: wrapped, enumerable: true })
  envHolder.env = isolatedEnv
}

async function recovery(instance: Conversation, action?: string, expectedSnapshotID?: string) {
  return instance.fetch(new Request("https://conversation/recovery", action === undefined
    ? { method: "GET" }
    : {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, expectedSnapshotID }),
      }))
}

describe("recovery inspection and actions", () => {
  beforeEach(clearSettings)

  it("keeps authenticated inspection passive and rejects unauthorized or unsupported controls before effects", async () => {
    const before = await (await settings().fetch("https://settings/conversations")).json() as {
      conversations: Array<{ key: string }>
    }
    const unauthorized = await SELF.fetch("https://harness.test/api/conversations/recovery-passive/recovery")
    const invalid = await SELF.fetch("https://harness.test/api/conversations/recovery-passive/recovery", {
      method: "POST",
      headers: { ...API, "content-type": "application/json" },
      body: JSON.stringify({ action: "retry", expectedSnapshotID: "a".repeat(64), force: true }),
    })
    const get = await SELF.fetch("https://harness.test/api/conversations/recovery-passive/recovery", { headers: API })
    const after = await (await settings().fetch("https://settings/conversations")).json() as {
      conversations: Array<{ key: string }>
    }
    expect(unauthorized.status).toBe(401)
    expect(invalid.status).toBe(400)
    expect(get.status).toBe(200)
    expect((await get.json() as { kind: string; actions: unknown[] }).kind).toBe("none")
    expect(after.conversations.map(({ key }) => key)).toEqual(before.conversations.map(({ key }) => key))
  })

  it("cancels an absent undispatched proposal and fences a later acquire of the same ID", async () => {
    const result = await runInDurableObject(stub("recovery-cancel-absent"), async (instance, state) => {
      const id = internals(instance).ctx.id.toString()
      await state.storage.put("state", {
        phase: "admitting", budgetReservation: { reservationID: "proposal-absent", dispatched: false },
        seen: [], pending: {},
      })
      const preview = await (await recovery(instance)).json() as { snapshotID: string; actions: string[] }
      const cancelled = await recovery(instance, "cancel_before_dispatch", preview.snapshotID)
      const cancelBody = await cancelled.json()
      const local = await state.storage.get<{ phase: string; budgetReservation?: unknown }>("state")
      const authority = await settings().fetch(
        `https://settings/usage/cutover?conversationID=${encodeURIComponent(id)}&reservationID=proposal-absent`,
      )
      const ledger = await authority.json() as { holds: unknown[]; retirement?: { reason: string; released: boolean } }
      const late = await reserve(id, "proposal-absent")
      await state.storage.put("state", {
        phase: "idle", budgetReservation: { reservationID: "proposal-absent", dispatched: false },
        seen: [], pending: {},
      })
      const retiredAcquire = await instance.acquireBudgetReservation()
      const afterRetiredAcquire = await state.storage.get<{ budgetReservation?: unknown }>("state")
      await state.storage.put("state", {
        phase: "running", budgetReservation: { reservationID: "proposal-absent", date: "2026-11-11", dispatched: true },
        seen: [], pending: {},
      })
      const dispatchedAcquire = await instance.acquireBudgetReservation()
      const afterDispatchedAcquire = await state.storage.get<{ budgetReservation?: unknown }>("state")
      return {
        cancelled: { status: cancelled.status, body: cancelBody }, local, ledger,
        late: { status: late.response.status, body: late.body }, retiredAcquire, afterRetiredAcquire,
        dispatchedAcquire, afterDispatchedAcquire,
      }
    })
    expect(result.cancelled.status).toBe(200)
    expect(result.local).toMatchObject({ phase: "idle" })
    expect(result.local?.budgetReservation).toBeUndefined()
    expect(result.ledger.holds).toEqual([])
    expect(result.ledger.retirement).toMatchObject({ reason: "cancelled_before_dispatch", released: false })
    expect(result.late.status).toBe(409)
    expect(result.late.body).toMatchObject({ code: "reservation_retired" })
    expect(result.retiredAcquire.kind).toBe("conflict")
    expect(result.afterRetiredAcquire?.budgetReservation).toBeUndefined()
    expect(result.dispatchedAcquire.kind).toBe("already-dispatched")
    expect(result.afterDispatchedAcquire?.budgetReservation).toMatchObject({ dispatched: true, reservationID: "proposal-absent" })
  })

  it("cancels a matching hold without changing actual spend", async () => {
    const result = await runInDurableObject(stub("recovery-cancel-matching"), async (instance, state) => {
      const id = internals(instance).ctx.id.toString()
      await settings().fetch("https://settings/usage", {
        method: "POST",
        body: JSON.stringify({ conversationID: id, sessionID: "ses-recovery", sourceID: "prior-actual", date: new Date().toISOString().slice(0, 10), costUSD: 1.25, input: 9, output: 2 }),
      })
      const grant = await reserve(id, "proposal-matching")
      const hold = grant.body as { date: string }
      await state.storage.put("state", {
        phase: "idle", budgetReservation: { reservationID: "proposal-matching", date: hold.date, dispatched: false },
        seen: [], pending: {},
      })
      const preview = await (await recovery(instance)).json() as { snapshotID: string; actions: string[] }
      const cancelled = await recovery(instance, "cancel_before_dispatch", preview.snapshotID)
      const cancelBody = await cancelled.json()
      const after = await (await settings().fetch(`https://settings/usage/cutover?conversationID=${id}&reservationID=proposal-matching`)).json() as {
        rows: Array<{ costUSD: number; input: number; output: number }>
        holds: unknown[]
        retirement?: { reason: string; date?: string; released: boolean }
      }
      const local = await state.storage.get<{ budgetReservation?: unknown }>("state")
      return { cancelled: { status: cancelled.status, body: cancelBody }, after, local }
    })
    expect(result.cancelled.status).toBe(200)
    expect(result.after.rows).toEqual([expect.objectContaining({ costUSD: 1.25, input: 9, output: 2 })])
    expect(result.after.holds).toEqual([])
    expect(result.after.retirement).toMatchObject({ reason: "cancelled_before_dispatch", released: true })
    expect(result.local?.budgetReservation).toBeUndefined()
  })

  it("recovers a lost cancellation acknowledgement without clearing a newer proposal", async () => {
    const result = await runInDurableObject(stub("recovery-cancel-lost-ack"), async (instance, state) => {
      const id = internals(instance).ctx.id.toString()
      await state.storage.put("state", {
        phase: "idle", budgetReservation: { reservationID: "proposal-old", dispatched: false },
        seen: [], pending: {},
      })
      const before = await (await settings().fetch(
        `https://settings/usage/cutover?conversationID=${id}&reservationID=proposal-old`,
      )).json() as { snapshotID: string }
      const central = await settings().fetch("https://settings/usage/cancel", {
        method: "POST",
        body: JSON.stringify({ conversationID: id, reservationID: "proposal-old", expectedSnapshotID: before.snapshotID }),
      })
      await state.storage.put("state", {
        phase: "idle", budgetReservation: { reservationID: "proposal-new", dispatched: false },
        seen: [], pending: {},
      })
      const newer = await (await recovery(instance)).json() as { snapshotID: string }
      const stale = await recovery(instance, "cancel_before_dispatch", before.snapshotID)
      const newStatus = await (await recovery(instance)).json() as { actions: string[]; snapshotID: string }
      return { centralStatus: central.status, staleStatus: stale.status, newerAction: newStatus.actions, newSnapshot: newStatus.snapshotID }
    })
    expect(result.centralStatus).toBe(200)
    expect(result.staleStatus).toBe(409)
    expect(result.newerAction).toEqual(["cancel_before_dispatch"])
    expect(result.newSnapshot).toMatch(/^[a-f0-9]{64}$/)
  })

  it("accepts a concurrent earlier release as the immutable retirement decision", async () => {
    const result = await runInDurableObject(stub("recovery-release-race"), async (instance, state) => {
      const id = internals(instance).ctx.id.toString()
      const grant = await reserve(id, "proposal-release-race")
      if (!grant.response.ok) throw new Error("hold setup failed")
      const date = (grant.body as { date: string }).date
      await state.storage.put("state", {
        phase: "idle", budgetReservation: { reservationID: "proposal-release-race", date, dispatched: false },
        seen: [], pending: {},
      })
      const preview = await (await recovery(instance)).json() as { snapshotID: string }
      releaseBeforeCancellation(instance, id, "proposal-release-race", date)
      const response = await recovery(instance, "cancel_before_dispatch", preview.snapshotID)
      const body = await response.json() as { retirement?: { reason?: string; released?: boolean } }
      const local = await state.storage.get<{ budgetReservation?: unknown }>("state")
      const today = await (await settings().fetch("https://settings/usage/today")).json() as {
        costUSD?: number; reservedUSD?: number
      }
      return { status: response.status, body, local, today }
    })
    expect(result.status).toBe(200)
    expect(result.body.retirement).toMatchObject({ reason: "released", released: true })
    expect(result.local?.budgetReservation).toBeUndefined()
    expect(result.today).toMatchObject({ costUSD: 0, reservedUSD: 0 })
  })

  it("schedules only the alarm for a dispatched turn, even with a queue and active cached fences", async () => {
    const result = await runInDurableObject(stub("recovery-retry-only"), async (instance, state) => {
      await state.storage.put("state", {
        phase: "settling",
        sessionID: "session-recovery",
        budgetReservation: { reservationID: "dispatched", date: "2026-11-11", dispatched: true },
        queued: { text: "next prompt", attempts: 0 },
        usageExecution: { sessionID: "session-recovery", startedSeq: 5, terminalSeq: 2, latestStepSeq: 4 },
        seen: [], pending: {},
      })
      const before = await state.storage.get("state")
      const preview = await (await recovery(instance)).json() as { kind: string; actions: string[]; snapshotID: string }
      const response = await recovery(instance, "retry", preview.snapshotID)
      const alarm = await state.storage.getAlarm()
      const after = await state.storage.get("state")
      return { preview, status: response.status, body: await response.json(), alarm, before, after }
    })
    expect(result.preview.kind).toBe("dispatched")
    expect(result.preview.actions).toEqual(["retry"])
    expect(result.status).toBe(202)
    expect(result.body).toEqual({ ok: true, scheduled: true })
    expect(result.alarm).toBeTypeOf("number")
    expect(result.after).toEqual(result.before)
  })

  it("recovers through the alarm, acknowledges terminal actuals, retires the hold, then permits new work", async () => {
    const result = await runInDurableObject(stub("recovery-settlement"), async (instance, state) => {
      const sessionID = "ses_recovery_settlement"
      const conversationID = internals(instance).ctx.id.toString()
      const grant = await reserve(conversationID, "dispatch-recovery")
      if (!grant.response.ok) throw new Error(`hold setup failed: ${JSON.stringify(grant.body)}`)
      const date = (grant.body as { date: string }).date
      const now = Date.now()
      const messages = [
        { id: "user-recovery", type: "user", content: [{ type: "text", text: "work" }], time: { created: now - 5 } },
        {
          id: "assistant-recovery", type: "assistant", content: [{ type: "text", text: "done" }],
          cost: 0.15, finish: "stop", tokens: { input: 11, output: 4 },
          time: { created: now - 3, completed: now - 1 },
        },
      ]
      let promptCalls = 0
      instance.transport = (port) => ({
        async fetch(input) {
          const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
          const json = (body: unknown, status = 200) => Response.json(body, { status })
          if (port === 4001) {
            if (url.pathname === "/status") return json({ initialized: true })
            if (url.pathname === "/start") return json(accountingPolicyStart)
            if (url.pathname === "/configure") return json({ ok: true })
            if (url.pathname === "/checkpoint") return new Response(null, { status: 204 })
          }
          if (url.pathname === "/api/config") return json(accountingPolicyConfig)
          if (url.pathname === `/api/session/${sessionID}/context`) return json({ data: messages })
          if (url.pathname === `/api/session/${sessionID}/permission`) return json({ data: [] })
          if (url.pathname === `/api/session/${sessionID}/prompt`) {
            promptCalls++
            return json({ data: {} })
          }
          if (url.pathname === `/api/experimental/session/${sessionID}/log`) {
            return usageLogResponse(input, sessionID, messages, { execution: "succeeded" })
          }
          return json({ error: "not found" }, 404)
        },
      })
      await state.storage.put("state", {
        phase: "settling", sessionID, turnBaseline: undefined,
        budgetReservation: { reservationID: "dispatch-recovery", date, dispatched: true },
        runStartedAt: now - 1000, seen: [], pending: {},
      })
      const preview = await (await recovery(instance)).json() as { actions: string[]; snapshotID: string }
      const triggered = await recovery(instance, "retry", preview.snapshotID)
      const beforeAlarmPrompts = promptCalls
      await instance.alarm()
      const current = await state.storage.get<{ phase?: string; budgetReservation?: unknown } & Record<string, unknown>>("state")
      const ledger = await (await settings().fetch(
        `https://settings/usage/cutover?conversationID=${conversationID}&reservationID=dispatch-recovery`,
      )).json() as {
        rows: Array<{ costUSD: number; input: number; output: number }>
        holds: unknown[]
        retirement?: { reason: string; date?: string }
      }
      const delayedAcquire = await reserve(conversationID, "dispatch-recovery")
      const next = await instance.acquireBudgetReservation()
      return {
        preview, triggerStatus: triggered.status, beforeAlarmPrompts, promptCalls, current, ledger,
        delayedAcquire: { status: delayedAcquire.response.status, body: delayedAcquire.body }, nextKind: next.kind,
      }
    })
    expect(result.preview.actions).toEqual(["retry"])
    expect(result.triggerStatus).toBe(202)
    expect(result.beforeAlarmPrompts).toBe(0)
    expect(result.promptCalls).toBe(0)
    expect(result.current?.phase).toBe("idle")
    expect(result.current?.budgetReservation).toBeUndefined()
    expect(result.ledger.rows).toEqual([expect.objectContaining({ costUSD: 0.15, input: 11, output: 4 })])
    expect(result.ledger.holds).toEqual([])
    expect(result.ledger.retirement).toMatchObject({ reason: "released" })
    expect(result.delayedAcquire.status).toBe(409)
    expect(result.delayedAcquire.body).toMatchObject({ code: "reservation_retired" })
    expect(result.nextKind).toBe("granted")
  })

  it("rejects a stale snapshot and blocks queued undispatched work without mutation", async () => {
    const result = await runInDurableObject(stub("recovery-stale-queued"), async (instance, state) => {
      await state.storage.put("state", {
        phase: "idle", budgetReservation: { reservationID: "proposal", dispatched: false },
        queued: { text: "queued", attempts: 0 }, seen: [], pending: {},
      })
      const status = await (await recovery(instance)).json() as { actions: string[]; blockers: string[]; snapshotID: string }
      const stale = await recovery(instance, "cancel_before_dispatch", "f".repeat(64))
      const current = await state.storage.get("state")
      return { status, stale: { status: stale.status, body: await stale.json() }, current }
    })
    expect(result.status.actions).toEqual([])
    expect(result.status.blockers).toContain("queued_work_present")
    expect(result.stale.status).toBe(409)
    expect(result.current).toMatchObject({ budgetReservation: { reservationID: "proposal", dispatched: false }, queued: { text: "queued" } })
  })
})
