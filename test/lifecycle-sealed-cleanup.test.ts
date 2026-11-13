import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import type { ConversationLeaseRecord } from "../src/conversation/lease"
import type { ConversationState } from "../src/state"

describe("sealed lifecycle cleanup", () => {
  it("requires explicit idle recovery before reset can release a stopped container lease", async () => {
    const settings = env.SETTINGS.getByName("global")
    await runInDurableObject(settings, async (_instance, runtime) => runtime.storage.deleteAll())
    const config = await settings.fetch("https://settings/put", {
      method: "POST",
      body: JSON.stringify({ maxContainers: 5 }),
    })
    expect(config.ok).toBe(true)

    const stub = env.CONVERSATION.getByName("C1:sealed-idle-reset")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const id = runtime.id.toString()
      const stoppedContainer = {
        running: false,
        async destroy() { throw new Error("already-stopped container should not be destroyed") },
        async setInactivityTimeout() {},
      }
      Object.defineProperty((instance as unknown as { ctx: object }).ctx, "container", {
        configurable: true,
        value: stoppedContainer,
      })
      const internal = instance as unknown as { leases: { ensureHeld(): Promise<void> } }
      await runtime.storage.put("state", {
        phase: "idle",
        seen: [],
        pending: {},
      } satisfies ConversationState)
      await internal.leases.ensureHeld()
      const beforeLease = await runtime.storage.get<ConversationLeaseRecord>("containerLease")
      const beforeRenewalJob = runtime.storage.sql.exec<{ id: string; time: number }>(
        "SELECT id, time FROM cf_agents_jobs WHERE id = ? AND capability = ?",
        "lease:renew",
        "conversation-jobs",
      ).toArray()[0]
      await runtime.storage.put("lifecycleJobsSealed", true)

      let responseStatus: number | undefined
      let responseBody: string | undefined
      let thrown: string | undefined
      try {
        const response = await instance.fetch(new Request("https://conversation/reset", {
          method: "POST",
          headers: { "x-conversation-key": "C1:sealed-idle-reset" },
        }))
        responseStatus = response.status
        responseBody = await response.text()
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error)
      }

      const inspect = await instance.fetch(new Request("https://conversation/recovery"))
      const recovery = await inspect.json() as { kind: string; snapshotID: string; actions: string[] }
      const retry = await instance.fetch(new Request("https://conversation/recovery", {
        method: "POST", body: JSON.stringify({ action: "retry", expectedSnapshotID: recovery.snapshotID }),
      }))
      const epochAfterRetry = await runtime.storage.get<number>("conversationJobEpoch")
      const sealAfterRetry = await runtime.storage.get<boolean>("lifecycleJobsSealed")
      const reset = await instance.fetch(new Request("https://conversation/reset", { method: "POST" }))
      const leaseAfter = await runtime.storage.get<ConversationLeaseRecord>("containerLease")
      const stateAfter = await runtime.storage.get<ConversationState>("state")
      const sealsAfter = await runtime.storage.get<boolean>("lifecycleJobsSealed")
      return {
        id,
        recovery,
        retryStatus: retry.status,
        resetStatus: reset.status,
        epochAfterRetry,
        sealAfterRetry,
        responseStatus,
        responseBody,
        thrown,
        beforeLease,
        beforeRenewalJob,
        leaseAfter,
        stateAfter,
        sealsAfter,
        renewalJob: runtime.storage.sql.exec<{ id: string; time: number }>(
          "SELECT id, time FROM cf_agents_jobs WHERE id = ? AND capability = ?",
          "lease:renew",
          "conversation-jobs",
        ).toArray()[0],
      }
    })

    const centralLease = await runInDurableObject(settings, async (_instance, runtime) =>
      runtime.storage.get<number>(`lease:${result.id}`),
    )

    expect(result.beforeLease).toMatchObject({ desired: "held", status: "acknowledged" })
    expect(result.responseStatus).toBe(409)
    expect(result.responseBody).toContain("inspect recovery and retry")
    expect(result.thrown).toBeUndefined()
    expect(result.recovery).toMatchObject({ kind: "sealed_idle", actions: ["retry"] })
    expect(result.retryStatus).toBe(202)
    expect(result.epochAfterRetry).toBeGreaterThan(1)
    expect(result.sealAfterRetry).toBeUndefined()
    expect(result.resetStatus).toBe(200)
    expect(result.leaseAfter).toBeUndefined()
    expect(centralLease).toBeUndefined()
    expect(result.sealsAfter).toBeUndefined()
    expect(result.renewalJob).toBeUndefined()
  })

  it("restores only maintenance jobs and rolls back the seal and epoch if publication fails", async () => {
    const stub = env.CONVERSATION.getByName("C1:sealed-pending-checkpoint")
    await runInDurableObject(stub, async (instance, runtime) => {
      await instance.fetch(new Request("https://conversation/health"))
      const retryAt = Date.now() + 60_000
      await runtime.storage.put("state", { phase: "idle", checkpointPending: true, checkpointRetryAt: retryAt, seen: [], pending: {} })
      await runtime.storage.put("containerIdle", { version: 1, id: "idle-pending", generation: "generation-old", dueAt: retryAt, phase: "waiting" })
      await runtime.storage.put("lifecycleJobsSealed", true)
      const inspect = async () => (await (await instance.fetch(new Request("https://conversation/recovery"))).json()) as { snapshotID: string; kind: string }
      const retry = async (snapshotID: string) => instance.fetch(new Request("https://conversation/recovery", {
        method: "POST", body: JSON.stringify({ action: "retry", expectedSnapshotID: snapshotID }),
      }))
      const before = await inspect()
      expect(before.kind).toBe("sealed_idle")
      const epoch = await runtime.storage.get<number>("conversationJobEpoch")
      const internal = instance as unknown as { scheduler: { capability: { schedule(...args: unknown[]): Promise<void> } } }
      const capability = internal.scheduler.capability
      const original = capability.schedule.bind(capability)
      capability.schedule = async () => { throw new Error("injected queue publication failure") }
      expect((await retry(before.snapshotID)).status).toBe(503)
      capability.schedule = original
      expect(await runtime.storage.get("lifecycleJobsSealed")).toBe(true)
      expect(await runtime.storage.get("conversationJobEpoch")).toBe(epoch)
      expect((await inspect()).snapshotID).toBe(before.snapshotID)
      expect((await retry(before.snapshotID)).status).toBe(202)
      expect(await runtime.storage.get("lifecycleJobsSealed")).toBeUndefined()
      const rows = runtime.storage.sql.exec<{ id: string; time: number }>(
        "SELECT id, time FROM cf_agents_jobs WHERE capability = ?", "conversation-jobs",
      ).toArray()
      expect(rows.slice().sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: "checkpoint:retry", time: retryAt }, { id: "container:idle", time: retryAt },
      ])
      expect((await runtime.storage.get<ConversationState>("state"))?.checkpointPending).toBe(true)
    })
  })

  it("rejects an operator snapshot after the epoch or maintenance evidence changes", async () => {
    const stub = env.CONVERSATION.getByName("C1:sealed-stale-evidence")
    await runInDurableObject(stub, async (instance, runtime) => {
      await instance.fetch(new Request("https://conversation/health"))
      await runtime.storage.put("state", { phase: "idle", seen: [], pending: {} })
      await runtime.storage.put("lifecycleJobsSealed", true)
      const snapshot = await (await instance.fetch(new Request("https://conversation/recovery"))).json() as { snapshotID: string }
      await runtime.storage.put("conversationJobClaims", { "turn:observe": { epoch: 1, claimID: "new-live-owner", until: Date.now() + 60_000 } })
      const response = await instance.fetch(new Request("https://conversation/recovery", {
        method: "POST", body: JSON.stringify({ action: "retry", expectedSnapshotID: snapshot.snapshotID }),
      }))
      expect(response.status).toBe(409)
      expect(await runtime.storage.get("lifecycleJobsSealed")).toBe(true)
    })
  })


  it("uses the durable epoch rather than a stale process cache for sealed recovery snapshots", async () => {
    const stub = env.CONVERSATION.getByName("C1:sealed-epoch-cache")
    await runInDurableObject(stub, async (instance, runtime) => {
      await instance.fetch(new Request("https://conversation/health"))
      await runtime.storage.put("state", { phase: "idle", seen: [], pending: {} })
      await runtime.storage.put("lifecycleJobsSealed", true)
      const before = await (await instance.fetch(new Request("https://conversation/recovery"))).json() as { snapshotID: string }
      const epoch = await runtime.storage.get<number>("conversationJobEpoch")
      await runtime.storage.put("conversationJobEpoch", epoch! + 5)
      const stale = await instance.fetch(new Request("https://conversation/recovery", {
        method: "POST", body: JSON.stringify({ action: "retry", expectedSnapshotID: before.snapshotID }),
      }))
      expect(stale.status).toBe(409)
      expect(await runtime.storage.get("conversationJobEpoch")).toBe(epoch! + 5)
      expect(await runtime.storage.get("lifecycleJobsSealed")).toBe(true)
    })
  })

})
