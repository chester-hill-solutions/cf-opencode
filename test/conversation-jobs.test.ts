import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import type { ConversationState } from "../src/state"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"
import { driveConversationJobs, makeConversationJobsDue } from "./helpers/conversation-jobs"
import { usageLogResponse } from "./helpers/usage-log"

const stateRequest = () => new Request("https://conversation/state")

function observationTransport(prompts: { count: number }) {
  return (port: number) => ({
    async fetch(input: Request | string | URL): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input)
      const url = new URL(request.url)
      const json = (body: unknown, status = 200) => Response.json(body, { status })
      if (port === 4001) {
        if (url.pathname === "/status") return json({ initialized: true })
        if (url.pathname === "/start") return json(accountingPolicyStart)
        if (url.pathname === "/configure") return json({ ok: true })
        return json({ error: "not found" }, 404)
      }
      if (url.pathname === "/api/config") return json(accountingPolicyConfig)
      if (url.pathname === "/api/session/ses_existing/context") return json({ data: [] })
      if (url.pathname === "/api/session/ses_existing/permission") return json({ data: [] })
      if (url.pathname.endsWith("/prompt")) prompts.count++
      return json({ data: {} })
    },
  })
}

async function startLegacyBootstrap(
  instance: { fetch(request: Request): Promise<Response>; alarm(): Promise<void> },
  storage: DurableObjectStorage,
): Promise<void> {
  await storage.setAlarm(Date.now() - 1)
  await (await instance.fetch(stateRequest())).text()
  await instance.alarm()
}

describe("Conversation Lifecycle job cutover", () => {
  it("rehydrates an old admitting phase without an admission ID", async () => {
    const stub = env.CONVERSATION.getByName("C1:jobs-legacy-admission")
    const row = await runInDurableObject(stub, async (instance, runtime) => {
      await runtime.storage.put("state", { phase: "admitting", seen: [], pending: {} } satisfies ConversationState)
      await runtime.storage.setAlarm(Date.now() - 1)
      await instance.alarm()
      return runtime.storage.sql.exec<{ id: string; fn: string; capability: string }>(
        "SELECT id, fn, capability FROM cf_agents_jobs WHERE id = ?",
        "recovery:wake",
      ).toArray()[0]
    })
    expect(row).toMatchObject({ id: "recovery:wake", fn: "recoveryWake", capability: "conversation-jobs" })
  })

  it("does not run a future queued admission when an alarm is invoked early", async () => {
    const stub = env.CONVERSATION.getByName("C1:jobs-queue-deadline")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const dueAt = Date.now() + 60_000
      await runtime.storage.put("state", {
        phase: "queued",
        queued: { id: "queue-1", text: "must wait", attempts: 0, nextAttemptAt: dueAt },
        seen: [],
        pending: {},
      } satisfies ConversationState)
      const prompts = { count: 0 }
      instance.transport = observationTransport(prompts)
      await startLegacyBootstrap(instance, runtime.storage)
      await instance.alarm()
      const after = await runtime.storage.get<ConversationState>("state")
      const job = runtime.storage.sql.exec<{ time: number }>(
        "SELECT time FROM cf_agents_jobs WHERE id = ?",
        "admission:retry",
      ).toArray()[0]
      return { attempts: after?.queued?.attempts, nextAttemptAt: after?.queued?.nextAttemptAt, dueAt, jobTime: job?.time, prompts: prompts.count }
    })
    expect(result.prompts).toBe(0)
    expect(result.attempts).toBe(0)
    expect(result.nextAttemptAt).toBe(result.dueAt)
    expect(result.jobTime).toBeGreaterThanOrEqual(result.dueAt)
  })

  it("does not run a future checkpoint retry when an alarm is invoked early", async () => {
    const stub = env.CONVERSATION.getByName("C1:jobs-checkpoint-deadline")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const retryAt = Date.now() + 60_000
      await runtime.storage.put("state", {
        phase: "idle",
        checkpointPending: true,
        checkpointRetryAt: retryAt,
        seen: [],
        pending: {},
      } satisfies ConversationState)
      const requests = { count: 0 }
      instance.transport = (port) => ({
        async fetch(input: Request | string | URL): Promise<Response> {
          const request = input instanceof Request ? input : new Request(input)
          if (port === 4001 && new URL(request.url).pathname === "/checkpoint") requests.count++
          return Response.json({ ok: true, initialized: true })
        },
      })
      await startLegacyBootstrap(instance, runtime.storage)
      await instance.alarm()
      const after = await runtime.storage.get<ConversationState>("state")
      return { retryAt: after?.checkpointRetryAt, pending: after?.checkpointPending, requests: requests.count }
    })
    expect(result.requests).toBe(0)
    expect(result.pending).toBe(true)
    expect(result.retryAt).toBeGreaterThan(Date.now())
  })

  it("observes a dispatched hold without ever replaying its prompt and backs off", async () => {
    const stub = env.CONVERSATION.getByName("C1:jobs-dispatched-no-replay")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const prompts = { count: 0 }
      instance.transport = observationTransport(prompts)
      await runtime.storage.put("state", {
        phase: "running",
        runStartedAt: Date.now(),
        turnBaseline: "before",
        sessionID: "ses_existing",
        budgetReservation: { reservationID: "reservation-1", date: "2026-11-12", dispatched: true },
        seen: [],
        pending: {},
      } satisfies ConversationState)
      await startLegacyBootstrap(instance, runtime.storage)
      await driveConversationJobs(instance, runtime.storage, ["turn:observe"])
      const after = await runtime.storage.get<ConversationState>("state")
      const job = runtime.storage.sql.exec<{ time: number }>(
        "SELECT time FROM cf_agents_jobs WHERE id = ?",
        "turn:observe",
      ).toArray()[0]
      return { prompts: prompts.count, phase: after?.phase, reservation: after?.budgetReservation, jobTime: job?.time }
    })
    expect(result.prompts).toBe(0)
    expect(result.phase).toBe("running")
    expect(result.reservation).toMatchObject({ reservationID: "reservation-1", dispatched: true })
    expect(result.jobTime).toBeGreaterThan(Date.now())
  })

  it("retains and retries a failed detached turn observation without replaying a prompt", async () => {
    const stub = env.CONVERSATION.getByName("C1:jobs-detached-failure")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      let contextCalls = 0
      let promptCalls = 0
      const now = Date.now()
      const messages = [
        { id: "u1", type: "user", time: { created: now - 10 } },
        { id: "a1", type: "assistant", content: [{ type: "text", text: "done" }],
          time: { created: now - 5, completed: now }, finish: "stop", cost: 0.25,
          tokens: { input: 40, output: 12 } },
      ]
      instance.transport = (port) => ({
        async fetch(input: Request | string | URL): Promise<Response> {
          const request = input instanceof Request ? input : new Request(input)
          const url = new URL(request.url)
          const json = (body: unknown, status = 200) => Response.json(body, { status })
          if (port === 4001) {
            if (url.pathname === "/status") return json({ initialized: true })
            if (url.pathname === "/start") return json(accountingPolicyStart)
            if (url.pathname === "/configure") return json({ ok: true })
            return json({ error: "not found" }, 404)
          }
          if (url.pathname === "/api/config") return json(accountingPolicyConfig)
          if (url.pathname === "/api/session/ses_existing/context") {
            contextCalls++
            if (contextCalls === 1) return json({ error: "temporary context failure" }, 503)
            return json({ data: messages })
          }
          if (url.pathname === "/api/session/ses_existing/permission") return json({ data: [] })
          if (url.pathname === "/api/experimental/session/ses_existing/log") {
            return usageLogResponse(input, "ses_existing", messages)
          }
          if (url.pathname.endsWith("/prompt")) promptCalls++
          return json({ data: {} })
        },
      })
      await runtime.storage.put("state", {
        phase: "running",
        runStartedAt: now - 20,
        turnBaseline: "before",
        sessionID: "ses_existing",
        budgetReservation: { reservationID: "reservation-detached", date: "2026-11-12", dispatched: true },
        seen: [],
        pending: {},
      } satisfies ConversationState)
      await startLegacyBootstrap(instance, runtime.storage)
      await driveConversationJobs(instance, runtime.storage, ["turn:observe"])
      const failed = await runtime.storage.get<ConversationState>("state")
      const retry = runtime.storage.sql.exec<{ time: number }>(
        "SELECT time FROM cf_agents_jobs WHERE id = ?",
        "turn:observe",
      ).toArray()[0]
      expect(failed?.budgetReservation).toMatchObject({ reservationID: "reservation-detached", dispatched: true })
      expect(failed?.lifecycleJobError).toMatchObject({ kind: "turn:observe", message: "job failed; owned work remains pending" })
      expect(retry?.time).toBeGreaterThan(Date.now())

      await driveConversationJobs(instance, runtime.storage, ["turn:observe"])
      const settled = await runtime.storage.get<ConversationState>("state")
      return { contextCalls, promptCalls, phase: settled?.phase, reservation: settled?.budgetReservation }
    })
    expect(result.contextCalls).toBe(2)
    expect(result.promptCalls).toBe(0)
    expect(result.phase).toBe("idle")
    expect(result.reservation).toBeUndefined()
  })

  it("does not replace a still-live claim after its deadline expires", async () => {
    const stub = env.CONVERSATION.getByName("C1:jobs-live-expired-claim")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      let contextCalls = 0
      let entered!: () => void
      let release!: () => void
      const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
      const blocked = new Promise<void>((resolve) => { release = resolve })
      instance.transport = (port) => ({
        async fetch(input: Request | string | URL): Promise<Response> {
          const request = input instanceof Request ? input : new Request(input)
          const url = new URL(request.url)
          if (port === 4001 && url.pathname === "/status") return Response.json({ initialized: true })
          if (port === 4001 && url.pathname === "/start") return Response.json(accountingPolicyStart)
          if (port === 4001 && url.pathname === "/configure") return Response.json({ ok: true })
          if (url.pathname === "/api/config") return Response.json(accountingPolicyConfig)
          if (url.pathname === "/api/session/ses_existing/context") {
            contextCalls++
            entered()
            await blocked
            return Response.json({ data: [] })
          }
          if (url.pathname === "/api/session/ses_existing/permission") return Response.json({ data: [] })
          return Response.json({ data: {} })
        },
      })
      await runtime.storage.put("state", {
        phase: "running",
        runStartedAt: Date.now(),
        turnBaseline: "before",
        sessionID: "ses_existing",
        budgetReservation: { reservationID: "reservation-live-claim", date: "2026-11-12", dispatched: true },
        seen: [],
        pending: {},
      } satisfies ConversationState)
      await startLegacyBootstrap(instance, runtime.storage)
      await makeConversationJobsDue(runtime.storage, ["turn:observe"])
      await instance.alarm()
      await enteredPromise

      const claims = await runtime.storage.get<Record<string, { epoch: number; claimID: string; until: number }>>(
        "conversationJobClaims",
      )
      const original = claims?.["turn:observe"]
      expect(original).toBeDefined()
      await runtime.storage.put("conversationJobClaims", {
        ...claims,
        "turn:observe": { ...original!, until: Date.now() - 1 },
      })
      runtime.storage.sql.exec(
        "UPDATE cf_agents_jobs SET time = ?, running = 0, execution_started_at = NULL WHERE id = ?",
        Date.now(),
        "turn:observe",
      )
      await instance.alarm()
      const afterWake = await runtime.storage.get<Record<string, { claimID: string; until: number }>>(
        "conversationJobClaims",
      )
      const preserved = afterWake?.["turn:observe"]
      release()
      for (let attempt = 0; attempt < 500; attempt++) {
        const current = await runtime.storage.get<Record<string, unknown>>("conversationJobClaims")
        if (!current || Object.keys(current).length === 0) break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const finalClaims = await runtime.storage.get<Record<string, unknown>>("conversationJobClaims")
      const retry = runtime.storage.sql.exec<{ time: number; payload: string }>(
        "SELECT time, payload FROM cf_agents_jobs WHERE id = ?",
        "turn:observe",
      ).toArray()[0]
      return {
        contextCalls,
        sameClaim: preserved?.claimID === original?.claimID,
        noClaims: !finalClaims || Object.keys(finalClaims).length === 0,
        retryTime: retry?.time,
      }
    })
    expect(result.contextCalls).toBe(1)
    expect(result.sameClaim).toBe(true)
    expect(result.noClaims).toBe(true)
    expect(result.retryTime).toBeGreaterThan(Date.now())
  })

  it("preserves a newer typed observation claim when a translated legacy alarm bootstraps", async () => {
    const stub = env.CONVERSATION.getByName("C1:jobs-bootstrap-preserves-typed-row")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const oldAlarmAt = Date.now() + 60_000
      await runtime.storage.setAlarm(oldAlarmAt)
      await runtime.storage.put("state", {
        phase: "idle",
        sessionID: "ses_existing",
        budgetReservation: { reservationID: "reservation-bootstrap", date: "2026-11-12", dispatched: false },
        seen: [],
        pending: {},
      } satisfies ConversationState)
      const marked = await instance.markBudgetReservationDispatched(
        { reservationID: "reservation-bootstrap", date: "2026-11-12", dispatched: false },
        "before",
      )
      expect(marked).toBe(true)
      const epoch = await runtime.storage.get<number>("conversationJobEpoch")
      const row = runtime.storage.sql.exec<{ time: number; payload: string }>(
        "SELECT time, payload FROM cf_agents_jobs WHERE id = ?",
        "turn:observe",
      ).toArray()[0]
      expect(row).toBeDefined()
      const payload = JSON.parse(row!.payload) as Record<string, unknown>
      const claimID = "claim-preserve-this-owner"
      const claimUntil = Date.now() + 120_000
      const originalPayload = JSON.stringify({ ...payload, claimID, dueAt: claimUntil })
      runtime.storage.sql.exec(
        "UPDATE cf_agents_jobs SET time = ?, payload = ? WHERE id = ?",
        claimUntil,
        originalPayload,
        "turn:observe",
      )
      const originalRow = { time: claimUntil, payload: originalPayload }
      await runtime.storage.put("conversationJobClaims", {
        "turn:observe": { epoch, claimID, until: claimUntil },
      })
      const bootstrapRow = runtime.storage.sql.exec<{ time: number }>(
        "SELECT time FROM cf_agents_jobs WHERE id = ?",
        "legacy:bootstrap",
      ).toArray()[0]
      runtime.storage.sql.exec(
        "UPDATE cf_agents_jobs SET time = ?, running = 0, execution_started_at = NULL WHERE id = ?",
        Date.now(),
        "legacy:bootstrap",
      )
      await instance.alarm()
      for (let attempt = 0; attempt < 100; attempt++) {
        const migration = await runtime.storage.get<{ consumed: boolean }>("lifecycleLegacyAlarmMigration")
        if (migration?.consumed) break
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      const preserved = runtime.storage.sql.exec<{ time: number; payload: string }>(
        "SELECT time, payload FROM cf_agents_jobs WHERE id = ?",
        "turn:observe",
      ).toArray()[0]
      const claims = await runtime.storage.get<Record<string, { epoch: number; claimID: string; until: number }>>(
        "conversationJobClaims",
      )
      const bootstrap = runtime.storage.sql.exec("SELECT id FROM cf_agents_jobs WHERE id = ?", "legacy:bootstrap").toArray()[0]
      return {
        oldAlarmAt,
        bootstrapTime: bootstrapRow?.time,
        originalRow,
        preserved,
        claim: claims?.["turn:observe"],
        expectedClaim: { epoch, claimID, until: claimUntil },
        bootstrapPresent: Boolean(bootstrap),
      }
    })
    expect(result.bootstrapTime).toBe(result.oldAlarmAt)
    expect(result.preserved).toEqual(result.originalRow)
    expect(result.claim).toEqual(result.expectedClaim)
    expect(result.bootstrapPresent).toBe(false)
  })
})
