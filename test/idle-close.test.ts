import { describe, expect, it } from "vitest"
import type { ConversationState } from "../src/state"
import { ConversationIdleClose, type ConversationIdleCloseOptions, type IdleCloseJobPayload } from "../src/conversation/idle-close"
import type { ContainerIdleRecord } from "../src/conversation/idle-state"
import type { RuntimeQuiescenceResult } from "../src/runtime-quiescence"
import { ConversationRuntimeAccess } from "../src/conversation/runtime-access"

function makeHarness(options: {
  state?: Partial<ConversationState>
  manifest?: boolean
  busy?: boolean
  stopResult?: boolean
  releaseResults?: boolean[]
  proofGeneration?: string
  changeActivityDuringProof?: boolean
  nativeRunning?: boolean
  leaseRecord?: unknown
  archiveFails?: boolean
  checkpointCaptureFails?: boolean
  ledgerHolds?: number
  ledgerBlockers?: number
  ledgerThrows?: boolean
  realAccess?: boolean
  queueUseOnSnapshotClear?: boolean
} = {}) {
  const values = new Map<string, unknown>()
  values.set("state", {
    phase: "idle",
    sessionID: "ses_idle",
    seen: [],
    pending: {},
    ...options.state,
  } satisfies ConversationState)
  if (options.leaseRecord !== undefined) values.set("containerLease", options.leaseRecord)
  if (options.manifest) {
    values.set("state", {
      ...(values.get("state") as ConversationState),
      checkpointManifest: splitManifest(),
    })
  }
  const events: string[] = []
  let running = options.nativeRunning ?? true
  let generation: string | undefined = "generation-1"
  let stopFails = options.stopResult === false
  let activityEpoch = 11
  let idleClose!: ConversationIdleClose
  let queuedUse: Promise<string> | undefined
  const jobs: Array<{ at: number; payload: IdleCloseJobPayload }> = []
  let releases = [...(options.releaseResults ?? [true])]
  const storage = {
    async get<T>(key: string): Promise<T | undefined> { return values.get(key) as T | undefined },
    async put(key: string, value: unknown): Promise<void> { values.set(key, value) },
    async delete(key: string): Promise<boolean> { return values.delete(key) },
    async transaction<T>(work: (txn: {
      get<T>(key: string): Promise<T | undefined>
      put(key: string, value: unknown): Promise<void>
      delete(key: string): Promise<boolean>
    }) => Promise<T>): Promise<T> {
      return work(this)
    },
  }
  const stateStore = {
    async get() { return values.get("state") as ConversationState },
  }
  const usage = {
    async serialize<T>(work: () => Promise<T>): Promise<T> {
      events.push("usage.enter")
      try { return await work() } finally { events.push("usage.exit") }
    },
    async replayLogLocked(_sessionID: string, _terminal?: string, _client?: unknown): Promise<void> {
      events.push("usage.replay")
    },
    async ledger() {
      events.push("usage.ledger")
      if (options.ledgerThrows) throw new Error("authority unavailable")
      return {
        conversationID: "conv-1",
        holds: Array.from({ length: options.ledgerHolds ?? 0 }, () => ({})),
        blockers: Array.from({ length: options.ledgerBlockers ?? 0 }, () => "blocked"),
        legacyRows: [],
      }
    },
  }
  const checkpoints = {
    async captureOwned(): Promise<boolean> {
      events.push("checkpoint.capture")
      if (!options.manifest || options.checkpointCaptureFails) return false
      values.set("state", {
        ...(values.get("state") as ConversationState),
        checkpointManifest: splitManifest(),
      })
      return true
    },
    async verifySplitArchive(_manifest: unknown, requireEncrypted: boolean): Promise<void> {
      events.push(`archive.verify:${requireEncrypted}`)
      if (options.archiveFails) throw new Error("archive verification failed")
    },
  }
  const controlPort = {
    async fetch() {
      return Response.json({ ok: true, accountingPolicy: "foreground-usage-v1", opencodeGeneration: "generation-1" })
    },
  }
  const apiPort = { async fetch() { return Response.json({}) } }
  const runtime = {
    get apiPort() { return running ? apiPort : undefined },
    get generation() { return generation },
    nativeRunning() { return running },
    async port(_number: number) { return controlPort },
    async stop() {
      events.push("runtime.stop")
      if (stopFails) return false
      running = false
      generation = undefined
      return true
    },
    get confirmedStopped() { return !running },
  }
  const fakeAccess = {
    get activityEpoch() { return activityEpoch },
    async exclusive<T>(work: () => Promise<T>): Promise<T> {
      events.push("access.enter")
      try { return await work() } finally { events.push("access.exit") }
    },
  }
  const realAccess = options.realAccess
    ? new ConversationRuntimeAccess({
        prepareOwned: async () => {
          events.push("runtime.prepare")
          await idleClose.beforePrepareOwned()
          if (!running) {
            running = true
            generation = "generation-2"
            events.push("runtime.start")
          }
          return apiPort
        },
        identity: () => ({ port: running ? apiPort : undefined, generation, ready: running, running }),
      })
    : undefined
  const access = realAccess ?? fakeAccess
  idleClose = new ConversationIdleClose({
    storage: storage as unknown as DurableObjectStorage,
    store: stateStore as unknown as ConversationIdleCloseOptions["store"],
    id: "conv-1",
    runtime: runtime as unknown as ConversationIdleCloseOptions["runtime"],
    access: access as unknown as ConversationIdleCloseOptions["access"],
    usage: usage as unknown as ConversationIdleCloseOptions["usage"],
    checkpoints: checkpoints as unknown as ConversationIdleCloseOptions["checkpoints"],
    images: { async clearSnapshot() {
      events.push("snapshot.clear")
      if (options.queueUseOnSnapshotClear && realAccess) {
        queuedUse = realAccess.useReady(async () => {
          events.push("runtime.user.use")
          return "usable"
        })
      }
      return true
    } } as unknown as ConversationIdleCloseOptions["images"],
    leases: {
      async releaseAfterStop() {
        events.push("lease.release")
        return releases.shift() ?? true
      },
    } as unknown as ConversationIdleCloseOptions["leases"],
    eligibleNative: () => true,
    locallyBusy: async () => Boolean(options.busy),
    withAdmissionLock: (work) => work(),
    stopStream: async () => { events.push("stream.stop"); return true },
    prove: async (_client, sessionID) => {
      events.push("runtime.prove")
      if (options.changeActivityDuringProof) activityEpoch++
      return {
        proof: { sessionID, runtimeGeneration: options.proofGeneration ?? "generation-1" },
      } as unknown as RuntimeQuiescenceResult
    },
    jobs: {
      async schedule(at, payload) { jobs.push({ at, payload }) },
      async cancel() { events.push("job.cancel") },
    },
  })

  function seedIntent(phase: ContainerIdleRecord["phase"] = "waiting"): ContainerIdleRecord {
    const record: ContainerIdleRecord = {
      version: 1,
      id: "idle-1",
      generation: "generation-1",
      dueAt: 0,
      phase,
    }
    values.set("containerIdle", record)
    return record
  }

  const payload = { idleID: "idle-1", runtimeGeneration: "generation-1" }
  return {
    idleClose, values, events, jobs, seedIntent, payload, runtime, access,
    queuedUse: () => queuedUse,
    setStopFails: (value: boolean) => { stopFails = value },
  }
}

function splitManifest() {
  return {
    workspace: { key: "workspaces/conv-1/workspace-1.tar.gz", size: 3, encrypted: true },
    state: { key: "workspaces/conv-1/state-1.tar.gz", size: 3, encrypted: true },
    createdAt: 1,
  }
}

describe("ConversationIdleClose", () => {
  it("touches a running generation once after use and preserves a closing owner", async () => {
    const harness = makeHarness()
    expect(await harness.idleClose.touch()).toBe(true)
    const record = harness.values.get("containerIdle") as ContainerIdleRecord
    expect(record).toMatchObject({ version: 1, generation: "generation-1", phase: "waiting" })
    expect(record.dueAt).toBeGreaterThanOrEqual(Date.now() + 29_000)
    expect(harness.jobs).toEqual([{ at: record.dueAt, payload: { idleID: record.id, runtimeGeneration: record.generation } }])

    harness.seedIntent("closing")
    const closing = harness.values.get("containerIdle")
    expect(await harness.idleClose.touch()).toBe(false)
    expect(harness.values.get("containerIdle")).toEqual(closing)
  })

  it("proves usage and archives before persisting closing, stopping, and releasing", async () => {
    const harness = makeHarness({ manifest: true })
    harness.seedIntent()
    const outcome = await harness.idleClose.run(harness.payload)
    expect(outcome).toBeUndefined()
    expect(harness.values.get("containerIdle")).toBeUndefined()
    expect(harness.runtime.confirmedStopped).toBe(true)
    expect(harness.events.indexOf("stream.stop")).toBeLessThan(harness.events.indexOf("usage.enter"))
    expect(harness.events.indexOf("usage.replay")).toBeLessThan(harness.events.indexOf("runtime.prove"))
    expect(harness.events.indexOf("runtime.prove")).toBeLessThan(harness.events.indexOf("checkpoint.capture"))
    expect(harness.events.indexOf("checkpoint.capture")).toBeLessThan(harness.events.indexOf("archive.verify:true"))
    expect(harness.events.indexOf("archive.verify:true")).toBeLessThan(harness.events.indexOf("snapshot.clear"))
    expect(harness.events.indexOf("snapshot.clear")).toBeLessThan(harness.events.indexOf("runtime.stop"))
    expect(harness.events.indexOf("runtime.stop")).toBeLessThan(harness.events.indexOf("lease.release"))
    expect(harness.events.indexOf("job.cancel")).toBeGreaterThan(harness.events.indexOf("lease.release"))
  })

  it("releases capacity for an already-stopped binding without runtime access or archive capture", async () => {
    const priorState = {
      phase: "idle",
      sessionID: "ses_idle",
      budgetReservation: { reservationID: "retained-hold", date: "2026-11-12", dispatched: true },
      usageError: "preserve financial evidence",
      seen: [],
      pending: {},
    } satisfies ConversationState
    const harness = makeHarness({
      state: priorState,
      nativeRunning: false,
      leaseRecord: {
        version: 1,
        desired: "held",
        status: "acknowledged",
        requestStartedAt: Date.now() - 1,
        acknowledgedUntil: Date.now() + 60_000,
      },
    })
    harness.seedIntent()
    expect(await harness.idleClose.run(harness.payload)).toBeUndefined()
    expect(harness.events).toContain("runtime.stop")
    expect(harness.events).toContain("lease.release")
    expect(harness.events).not.toContain("runtime.prove")
    expect(harness.events).not.toContain("usage.replay")
    expect(harness.events).not.toContain("checkpoint.capture")
    expect(harness.events).not.toContain("snapshot.clear")
    expect(harness.values.get("state")).toEqual(priorState)
    expect(harness.values.get("containerIdle")).toBeUndefined()
  })

  it("allows a normal prepare while only a waiting intent exists for a stopped binding", async () => {
    const harness = makeHarness({
      nativeRunning: false,
      leaseRecord: {
        version: 1,
        desired: "held",
        status: "acknowledged",
        requestStartedAt: 1,
        acknowledgedUntil: Date.now() + 60_000,
      },
    })
    harness.seedIntent("waiting")
    await expect(harness.idleClose.beforePrepareOwned()).resolves.toBeUndefined()
  })

  it("finishes an already-claimed close before releasing a queued real runtime reader", async () => {
    const harness = makeHarness({ manifest: true, realAccess: true, queueUseOnSnapshotClear: true })
    harness.seedIntent()
    const close = await harness.idleClose.run(harness.payload)
    expect(close).toBeUndefined()
    const queuedUse = harness.queuedUse()
    expect(queuedUse).toBeDefined()
    expect(await queuedUse).toBe("usable")
    expect(harness.events.indexOf("runtime.stop")).toBeLessThan(harness.events.indexOf("lease.release"))
    expect(harness.events.indexOf("lease.release")).toBeLessThan(harness.events.indexOf("runtime.start"))
    expect(harness.events.indexOf("runtime.start")).toBeLessThan(harness.events.indexOf("runtime.user.use"))
    expect(harness.values.get("containerIdle")).toBeUndefined()
  })

  it("keeps a waiting runtime warm when usage, authority, or encrypted archive proof is unavailable", async () => {
    const harness = makeHarness({ manifest: false })
    const record = harness.seedIntent()
    const outcome = await harness.idleClose.run(harness.payload)
    expect(outcome?.rescheduleAt).toBeGreaterThan(Date.now())
    expect(harness.values.get("containerIdle")).toEqual(record)
    expect(harness.events).not.toContain("runtime.stop")
    expect(harness.events).not.toContain("snapshot.clear")
  })

  it.each([
    ["local hold", { state: { budgetReservation: { reservationID: "r1", dispatched: true } } }],
    ["pending permission", { state: { pending: { permission1: "ses_idle" } } }],
    ["pending checkpoint", { state: { checkpointPending: true } }],
    ["busy local work", { busy: true }],
    ["central hold", { ledgerHolds: 1 }],
    ["authority blocker", { ledgerBlockers: 1 }],
    ["unreadable authority", { ledgerThrows: true }],
    ["failed checkpoint", { manifest: true, checkpointCaptureFails: true }],
  ] as const)("keeps the runtime warm for %s", async (_name, options) => {
    const harness = makeHarness(options)
    const record = harness.seedIntent()
    expect((await harness.idleClose.run(harness.payload))?.rescheduleAt).toBeGreaterThan(Date.now())
    expect(harness.values.get("containerIdle")).toEqual(record)
    expect(harness.events).not.toContain("runtime.stop")
  })

  it("keeps the runtime warm when split archive verification fails", async () => {
    const harness = makeHarness({ manifest: true, archiveFails: true })
    const record = harness.seedIntent()
    expect((await harness.idleClose.run(harness.payload))?.rescheduleAt).toBeGreaterThan(Date.now())
    expect(harness.values.get("containerIdle")).toEqual(record)
    expect(harness.events).toContain("archive.verify:true")
    expect(harness.events).not.toContain("snapshot.clear")
    expect(harness.events).not.toContain("runtime.stop")
  })

  it("defers close if runtime demand appears during quiescence proof", async () => {
    const harness = makeHarness({ manifest: true, changeActivityDuringProof: true })
    const record = harness.seedIntent()
    const outcome = await harness.idleClose.run(harness.payload)
    expect(outcome?.rescheduleAt).toBeGreaterThan(Date.now())
    expect(harness.values.get("containerIdle")).toEqual(record)
    expect(harness.events).not.toContain("runtime.stop")
  })

  it("retains closing intent after stop failure and finishes on a later wake without replay or checkpoint", async () => {
    const harness = makeHarness({ manifest: true, stopResult: false })
    harness.seedIntent()
    const first = await harness.idleClose.run(harness.payload)
    expect(first?.rescheduleAt).toBeGreaterThan(Date.now())
    expect(harness.values.get("containerIdle")).toMatchObject({ phase: "closing" })
    await expect(harness.idleClose.beforePrepareOwned()).rejects.toThrow("container idle close is pending")
    harness.events.length = 0

    // The second stop now succeeds; the persisted closing record is the owner.
    harness.setStopFails(false)
    const second = await harness.idleClose.run(harness.payload)
    expect(second).toBeUndefined()
    expect(harness.values.get("containerIdle")).toBeUndefined()
    expect(harness.events).not.toContain("usage.replay")
    expect(harness.events).not.toContain("runtime.prove")
    expect(harness.events).not.toContain("checkpoint.capture")
    expect(harness.events).toContain("lease.release")
  })

  it("retains closing intent after an uncertain lease-release acknowledgement", async () => {
    const harness = makeHarness({ manifest: true, releaseResults: [false, true] })
    harness.seedIntent()
    const first = await harness.idleClose.run(harness.payload)
    expect(first?.rescheduleAt).toBeGreaterThan(Date.now())
    expect(harness.values.get("containerIdle")).toMatchObject({ phase: "closing" })
    expect(harness.runtime.confirmedStopped).toBe(true)
    await expect(harness.idleClose.beforePrepareOwned()).rejects.toThrow("container idle close is pending")
    harness.events.length = 0

    expect(await harness.idleClose.run(harness.payload)).toBeUndefined()
    expect(harness.values.get("containerIdle")).toBeUndefined()
    expect(harness.events).not.toContain("runtime.prove")
    expect(harness.events).not.toContain("checkpoint.capture")
    expect(harness.events.filter((event) => event === "lease.release")).toHaveLength(1)
  })

  it("refuses a stale owner without stopping the runtime", async () => {
    const harness = makeHarness({ manifest: true })
    harness.seedIntent()
    expect(await harness.idleClose.run({ idleID: "old-id", runtimeGeneration: "generation-1" })).toBeUndefined()
    expect(harness.events).toEqual([])
    expect(harness.runtime.confirmedStopped).toBe(false)
  })
})
