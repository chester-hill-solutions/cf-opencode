import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
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
