import { describe, expect, it } from "vitest"
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test"
import { driveConversationJobs } from "./helpers/conversation-jobs"
import { ConversationLease } from "../src/conversation/lease"

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function settingsPort(overrides: {
  beforeFetch?: (url: URL) => Promise<void>
  afterFetch?: (url: URL, response: Response) => Promise<Response>
} = {}) {
  const settings = env.SETTINGS.getByName("global")
  return {
    async fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      await overrides.beforeFetch?.(url)
      const response = await settings.fetch(request)
      return overrides.afterFetch ? overrides.afterFetch(url, response) : response
    },
  }
}

function makeLease(
  runtime: DurableObjectState,
  id: string,
  state: { enabled: boolean; stopped: boolean },
  settings = settingsPort(),
  scheduled: Array<{ at: number; reason: string }> = [],
  cancelled: { count: number } = { count: 0 },
) {
  return new ConversationLease({
    storage: runtime.storage,
    settings: () => settings,
    identity: {
      id,
      enabled: () => state.enabled,
      confirmedStopped: () => state.stopped,
    },
    jobs: {
      schedule: async (at, reason) => { scheduled.push({ at, reason }) },
      cancel: async () => { cancelled.count++ },
    },
  })
}

async function centralLease(id: string): Promise<number | undefined> {
  const settings = env.SETTINGS.getByName("global")
  return runInDurableObject(settings, async (_instance, runtime) =>
    runtime.storage.get<number>(`lease:${id}`),
  )
}

describe("ConversationLease", () => {
  it("acquires and renews the Settings lease with a durable acknowledgement deadline", async () => {
    const stub = env.CONVERSATION.getByName("C1:lease-acquire-renew")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      const state = { enabled: true, stopped: false }
      const schedules: Array<{ at: number; reason: string }> = []
      const lease = makeLease(runtime, runtime.id.toString(), state, settingsPort(), schedules)
      await lease.ensureHeld()
      const first = await lease.status()
      await lease.ensureHeld()
      const callsAfterCachedEnsure = schedules.length
      await lease.renew()
      const renewed = await lease.status()
      return { first, renewed, schedules, callsAfterCachedEnsure, id: runtime.id.toString() }
    })
    const expiresAt = await centralLease(result.id)

    expect(result.first).toMatchObject({ version: 1, desired: "held", status: "acknowledged" })
    expect(result.first?.acknowledgedUntil).toBe(result.first!.requestStartedAt! + 10 * 60_000)
    expect(result.callsAfterCachedEnsure).toBe(2)
    expect(result.renewed?.requestStartedAt).toBeGreaterThanOrEqual(result.first!.requestStartedAt)
    expect(result.renewed?.acknowledgedUntil).toBe(result.renewed!.requestStartedAt! + 10 * 60_000)
    expect(result.schedules.at(-1)).toEqual({
      at: result.renewed!.requestStartedAt + 5 * 60_000,
      reason: "lease-renew",
    })
    expect(expiresAt).toBeGreaterThanOrEqual(result.renewed!.acknowledgedUntil!)
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60_000)
  })

  it("retains a lost release acknowledgement and retries it after a service reload", async () => {
    const stub = env.CONVERSATION.getByName("C1:lease-release-lost-ack")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      const id = runtime.id.toString()
      const identity = { enabled: true, stopped: false }
      const schedules: Array<{ at: number; reason: string }> = []
      const cancelled = { count: 0 }
      const initial = makeLease(runtime, id, identity, settingsPort(), schedules, cancelled)
      await initial.ensureHeld()
      const refusedWhileRunning = await initial.releaseAfterStop()
      identity.stopped = true
      let loseAck = true
      const flaky = settingsPort({
        afterFetch: async (url, response) => {
          if (url.pathname === "/leases/release" && loseAck) {
            loseAck = false
            throw new Error("response lost after Settings applied release")
          }
          return response
        },
      })
      const releasing = makeLease(runtime, id, identity, flaky, schedules, cancelled)
      const firstRelease = await releasing.releaseAfterStop()
      const pending = await runtime.storage.get<Awaited<ReturnType<typeof releasing.status>>> ("containerLease")
      const settingAfterLostAck = await centralLease(id)

      const reloaded = makeLease(runtime, id, identity, settingsPort(), schedules, cancelled)
      await reloaded.maintain()
      return {
        id,
        refusedWhileRunning,
        firstRelease,
        pending,
        settingAfterLostAck,
        final: await runtime.storage.get("containerLease"),
        cancelled: cancelled.count,
      }
    })

    expect(result.refusedWhileRunning).toBe(false)
    expect(result.firstRelease).toBe(false)
    expect(result.pending).toMatchObject({ desired: "released", status: "pending", errorCode: "authority_unavailable" })
    expect(result.settingAfterLostAck).toBeUndefined()
    expect(result.final).toBeUndefined()
    expect(await centralLease(result.id)).toBeUndefined()
    expect(result.cancelled).toBe(1)
  })

  it("serializes a queued renewal before stop so no renewal can follow release", async () => {
    const stub = env.CONVERSATION.getByName("C1:lease-renew-before-release")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      const id = runtime.id.toString()
      const identity = { enabled: true, stopped: false }
      const schedules: Array<{ at: number; reason: string }> = []
      const lease = makeLease(runtime, id, identity, settingsPort(), schedules)
      await lease.ensureHeld()

      const enteredAcquire = deferred()
      const releaseAcquire = deferred()
      let blockRenewal = true
      const delayedSettings = settingsPort({
        beforeFetch: async (url) => {
          if (url.pathname === "/leases/acquire" && blockRenewal) {
            blockRenewal = false
            enteredAcquire.resolve()
            await releaseAcquire.promise
          }
        },
      })
      const serialized = makeLease(runtime, id, identity, delayedSettings, schedules)
      await serialized.ensureHeld()
      const renewal = serialized.renew()
      await enteredAcquire.promise
      identity.stopped = true
      const release = serialized.releaseAfterStop()
      releaseAcquire.resolve()
      await Promise.all([renewal, release])
      const state = await runtime.storage.get("containerLease")
      const finalMaintain = serialized.maintain()
      await finalMaintain
      return { id, state, schedules }
    })

    expect(result.state).toBeUndefined()
    expect(await centralLease(result.id)).toBeUndefined()
    expect(result.schedules.some((job) => job.reason === "lease-renew")).toBe(true)
  })

  it("does not renew or reschedule after a successful stop release", async () => {
    const stub = env.CONVERSATION.getByName("C1:lease-renew-after-release")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      const id = runtime.id.toString()
      const identity = { enabled: true, stopped: false }
      const schedules: Array<{ at: number; reason: string }> = []
      const lease = makeLease(runtime, id, identity, settingsPort(), schedules)
      await lease.ensureHeld()
      identity.stopped = true
      const released = await lease.releaseAfterStop()
      const scheduledAtRelease = schedules.length
      await lease.renew()
      return {
        id,
        released,
        status: await lease.status(),
        schedulesAfterRenew: schedules.length,
        scheduledAtRelease,
      }
    })

    expect(result.released).toBe(true)
    expect(result.status).toBeUndefined()
    expect(result.schedulesAfterRenew).toBe(result.scheduledAtRelease)
    expect(await centralLease(result.id)).toBeUndefined()
  })

  it("fails closed on malformed persisted lease state without contacting Settings", async () => {
    const stub = env.CONVERSATION.getByName("C1:lease-malformed")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      const calls = { count: 0 }
      const identity = { enabled: true, stopped: true }
      const port = settingsPort({ beforeFetch: async () => { calls.count++ } })
      const lease = makeLease(runtime, runtime.id.toString(), identity, port)
      await runtime.storage.put("containerLease", {
        version: 1,
        desired: "held",
        status: "acknowledged",
        requestStartedAt: Date.now(),
        // A held acknowledgement without a conservative deadline is invalid.
      })
      let error: string | undefined
      try {
        await lease.ensureHeld()
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught)
      }
      return { error, calls: calls.count, state: await runtime.storage.get("containerLease") }
    })

    expect(result.error).toBe("container lease state is unreadable")
    expect(result.calls).toBe(0)
    expect(result.state).toMatchObject({ desired: "held", status: "acknowledged" })
  })
})


describe("Conversation lease job integration", () => {
  it("renews from the durable job after eviction while runtime ports are unavailable", async () => {
    const stub = env.CONVERSATION.getByName("C1:lease-job-after-eviction")
    const first = await runInDurableObject(stub, async (instance, runtime) => {
      const container = { running: true, async destroy() { this.running = false }, async setInactivityTimeout() {} }
      Object.defineProperty((instance as unknown as { ctx: object }).ctx, "container", { configurable: true, value: container })
      const internal = instance as unknown as { leases: ConversationLease }
      await instance.fetch(new Request("https://conversation/state", {
        headers: { "x-conversation-key": "C1:lease-job-after-eviction" },
      }))
      await internal.leases.ensureHeld()
      return {
        id: runtime.id.toString(),
        lease: await runtime.storage.get<Awaited<ReturnType<ConversationLease["status"]>>>("containerLease"),
        job: runtime.storage.sql.exec<{ id: string; capability: string }>(
          "SELECT id, capability FROM cf_agents_jobs WHERE id = ?", "lease:renew",
        ).toArray()[0],
      }
    })
    expect(first.lease).toMatchObject({ desired: "held", status: "acknowledged" })
    expect(first.job).toEqual({ id: "lease:renew", capability: "conversation-jobs" })

    await evictDurableObject(stub)
    const second = await runInDurableObject(stub, async (instance, runtime) => {
      const container = {
        running: true,
        async destroy() { this.running = false },
        async setInactivityTimeout() {},
        getTcpPort() { throw new Error("runtime port should not be used by lease renewal") },
      }
      Object.defineProperty((instance as unknown as { ctx: object }).ctx, "container", { configurable: true, value: container })
      const internal = instance as unknown as {
        leases: ConversationLease
        runtime: { stop(): Promise<boolean> }
      }
      await instance.fetch(new Request("https://conversation/state", {
        headers: { "x-conversation-key": "C1:lease-job-after-eviction" },
      }))
      await driveConversationJobs(instance, runtime.storage, ["lease:renew"])
      const renewed = await runtime.storage.get<Awaited<ReturnType<ConversationLease["status"]>>>("containerLease")
      const job = runtime.storage.sql.exec<{ id: string; time: number }>(
        "SELECT id, time FROM cf_agents_jobs WHERE id = ?", "lease:renew",
      ).toArray()[0]
      container.running = false
      const didStop = await internal.runtime.stop()
      const released = didStop && await internal.leases.releaseAfterStop()
      const remainingJob = runtime.storage.sql.exec<{ id: string }>(
        "SELECT id FROM cf_agents_jobs WHERE id = ?", "lease:renew",
      ).toArray()[0]
      return { renewed, job, released, remainingJob }
    })
    expect(second.renewed?.requestStartedAt).toBeGreaterThan(first.lease!.requestStartedAt)
    expect(second.job?.id).toBe("lease:renew")
    expect(second.released).toBe(true)
    expect(second.remainingJob).toBeUndefined()
  }, 12000)

  it("adopts a pre-service running native container without an old lease record", async () => {
    const stub = env.CONVERSATION.getByName("C1:lease-job-adoption")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const container = { running: true, async destroy() { this.running = false }, async setInactivityTimeout() {} }
      Object.defineProperty((instance as unknown as { ctx: object }).ctx, "container", { configurable: true, value: container })
      const internal = instance as unknown as {
        leases: ConversationLease
        runtime: { stop(): Promise<boolean> }
      }
      const state = await instance.fetch(new Request("https://conversation/state", {
        headers: { "x-conversation-key": "C1:lease-job-adoption" },
      }))
      const before = await runtime.storage.get("containerLease")
      const pendingJob = runtime.storage.sql.exec<{ id: string; capability: string }>(
        "SELECT id, capability FROM cf_agents_jobs WHERE id = ?", "lease:renew",
      ).toArray()[0]
      await driveConversationJobs(instance, runtime.storage, ["lease:renew"])
      const adopted = await runtime.storage.get<Awaited<ReturnType<ConversationLease["status"]>>>("containerLease")
      container.running = false
      const stopped = await internal.runtime.stop()
      const released = stopped && await internal.leases.releaseAfterStop()
      return { stateStatus: state.status, before, pendingJob, adopted, released,
        remainingJob: runtime.storage.sql.exec("SELECT id FROM cf_agents_jobs WHERE id = ?", "lease:renew").toArray()[0] }
    })
    expect(result.stateStatus).toBe(200)
    expect(result.before).toBeUndefined()
    expect(result.pendingJob).toEqual({ id: "lease:renew", capability: "conversation-jobs" })
    expect(result.adopted).toMatchObject({ desired: "held", status: "acknowledged" })
    expect(result.released).toBe(true)
    expect(result.remainingJob).toBeUndefined()
  })

  it("keeps local state and the held lease when container destruction fails", async () => {
    const stub = env.CONVERSATION.getByName("C1:lease-stop-failure")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const container = { running: true, async destroy() { throw new Error("destroy failed") }, async setInactivityTimeout() {} }
      Object.defineProperty((instance as unknown as { ctx: object }).ctx, "container", { configurable: true, value: container })
      const internal = instance as unknown as { leases: ConversationLease }
      await runtime.storage.put("state", { phase: "idle", sessionID: "ses_keep", marker: "keep", seen: [], pending: {} })
      await instance.fetch(new Request("https://conversation/state", {
        headers: { "x-conversation-key": "C1:lease-stop-failure" },
      }))
      await internal.leases.ensureHeld()
      const beforeLease = await runtime.storage.get<Awaited<ReturnType<ConversationLease["status"]>>>("containerLease")
      const response = await instance.fetch(new Request("https://conversation/reset", {
        method: "POST",
        headers: { "x-conversation-key": "C1:lease-stop-failure" },
      }))
      return {
        status: response.status,
        state: await runtime.storage.get<Record<string, unknown>>("state"),
        beforeLease,
        afterLease: await runtime.storage.get<Awaited<ReturnType<ConversationLease["status"]>>>("containerLease"),
      }
    })
    expect(result.status).toBe(503)
    expect(result.state).toMatchObject({ sessionID: "ses_keep", marker: "keep" })
    expect(result.afterLease).toEqual(result.beforeLease)
  })
})
