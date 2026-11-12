import { describe, expect, it } from "vitest"
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test"
import type { Conversation } from "../src/conversation"
import type { ConversationState } from "../src/state"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"

const settings = () => env.SETTINGS.getByName("global")
const stub = (key: string) => env.CONVERSATION.getByName(`C1:${key}`)
const domainWakeIDs = ["turn:observe", "admission:retry", "checkpoint:retry", "recovery:wake"]

type JobRow = { id: string; fn: string; capability: string; time: number; payload: string | null }
type LegacyAlarmMarker = { version: number; dueAt: number | null; scheduled: boolean; consumed: boolean }

function jobs(storage: DurableObjectStorage): JobRow[] {
  return storage.sql.exec<JobRow>(
    "SELECT id, fn, capability, time, payload FROM cf_agents_jobs ORDER BY id",
  ).toArray()
}

function noRuntimeCalls(calls: string[]) {
  return () => ({
    async fetch(input: Request | string | URL): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input)
      calls.push(`${request.method} ${new URL(request.url).pathname}`)
      throw new Error("passive startup test must not access the runtime")
    },
  })
}

function runtimeProbe(calls: string[], prompts: { count: number }) {
  return (_port: number) => ({
    async fetch(input: Request | string | URL): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input)
      const url = new URL(request.url)
      calls.push(`${request.method} ${url.pathname}`)
      if (url.pathname === "/status") return Response.json({ initialized: true })
      if (url.pathname === "/configure") return Response.json({ ok: true })
      if (url.pathname === "/start") return Response.json(accountingPolicyStart)
      if (url.pathname === "/checkpoint") return new Response(null, { status: 204 })
      if (url.pathname === "/api/config") return Response.json(accountingPolicyConfig)
      if (url.pathname.endsWith("/context") || url.pathname.endsWith("/permission")) return Response.json({ data: [] })
      if (url.pathname.endsWith("/prompt")) {
        prompts.count++
        return Response.json({ data: {} })
      }
      if (url.pathname === "/api/event") return new Response(null, { status: 200 })
      return Response.json({ error: "not found" }, { status: 404 })
    },
  })
}

async function seedHeldState(
  storage: DurableObjectStorage,
  conversationID: string,
  reservationID: string,
  sessionID: string,
) {
  const date = new Date().toISOString().slice(0, 10)
  const grant = await settings().fetch("https://settings/usage/reserve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationID, reservationID, costUSD: 0.1 }),
  })
  if (!grant.ok) throw new Error(`hold setup failed: ${grant.status}`)
  const hold = await grant.json() as { date: string }
  await settings().fetch("https://settings/usage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationID, sessionID, sourceID: `${reservationID}:prior`, date, costUSD: 0.025, input: 100, output: 8 }),
  })
  const state: ConversationState = {
    phase: "running",
    sessionID,
    runStartedAt: Date.now(),
    budgetReservation: { reservationID, date: hold.date, dispatched: true },
    usageCursor: { sessionID, seq: 4 },
    usageExecution: { sessionID, startedSeq: 7, terminalSeq: 3, latestStepSeq: 6 },
    seen: [],
    pending: {},
  }
  await storage.put("state", state)
  return state
}

async function ledger(conversationID: string, reservationID: string) {
  const response = await settings().fetch(
    `https://settings/usage/cutover?conversationID=${encodeURIComponent(conversationID)}&reservationID=${encodeURIComponent(reservationID)}`,
  )
  return await response.json() as { rows: unknown[]; holds: unknown[]; retirement?: unknown }
}

async function connectedReader(instance: Conversation): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await instance.fetch(new Request("https://conversation/events"))
  if (!response.ok || !response.body) throw new Error(`event stream failed: ${response.status}`)
  const reader = response.body.getReader()
  const first = await reader.read()
  if (first.done || !new TextDecoder().decode(first.value).includes(": connected\n\n")) {
    throw new Error("event stream did not send its connected frame")
  }
  return reader
}

async function waitForJob(storage: DurableObjectStorage, id: string, timeoutMs = 2_000): Promise<JobRow | undefined> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const found = jobs(storage).find((job) => job.id === id)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return undefined
}

async function waitForNoClaims(storage: DurableObjectStorage): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const claims = await storage.get<Record<string, unknown>>("conversationJobClaims")
    if (!claims || Object.keys(claims).length === 0) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("conversation lifecycle work did not finish")
}

describe("Conversation Lifecycle startup recovery", () => {
  it("keeps passive reads and an orphaned SSE heartbeat from reconstructing a dormant held turn", async () => {
    const conversation = stub("startup-dormant-held-no-alarm")
    let conversationID = ""
    const reservationID = "reservation-startup-dormant"
    const before = await runInDurableObject(conversation, async (_instance, runtime) => {
      conversationID = runtime.id.toString()
      await runtime.storage.deleteAlarm()
      const state = await seedHeldState(runtime.storage, conversationID, reservationID, "ses_startup_dormant")
      return { state, authority: await ledger(conversationID, reservationID) }
    })

    await evictDurableObject(conversation)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const firstColdRead = await runInDurableObject(conversation, async (instance, runtime) => {
      const calls: string[] = []
      instance.transport = noRuntimeCalls(calls)
      const health = await instance.fetch(new Request("https://conversation/health"))
      const stateResponse = await instance.fetch(new Request("https://conversation/state"))
      const recoveryResponse = await instance.fetch(new Request("https://conversation/recovery"))
      reader = await connectedReader(instance)
      const activeJobs = jobs(runtime.storage)
      const state = await stateResponse.json() as ConversationState
      const recovery = await recoveryResponse.json() as { kind: string; actions: string[] }
      return {
        healthStatus: health.status,
        state,
        recovery,
        activeJobs,
        calls,
        alarm: await runtime.storage.getAlarm(),
      }
    })

    expect(firstColdRead.healthStatus).toBe(200)
    expect(firstColdRead.recovery).toMatchObject({ kind: "dispatched", actions: ["retry"] })
    expect(firstColdRead.activeJobs.filter((job) => domainWakeIDs.includes(job.id))).toEqual([])
    expect(firstColdRead.activeJobs.some((job) => job.id === "sse:heartbeat" && job.capability === "event-stream")).toBe(true)
    expect(firstColdRead.calls).toEqual([])
    expect(firstColdRead.state.budgetReservation).toEqual(before.state.budgetReservation)
    expect(firstColdRead.alarm).toBeTypeOf("number")

    // The open stream leaves only its orphanable heartbeat intent. A later
    // instance startup may cancel that intent, but must not infer a turn wake.
    await evictDurableObject(conversation)
    const afterEviction = await runInDurableObject(conversation, async (instance, runtime) => {
      const calls: string[] = []
      instance.transport = noRuntimeCalls(calls)
      await instance.fetch(new Request("https://conversation/health"))
      const activeJobs = jobs(runtime.storage)
      const state = await runtime.storage.get<ConversationState>("state")
      return {
        activeJobs,
        state,
        calls,
        authority: await ledger(conversationID, reservationID),
      }
    })
    await reader?.cancel().catch(() => {})

    expect(afterEviction.activeJobs.filter((job) => domainWakeIDs.includes(job.id))).toEqual([])
    expect(afterEviction.activeJobs.some((job) => job.id === "sse:heartbeat")).toBe(false)
    expect(afterEviction.calls).toEqual([])
    expect(afterEviction.state?.budgetReservation).toEqual(before.state.budgetReservation)
    expect(afterEviction.authority).toEqual(before.authority)
  })

  it("translates a future legacy alarm once and does not run it early on an SSE heartbeat", async () => {
    const conversation = stub("startup-future-legacy-alarm")
    let conversationID = ""
    const reservationID = "reservation-startup-future"
    const dueAt = Date.now() + 60_000
    await runInDurableObject(conversation, async (_instance, runtime) => {
      conversationID = runtime.id.toString()
      await seedHeldState(runtime.storage, conversationID, reservationID, "ses_startup_future")
      await runtime.storage.setAlarm(dueAt)
    })
    await evictDurableObject(conversation)

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const translated = await runInDurableObject(conversation, async (instance, runtime) => {
      const calls: string[] = []
      instance.transport = noRuntimeCalls(calls)
      await instance.fetch(new Request("https://conversation/health"))
      reader = await connectedReader(instance)
      const row = await waitForJob(runtime.storage, "legacy:bootstrap")
      const marker = await runtime.storage.get<LegacyAlarmMarker>("lifecycleLegacyAlarmMigration")
      return { row, marker, calls, jobs: jobs(runtime.storage) }
    })
    expect(translated.marker).toMatchObject({ version: 1, dueAt, scheduled: true, consumed: false })
    expect(translated.row).toMatchObject({
      id: "legacy:bootstrap",
      fn: "legacyBootstrap",
      capability: "conversation-jobs",
      time: dueAt,
    })
    expect(JSON.parse(translated.row!.payload ?? "{}")).toMatchObject({ reason: "legacy-alarm-bootstrap", dueAt })
    expect(translated.calls).toEqual([])

    const heartbeat = await runInDurableObject(conversation, async (instance, runtime) => {
      runtime.storage.sql.exec(
        "UPDATE cf_agents_jobs SET time = ?, running = 0, execution_started_at = NULL WHERE id = ? AND capability = ?",
        Date.now(),
        "sse:heartbeat",
        "event-stream",
      )
      await instance.alarm()
      await waitForNoClaims(runtime.storage)
      const stillPending = jobs(runtime.storage).find((job) => job.id === "legacy:bootstrap")
      const domain = jobs(runtime.storage).filter((job) => domainWakeIDs.includes(job.id))
      return { stillPending, domain, marker: await runtime.storage.get<LegacyAlarmMarker>("lifecycleLegacyAlarmMigration") }
    })
    expect(heartbeat.stillPending?.time).toBe(dueAt)
    expect(heartbeat.domain).toEqual([])
    expect(heartbeat.marker).toMatchObject({ version: 1, dueAt, scheduled: true, consumed: false })

    const afterDue = await runInDurableObject(conversation, async (instance, runtime) => {
      const calls: string[] = []
      const prompts = { count: 0 }
      instance.transport = runtimeProbe(calls, prompts)
      runtime.storage.sql.exec(
        "UPDATE cf_agents_jobs SET time = ?, running = 0, execution_started_at = NULL WHERE id = ? AND capability = ?",
        Date.now(),
        "legacy:bootstrap",
        "conversation-jobs",
      )
      await instance.alarm()
      await waitForNoClaims(runtime.storage)
      return { domain: jobs(runtime.storage).filter((job) => domainWakeIDs.includes(job.id)), calls, prompts: prompts.count }
    })
    await reader?.cancel().catch(() => {})
    expect(afterDue.domain.some((job) => job.id === "turn:observe")).toBe(true)
    expect(afterDue.prompts).toBe(0)
  })

  it("bootstraps a legacy alarm-only delivery with null alarm once, then treats later heartbeat as ordinary", async () => {
    const conversation = stub("startup-alarm-only-legacy")
    let conversationID = ""
    const reservationID = "reservation-startup-alarm-only"
    await runInDurableObject(conversation, async (_instance, runtime) => {
      conversationID = runtime.id.toString()
      await seedHeldState(runtime.storage, conversationID, reservationID, "ses_startup_alarm_only")
      await runtime.storage.deleteAlarm()
    })
    await evictDurableObject(conversation)

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const bootstrapped = await runInDurableObject(conversation, async (instance, runtime) => {
      const calls: string[] = []
      const prompts = { count: 0 }
      instance.transport = runtimeProbe(calls, prompts)
      // This must be the cold instance's first entry point: no health/fetch may
      // pre-start Lifecycle or consume the legacy alarm-delivery context.
      expect(await runtime.storage.getAlarm()).toBeNull()
      await instance.alarm()
      await waitForNoClaims(runtime.storage)
      const marker = await runtime.storage.get<LegacyAlarmMarker>("lifecycleLegacyAlarmMigration")
      const domain = jobs(runtime.storage).filter((job) => domainWakeIDs.includes(job.id))
      reader = await connectedReader(instance)
      return { marker, domain, calls, prompts: prompts.count, rows: jobs(runtime.storage) }
    })
    expect(bootstrapped.marker).toMatchObject({ version: 1, dueAt: expect.any(Number), scheduled: false, consumed: true })
    expect(bootstrapped.domain.some((job) => job.id === "turn:observe")).toBe(true)
    expect(bootstrapped.prompts).toBe(0)
    expect(bootstrapped.rows.filter((job) => job.id === "legacy:bootstrap")).toHaveLength(0)

    const afterHeartbeat = await runInDurableObject(conversation, async (instance, runtime) => {
      runtime.storage.sql.exec(
        "UPDATE cf_agents_jobs SET time = ?, running = 0, execution_started_at = NULL WHERE id = ? AND capability = ?",
        Date.now(),
        "sse:heartbeat",
        "event-stream",
      )
      await instance.alarm()
      await waitForNoClaims(runtime.storage)
      return {
        marker: await runtime.storage.get<LegacyAlarmMarker>("lifecycleLegacyAlarmMigration"),
        bootstrap: jobs(runtime.storage).filter((job) => job.id === "legacy:bootstrap"),
        domain: jobs(runtime.storage).filter((job) => domainWakeIDs.includes(job.id)),
      }
    })
    await reader?.cancel().catch(() => {})
    expect(afterHeartbeat.marker).toMatchObject({ version: 1, scheduled: false, consumed: true })
    expect(afterHeartbeat.bootstrap).toHaveLength(0)
    expect(afterHeartbeat.domain.some((job) => job.id === "turn:observe")).toBe(true)
  })

  it.each(["fetch-before-due", "fetch-after-due"] as const)(
    "preserves a platform-scheduled legacy wake around cold fetch (%s)",
    async (order) => {
      const conversation = stub(`startup-native-alarm-${order}`)
      let conversationID = ""
      const reservationID = `reservation-startup-due-${order}`
      const dueAt = Date.now() + 1_000
      const calls: string[] = []
      const prompts = { count: 0 }
      await runInDurableObject(conversation, async (_instance, runtime) => {
        _instance.transport = runtimeProbe(calls, prompts)
        conversationID = runtime.id.toString()
        await seedHeldState(runtime.storage, conversationID, reservationID, `ses_startup_due_${order}`)
        await runtime.storage.setAlarm(dueAt)
        // Simulate state written by a pre-Lifecycle version. The old code had
        // a physical alarm but no migration marker.
        await runtime.storage.delete("lifecycleLegacyAlarmMigration")
      })
      await evictDurableObject(conversation)

      const beforeEvents = await runInDurableObject(conversation, async (instance, runtime) => {
        // This test-only callback installs a transport and reads storage. It
        // never calls fetch/alarm, so it does not replace a platform event.
        instance.transport = runtimeProbe(calls, prompts)
        return {
          marker: await runtime.storage.get<LegacyAlarmMarker>("lifecycleLegacyAlarmMigration"),
          alarm: await runtime.storage.getAlarm(),
        }
      })

      expect(beforeEvents.marker).toBeUndefined()
      expect(beforeEvents.alarm).toBe(dueAt)
      const healthRequest = () => conversation.fetch(new Request("https://conversation/health"))
      if (order === "fetch-before-due") {
        expect((await healthRequest()).status).toBe(200)
      } else {
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, dueAt - Date.now() + 40)))
      }

      let observed: {
        marker?: LegacyAlarmMarker
        observation?: JobRow
        bootstrap: JobRow[]
        alarm: number | null
      } | undefined
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        observed = await runInDurableObject(conversation, async (_instance, runtime) => ({
          marker: await runtime.storage.get<LegacyAlarmMarker>("lifecycleLegacyAlarmMigration"),
          observation: jobs(runtime.storage).find((job) => job.id === "turn:observe"),
          bootstrap: jobs(runtime.storage).filter((job) => job.id === "legacy:bootstrap"),
          alarm: await runtime.storage.getAlarm(),
        }))
        if (observed.marker?.consumed && observed.observation) break
        await new Promise((resolve) => setTimeout(resolve, 15))
      }
      // For fetch-after-due, wait for the native alarm handoff before issuing
      // the passive request. No test helper deletes or invokes the alarm.
      const healthResponse = order === "fetch-after-due" ? await healthRequest() : undefined

      const result = await runInDurableObject(conversation, async (_instance, runtime) => {
        await waitForNoClaims(runtime.storage)
        return {
          healthStatus: healthResponse?.status ?? 200,
          observed,
          marker: await runtime.storage.get<LegacyAlarmMarker>("lifecycleLegacyAlarmMigration"),
          observation: jobs(runtime.storage).find((job) => job.id === "turn:observe"),
          bootstrap: jobs(runtime.storage).filter((job) => job.id === "legacy:bootstrap"),
          calls,
          prompts: prompts.count,
          local: await runtime.storage.get<ConversationState>("state"),
          authority: await ledger(conversationID, reservationID),
        }
      })

      expect(result.observed?.marker?.dueAt).toBeGreaterThanOrEqual(dueAt)
      expect(result.observed?.marker?.dueAt).toBeLessThanOrEqual(Date.now())
      expect(result.observed?.marker).toMatchObject({ scheduled: false, consumed: true })
      expect(result.observed?.observation).toMatchObject({ id: "turn:observe", fn: "turnObserve", capability: "conversation-jobs" })
      expect(result.observed?.bootstrap).toEqual([])
      expect(result.observed?.alarm).toBeTypeOf("number")
      expect(result.healthStatus).toBe(200)
      expect(result.marker).toMatchObject({ version: 1, scheduled: false, consumed: true })
      expect(result.marker?.dueAt).toBeGreaterThanOrEqual(dueAt)
      expect(result.marker?.dueAt).toBeLessThanOrEqual(Date.now())
      expect(result.bootstrap).toHaveLength(0)
      expect(result.observation).toMatchObject({ id: "turn:observe", fn: "turnObserve", capability: "conversation-jobs" })
      expect(result.prompts).toBe(0)
      expect(result.local?.budgetReservation).toMatchObject({ reservationID, dispatched: true })
      expect(result.authority.holds).toHaveLength(1)
      expect(result.authority.rows).toHaveLength(1)
    },
    10_000,
  )
})
