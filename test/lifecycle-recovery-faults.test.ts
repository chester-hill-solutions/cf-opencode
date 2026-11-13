import { describe, expect, it } from "vitest"
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test"
import type { Conversation } from "../src/conversation"
import type { ConversationState } from "../src/state"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"
import { driveConversationJobs } from "./helpers/conversation-jobs"

const settings = () => env.SETTINGS.getByName("global")
const stub = (key: string) => env.CONVERSATION.getByName(`C1:${key}`)

function queueTransport(prompts: { count: number }) {
  return (port: number) => ({
    async fetch(input: Request | string | URL): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input)
      const url = new URL(request.url)
      const json = (body: unknown, status = 200) => Response.json(body, { status })
      if (port === 4001) {
        if (url.pathname === "/status") return json({ initialized: true })
        if (url.pathname === "/configure") return json({ ok: true })
        if (url.pathname === "/start") return json(accountingPolicyStart)
        if (url.pathname === "/checkpoint") return new Response(null, { status: 204 })
        return json({ error: "not found" }, 404)
      }
      if (url.pathname === "/api/config") return json(accountingPolicyConfig)
      if (url.pathname === "/api/model") return json({ data: { model: [] } })
      if (url.pathname === "/api/session") return json({ data: { id: "ses_queue_recovery" } })
      if (url.pathname === "/api/session/ses_queue_recovery/model") return new Response(null, { status: 204 })
      if (url.pathname === "/api/session/ses_queue_recovery/prompt") {
        prompts.count++
        return json({ data: {} })
      }
      if (url.pathname.endsWith("/context")) return json({ data: [] })
      if (url.pathname.endsWith("/permission")) return json({ data: [] })
      if (url.pathname === "/api/event") return new Response(null, { status: 200 })
      return json({ error: "not found" }, 404)
    },
  })
}

async function reserve(conversationID: string, reservationID: string) {
  const response = await settings().fetch("https://settings/usage/reserve", {
    method: "POST",
    body: JSON.stringify({ conversationID, reservationID, costUSD: 0.1 }),
  })
  if (!response.ok) throw new Error(`hold setup failed: ${response.status}`)
  return await response.json() as { date: string }
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

describe("Conversation recovery fault regressions", () => {
  it("recovers a cold stale admission independently, then drains its queued item once", async () => {
    const conversation = stub("recovery-stale-admission-and-queue")
    await runInDurableObject(conversation, async (_instance, runtime) => {
      const admissionAt = Date.now() - 60_000
      const queueDueAt = Date.now() + 60_000
      await runtime.storage.put("state", {
        phase: "admitting",
        admissionID: "admission-stale-1",
        admissionStartedAt: admissionAt,
        queued: { id: "queue-stale-1", text: "queued after recovery", attempts: 0, nextAttemptAt: queueDueAt },
        seen: [],
        pending: {},
      } satisfies ConversationState)
      // Model an archive created by a pre-Lifecycle version: it still has its
      // physical alarm but no one-time migration marker.
      await runtime.storage.setAlarm(Date.now() + 60_000)
      await runtime.storage.delete("lifecycleLegacyAlarmMigration")
    })

    await evictDurableObject(conversation)
    const result = await runInDurableObject(conversation, async (instance, runtime) => {
      const prompts = { count: 0 }
      instance.transport = queueTransport(prompts)
      // Cold startup must translate the old alarm before state-derived typed
      // deadlines are relied on. Run that one-time bootstrap explicitly.
      await (await instance.fetch(new Request("https://conversation/health"))).text()
      await driveConversationJobs(instance, runtime.storage, ["legacy:bootstrap"])
      const before = runtime.storage.sql.exec<{ id: string; payload: string }>(
        "SELECT id, payload FROM cf_agents_jobs WHERE capability = ? ORDER BY id",
        "conversation-jobs",
      ).toArray()
      await driveConversationJobs(instance, runtime.storage, ["recovery:wake"])
      const afterRecovery = await runtime.storage.get<ConversationState>("state")
      const queueJob = runtime.storage.sql.exec<{ id: string; payload: string }>(
        "SELECT id, payload FROM cf_agents_jobs WHERE id = ? AND capability = ?",
        "admission:retry",
        "conversation-jobs",
      ).toArray()[0]
      await driveConversationJobs(instance, runtime.storage, ["admission:retry"], { queued: true })
      const afterQueue = await runtime.storage.get<ConversationState>("state")
      // A duplicate wake after the queue was consumed must not send it again.
      await driveConversationJobs(instance, runtime.storage, ["admission:retry"], { queued: true })
      return {
        before: before.map((row) => ({ id: row.id, payload: JSON.parse(row.payload) as Record<string, unknown> })),
        afterRecovery,
        queueJob: queueJob ? { id: queueJob.id, payload: JSON.parse(queueJob.payload) as Record<string, unknown> } : undefined,
        afterQueue,
        prompts: prompts.count,
      }
    })

    expect(result.before.map((row) => row.id)).toEqual(["admission:retry", "recovery:wake"])
    expect(result.before.find((row) => row.id === "recovery:wake")?.payload).toMatchObject({
      admissionID: "admission-stale-1",
      reason: "stale-admission-recovery",
    })
    expect(result.before.find((row) => row.id === "admission:retry")?.payload).toMatchObject({
      queueID: "queue-stale-1",
    })
    expect(result.afterRecovery).toMatchObject({ phase: "queued", queued: { id: "queue-stale-1" } })
    expect(result.afterRecovery?.admissionID).toBeUndefined()
    expect(result.queueJob?.payload).toMatchObject({ queueID: "queue-stale-1" })
    expect(result.prompts).toBe(1)
    expect(result.afterQueue?.queued).toBeUndefined()
  })

  it("unseals and safely rearms dispatched recovery without losing its hold or usage evidence", async () => {
    const conversation = stub("recovery-rearm-sealed-turn")
    const result = await runInDurableObject(conversation, async (instance, runtime) => {
      const conversationID = runtime.id.toString()
      const sessionID = "ses_sealed_recovery"
      const reservationID = "reservation-sealed-recovery"
      const date = new Date().toISOString().slice(0, 10)
      const hold = await reserve(conversationID, reservationID)
      await settings().fetch("https://settings/usage", {
        method: "POST",
        body: JSON.stringify({ conversationID, sessionID, sourceID: "prior-sealed-usage", date, costUSD: 0.025, input: 120, output: 8 }),
      })
      await runtime.storage.put("state", {
        phase: "settling",
        sessionID,
        runStartedAt: Date.now() - 30_000,
        budgetReservation: { reservationID, date: hold.date, dispatched: true },
        usageExecution: { sessionID, startedSeq: 8, terminalSeq: 5, latestStepSeq: 7 },
        usageCursor: { sessionID, seq: 5 },
        seen: [],
        pending: {},
      } satisfies ConversationState)
      await runtime.storage.put("lifecycleJobsSealed", true)

      const preview = await (await recovery(instance)).json() as { kind: string; actions: string[]; snapshotID: string }
      const stale = await recovery(instance, "retry", "0".repeat(64))
      const original = await runtime.storage.get<ConversationState>("state")
      await runtime.storage.put("state", {
        ...original!,
        budgetReservation: { ...original!.budgetReservation!, reservationID: "reservation-stale-owner" },
      })
      const staleOwner = await recovery(instance, "retry", preview.snapshotID)
      await runtime.storage.put("state", original!)
      const first = await recovery(instance, "retry", preview.snapshotID)
      const duplicate = await recovery(instance, "retry", preview.snapshotID)
      const sealed = await runtime.storage.get<boolean>("lifecycleJobsSealed")
      const local = await runtime.storage.get<ConversationState>("state")
      const jobs = runtime.storage.sql.exec<{ id: string; fn: string; payload: string }>(
        "SELECT id, fn, payload FROM cf_agents_jobs WHERE capability = ? ORDER BY id",
        "conversation-jobs",
      ).toArray()
      const ledgerResponse = await settings().fetch(
        `https://settings/usage/cutover?conversationID=${encodeURIComponent(conversationID)}&reservationID=${encodeURIComponent(reservationID)}`,
      )
      const ledger = await ledgerResponse.json() as { rows: Array<Record<string, unknown>>; holds: Array<Record<string, unknown>> }
      const prompts = { count: 0 }
      instance.transport = queueTransport(prompts)
      await driveConversationJobs(instance, runtime.storage, ["recovery:wake"])
      return {
        preview,
        staleStatus: stale.status,
        staleOwnerStatus: staleOwner.status,
        firstStatus: first.status,
        firstBody: await first.json(),
        duplicateStatus: duplicate.status,
        duplicateBody: await duplicate.json(),
        sealed,
        local,
        jobs: jobs.map((row) => ({ ...row, payload: JSON.parse(row.payload) as Record<string, unknown> })),
        ledger,
        prompts: prompts.count,
      }
    })

    expect(result.preview).toMatchObject({ kind: "dispatched", actions: ["retry"] })
    expect(result.staleStatus).toBe(409)
    expect(result.staleOwnerStatus).toBe(409)
    expect(result.firstStatus).toBe(202)
    expect(result.firstBody).toEqual({ ok: true, scheduled: true })
    expect(result.duplicateStatus).toBe(202)
    expect(result.duplicateBody).toEqual({ ok: true, scheduled: true })
    expect(result.sealed).toBeUndefined()
    expect(result.local).toMatchObject({
      phase: "settling",
      sessionID: "ses_sealed_recovery",
      budgetReservation: { reservationID: "reservation-sealed-recovery", dispatched: true },
      usageExecution: { startedSeq: 8, terminalSeq: 5, latestStepSeq: 7 },
      usageCursor: { seq: 5 },
    })
    expect(result.jobs).toHaveLength(1)
    expect(result.jobs[0]).toMatchObject({
      id: "recovery:wake",
      fn: "recoveryWake",
      payload: { reservationID: "reservation-sealed-recovery", sessionID: "ses_sealed_recovery" },
    })
    expect(result.ledger.rows).toEqual([expect.objectContaining({ costUSD: 0.025, input: 120, output: 8 })])
    expect(result.ledger.holds).toEqual([expect.objectContaining({ reservationID: "reservation-sealed-recovery", costUSD: 0.1 })])
    expect(result.prompts).toBe(0)
  })

  it.each([false, true])("retries an exact lost-release-ack retirement without restoring a hold (sealed=%s)", async (sealed) => {
    const conversation = stub(`recovery-released-retirement-${sealed ? "sealed" : "open"}`)
    const result = await runInDurableObject(conversation, async (instance, runtime) => {
      const conversationID = runtime.id.toString()
      const sessionID = "ses_released_retirement"
      const reservationID = "reservation-released-retirement"
      const prompts = { count: 0 }
      instance.transport = queueTransport(prompts)
      const hold = await reserve(conversationID, reservationID)
      const date = hold.date
      await settings().fetch("https://settings/usage", {
        method: "POST",
        body: JSON.stringify({ conversationID, sessionID, sourceID: "actual-before-release-retry", date, costUSD: 0.04, input: 90, output: 6 }),
      })
      const release = await settings().fetch("https://settings/usage/release", {
        method: "POST",
        body: JSON.stringify({ conversationID, reservationID, date }),
      })
      if (!release.ok) throw new Error(`release setup failed: ${release.status}`)
      const releaseReceipt = await release.json() as { retirement?: Record<string, unknown> }
      await runtime.storage.put("state", {
        phase: "settling",
        sessionID,
        runStartedAt: Date.now() - 20_000,
        budgetReservation: { reservationID, date, dispatched: true },
        usageExecution: { sessionID, startedSeq: 5, terminalSeq: 2, latestStepSeq: 4 },
        usageCursor: { sessionID, seq: 2 },
        seen: [],
        pending: {},
      } satisfies ConversationState)
      if (sealed) await runtime.storage.put("lifecycleJobsSealed", true)

      // Unsealed cold startup rehydrates an immediate observation job. Let that
      // harmless read finish before testing the operator retry fence.
      await instance.fetch(new Request("https://conversation/health"))
      if (!sealed) await instance.alarm()
      for (let attempt = 0; attempt < 500; attempt++) {
        const claims = await runtime.storage.get<Record<string, unknown>>("conversationJobClaims")
        if (!claims || Object.keys(claims).length === 0) break
        if (attempt === 499) throw new Error("startup observation did not finish")
        await new Promise((resolve) => setTimeout(resolve, 10))
      }

      const preview = await (await recovery(instance)).json() as { kind: string; actions: string[]; snapshotID: string }
      const retry = await recovery(instance, "retry", preview.snapshotID)
      const retryBody = await retry.json()
      const current = await runtime.storage.get<ConversationState>("state")
      const sealAfter = await runtime.storage.get<boolean>("lifecycleJobsSealed")
      const jobs = runtime.storage.sql.exec<{ id: string; payload: string }>(
        "SELECT id, payload FROM cf_agents_jobs WHERE id = ? AND capability = ?",
        "recovery:wake",
        "conversation-jobs",
      ).toArray()
      const authority = await settings().fetch(
        `https://settings/usage/cutover?conversationID=${encodeURIComponent(conversationID)}&reservationID=${encodeURIComponent(reservationID)}`,
      )
      const ledger = await authority.json() as { rows: Array<Record<string, unknown>>; holds: unknown[]; retirement?: Record<string, unknown> }
      return {
        preview,
        retryStatus: retry.status,
        retryBody,
        current,
        sealAfter,
        jobs: jobs.map((job) => ({ id: job.id, payload: JSON.parse(job.payload) as Record<string, unknown> })),
        ledger,
        releaseReceipt,
      }
    })

    expect(result.releaseReceipt.retirement).toMatchObject({
      conversationID: expect.any(String),
      reservationID: "reservation-released-retirement",
      reason: "released",
      released: true,
    })
    expect(result.preview).toMatchObject({ kind: "dispatched", actions: ["retry"] })
    expect(result.retryStatus, JSON.stringify({ preview: result.preview, retryBody: result.retryBody })).toBe(202)
    expect(result.retryBody).toEqual({ ok: true, scheduled: true })
    expect(result.sealAfter).toBeUndefined()
    expect(result.current).toMatchObject({
      phase: "settling",
      sessionID: "ses_released_retirement",
      budgetReservation: { reservationID: "reservation-released-retirement", dispatched: true },
      usageExecution: { startedSeq: 5, terminalSeq: 2, latestStepSeq: 4 },
      usageCursor: { seq: 2 },
    })
    expect(result.jobs).toHaveLength(1)
    expect(result.jobs[0]).toMatchObject({
      id: "recovery:wake",
      payload: { reservationID: "reservation-released-retirement", sessionID: "ses_released_retirement" },
    })
    expect(result.ledger.rows).toEqual([expect.objectContaining({ costUSD: 0.04, input: 90, output: 6 })])
    expect(result.ledger.holds).toEqual([])
    expect(result.ledger.retirement).toMatchObject({ reason: "released", released: true, reservationID: "reservation-released-retirement" })
  })
})
