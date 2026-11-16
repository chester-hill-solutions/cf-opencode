import { describe, expect, it } from "vitest"
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test"

describe("Agents Lifecycle SQLite integration", () => {
  it("forwards named fetch and alarm startup through Lifecycle", async () => {
    const stub = env.LIFECYCLE_PROBE.getByName("lc0:forwarding")
    await runInDurableObject(stub, async (instance) => instance.alarm())

    const response = await stub.fetch("https://probe/ping")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ name: "lc0:forwarding", started: true })
    const snapshot = await (await stub.fetch("https://probe/snapshot")).json() as { starts: number; alarms: number }
    expect(snapshot.starts).toBe(1)
    expect(snapshot.alarms).toBe(1)
  })

  it("rolls back KV, SQL job insertion, and physical alarm in the same transaction", async () => {
    const stub = env.LIFECYCLE_PROBE.getByName("lc0:atomic-rollback")
    const response = await stub.fetch("https://probe/atomic-fail")
    expect(response.status).toBe(200)
    const state = await response.json() as {
      marker: string | null
      jobs: unknown[]
      alarm: number | null
      ran: unknown
    }
    expect(state.marker).toBeNull()
    expect(state.jobs).toEqual([])
    expect(state.alarm).toBeNull()
    expect(state.ran).toBeNull()
  })

  it("commits marker and SDK job together and runs the job after a lifecycle wake", async () => {
    const stub = env.LIFECYCLE_PROBE.getByName("lc0:atomic-commit")
    const inserted = await (await stub.fetch("https://probe/atomic-commit")).json() as {
      marker: string | null
      jobs: { id: string; fn: string; time: number; payload: string | null }[]
      alarm: number | null
    }
    expect(inserted.marker).toBe("committed")
    expect(inserted.jobs).toHaveLength(1)
    expect(inserted.jobs[0]).toMatchObject({ id: "probe:atomic-job", fn: "record" })
    expect(inserted.alarm).not.toBeNull()

    const after = await (await stub.fetch("https://probe/drive")).json() as {
      ran: { id: string; value: string; marker: string } | null
      jobs: unknown[]
    }
    expect(after.ran).toEqual({ id: "probe:atomic-job", value: "from-transaction", marker: "committed" })
    expect(after.jobs).toEqual([])
  })

  it("rehydrates a committed named job and marker after explicit DO eviction", async () => {
    const stub = env.LIFECYCLE_PROBE.getByName("lc0:eviction")
    const before = await (await stub.fetch("https://probe/atomic-future")).json() as {
      marker: string | null
      jobs: { id: string }[]
      starts: number
    }
    expect(before.marker).toBe("committed")
    expect(before.jobs.map((job) => job.id)).toEqual(["probe:atomic-job"])
    expect(before.starts).toBe(1)

    await evictDurableObject(stub)
    const restored = await (await stub.fetch("https://probe/snapshot")).json() as {
      marker: string | null
      jobs: { id: string }[]
      starts: number
    }
    expect(restored.marker).toBe("committed")
    expect(restored.jobs.map((job) => job.id)).toEqual(["probe:atomic-job"])
    expect(restored.starts).toBe(2)

    await stub.fetch("https://probe/drive-due")
    await stub.fetch("https://probe/drive")
    const settled = await (await stub.fetch("https://probe/snapshot")).json() as {
      runs: number
      jobs: unknown[]
    }
    expect(settled.runs).toBe(1)
    expect(settled.jobs).toEqual([])
  })

  it("coalesces stable IDs, honors nearest deadlines, and cancels only its own intent", async () => {
    const stub = env.LIFECYCLE_PROBE.getByName("lc0:deadlines")
    const start = Date.now()
    const push = async (id: string, time: number, value: string) => stub.fetch("https://probe/jobs", {
      method: "POST",
      body: JSON.stringify({ id, time, payload: { value } }),
    })
    await push("probe:later", start + 20_000, "later")
    await push("probe:earlier", start + 10_000, "earlier")
    await push("probe:later", start + 30_000, "replacement")
    let snapshot = await (await stub.fetch("https://probe/snapshot")).json() as {
      jobs: { id: string; time: number; payload: string | null }[]
      alarm: number | null
    }
    expect(snapshot.jobs).toHaveLength(2)
    expect(snapshot.alarm).toBe(start + 10_000)
    expect(JSON.parse(snapshot.jobs.find((job) => job.id === "probe:later")!.payload!).value).toBe("replacement")

    await stub.fetch("https://probe/cancel?id=probe:earlier")
    snapshot = await (await stub.fetch("https://probe/snapshot")).json()
    expect(snapshot.jobs).toHaveLength(1)
    expect(snapshot.jobs[0].id).toBe("probe:later")
    expect(snapshot.alarm).toBe(start + 30_000)
    await stub.fetch("https://probe/cancel?id=probe:later")
    expect((await (await stub.fetch("https://probe/snapshot")).json() as { alarm: number | null }).alarm).toBeNull()
  })

  it("discards an older same-ID drive result after a newer push", async () => {
    const stub = env.LIFECYCLE_PROBE.getByName("lc0:same-id-overlap")
    await stub.fetch("https://probe/jobs", {
      method: "POST",
      body: JSON.stringify({ id: "probe:overlap", time: Date.now(), payload: { value: "old", wait: true, outcomeAt: Date.now() + 2_000 } }),
    })
    const firstDrive = stub.fetch("https://probe/drive")
    let entered = false
    for (let i = 0; i < 30 && !entered; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      entered = Boolean((await (await stub.fetch("https://probe/snapshot")).json() as { entered: boolean | null }).entered)
    }
    expect(entered).toBe(true)

    const newerTime = Date.now() + 60_000
    await stub.fetch("https://probe/jobs", {
      method: "POST",
      body: JSON.stringify({ id: "probe:overlap", time: newerTime, payload: { value: "new" } }),
    })
    await stub.fetch("https://probe/release")
    await firstDrive
    const snapshot = await (await stub.fetch("https://probe/snapshot")).json() as {
      jobs: { id: string; time: number; payload: string | null }[]
    }
    expect(snapshot.jobs).toHaveLength(1)
    expect(snapshot.jobs[0].id).toBe("probe:overlap")
    expect(snapshot.jobs[0].time).toBe(newerTime)
    expect(JSON.parse(snapshot.jobs[0].payload!).value).toBe("new")
  })

  it("keeps a terminal capability failure as a visible blocked intent", async () => {
    const stub = env.LIFECYCLE_PROBE.getByName("lc0:terminal-error")
    await stub.fetch("https://probe/terminal")
    const snapshot = await (await stub.fetch("https://probe/drive")).json() as {
      jobs: { id: string; capability: string; time: number }[]
      terminalBlocked: { id: string; message: string } | null
    }
    expect(snapshot.terminalBlocked).toEqual({
      id: "probe:terminal",
      message: "intentional terminal application failure",
    })
    expect(snapshot.jobs).toHaveLength(1)
    expect(snapshot.jobs[0]).toMatchObject({ id: "probe:terminal", capability: "lc0-terminal-probe" })
    expect(snapshot.jobs[0].time).toBeGreaterThan(Date.now())
  })

  it("resets application KV without deleting SDK schema and fences a stale completion", async () => {
    const stub = env.LIFECYCLE_PROBE.getByName("lc0:reset-reuse")
    await stub.fetch("https://probe/jobs", {
      method: "POST",
      body: JSON.stringify({ id: "probe:stale", time: Date.now(), payload: { value: "old", wait: true } }),
    })
    const oldDrive = stub.fetch("https://probe/drive")
    let entered = false
    for (let i = 0; i < 30 && !entered; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      entered = Boolean((await (await stub.fetch("https://probe/snapshot")).json() as { entered: boolean | null }).entered)
    }
    expect(entered).toBe(true)
    const before = await (await stub.fetch("https://probe/reset")).json() as { jobs: unknown[]; starts: number }
    expect(before.jobs).toEqual([])
    await stub.fetch("https://probe/release")
    await oldDrive
    const afterOld = await (await stub.fetch("https://probe/snapshot")).json() as { ran: unknown; staleCompletion: boolean | null; jobs: unknown[]; starts: number }
    expect(afterOld.ran).toBeNull()
    expect(afterOld.staleCompletion).toBe(true)
    expect(afterOld.jobs).toEqual([])

    await stub.fetch("https://probe/jobs", {
      method: "POST",
      body: JSON.stringify({ id: "probe:stale", time: Date.now(), payload: { value: "fresh" } }),
    })
    await stub.fetch("https://probe/drive")
    const reused = await (await stub.fetch("https://probe/snapshot")).json() as { ran: { value: string } | null; starts: number }
    expect(reused.ran?.value).toBe("fresh")
    expect(reused.starts).toBe(1)
  })

  it("tests the sealed hook through a test-only seam without claiming an actual OOM", async () => {
    const stub = env.LIFECYCLE_PROBE.getByName("lc0:sealed-hook")
    const result = await (await stub.fetch("https://probe/simulate-sealed-hook")).json() as {
      sealedBlocked: { sealed: boolean } | null
    }
    expect(result.sealedBlocked).toEqual({ sealed: true, executingJob: null })
  })
})
