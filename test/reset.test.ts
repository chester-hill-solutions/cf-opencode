import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"

/**
 * A reset clears the Durable Object, so it must also clear the R2 workspace
 * archives; otherwise the next cold start restores the workspace the operator
 * just reset.
 */

describe("conversation reset", () => {
  it("deletes the conversation's R2 checkpoints", async () => {
    const stub = env.CONVERSATION.getByName("C1:reset")
    const result = await runInDurableObject(stub, async (instance, state) => {
      const id = state.id.toString()
      const prefix = `workspaces/${id}/`
      await env.CHECKPOINTS.put(`${prefix}1.tar.gz`, "one")
      await env.CHECKPOINTS.put(`${prefix}2.tar.gz`, "two")
      await env.CHECKPOINTS.put(`workspaces/${id}.tar.gz`, "legacy")
      await env.CHECKPOINTS.put("workspaces/other/1.tar.gz", "keep")

      const response = await instance.fetch(
        new Request("https://conversation/reset", { method: "POST" }),
      )
      const own = await env.CHECKPOINTS.list({ prefix })
      const legacy = await env.CHECKPOINTS.get(`workspaces/${id}.tar.gz`)
      const other = await env.CHECKPOINTS.get("workspaces/other/1.tar.gz")
      return {
        status: response.status,
        remaining: own.objects.length,
        legacy: Boolean(legacy),
        other: Boolean(other),
      }
    })

    expect(result.status).toBe(200)
    expect(result.remaining).toBe(0)
    expect(result.legacy).toBe(false)
    expect(result.other).toBe(true)
  })

  it("rejects reset and delete without changing an unresolved reservation", async () => {
    const settings = env.SETTINGS.getByName("global")
    await runInDurableObject(settings, async (_instance, state) => { await state.storage.deleteAll() })
    await settings.fetch("https://settings/put", {
      method: "POST",
      body: JSON.stringify({ dailyBudgetUSD: 0 }),
    })
    const stub = env.CONVERSATION.getByName("C1:reset-unresolved")
    const conversationID = await runInDurableObject(stub, async (_instance, state) => state.id.toString())
    const date = new Date().toISOString().slice(0, 10)
    await settings.fetch("https://settings/usage/reserve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationID, reservationID: "owned-ref", costUSD: 0.1 }),
    })
    const archiveKey = `workspaces/${conversationID}/active.tar.gz`
    await env.CHECKPOINTS.put(archiveKey, "active")
    const seededState = {
      phase: "running",
      runStartedAt: Date.now(),
      sessionID: "ses_1",
      seen: [],
      pending: {},
      budgetReservation: { reservationID: "owned-ref", date, dispatched: true },
    }
    await runInDurableObject(stub, async (_instance, state) => state.storage.put("state", seededState))

    const result = await runInDurableObject(stub, async (instance) => {
      const reset = await instance.fetch(new Request("https://conversation/reset", { method: "POST" }))
      const remove = await instance.fetch(new Request("https://conversation/delete", { method: "DELETE" }))
      const state = await (await instance.fetch(new Request("https://conversation/state"))).json() as Record<string, unknown>
      const archive = await env.CHECKPOINTS.get(archiveKey)
      return {
        resetStatus: reset.status,
        deleteStatus: remove.status,
        state,
        archiveExists: Boolean(archive),
      }
    })
    const usage = await (await settings.fetch("https://settings/usage/today")).json() as { reservedUSD?: number }

    expect(result.resetStatus).toBe(409)
    expect(result.deleteStatus).toBe(409)
    expect(result.state).toMatchObject(seededState)
    expect(result.archiveExists).toBe(true)
    expect(usage.reservedUSD).toBe(0.1)
  })

  it("rejects delete for an active legacy run phase without a reservation field", async () => {
    const stub = env.CONVERSATION.getByName("C1:delete-active-legacy")
    const id = await runInDurableObject(stub, async (_instance, state) => state.id.toString())
    const archiveKey = `workspaces/${id}/active-legacy.tar.gz`
    await env.CHECKPOINTS.put(archiveKey, "active")
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("state", { phase: "settling", sessionID: "ses_1", seen: [], pending: {} })
    })

    const result = await runInDurableObject(stub, async (instance) => {
      const response = await instance.fetch(new Request("https://conversation/delete", { method: "DELETE" }))
      const state = await (await instance.fetch(new Request("https://conversation/state"))).json() as Record<string, unknown>
      return { status: response.status, state, archiveExists: Boolean(await env.CHECKPOINTS.get(archiveKey)) }
    })

    expect(result.status).toBe(409)
    expect(result.state.phase).toBe("settling")
    expect(result.archiveExists).toBe(true)
  })

  it.each(["reset", "delete"] as const)("serializes %s cleanup against a new admission", async (action) => {
    const settings = env.SETTINGS.getByName("global")
    await runInDurableObject(settings, async (_instance, state) => { await state.storage.deleteAll() })
    await settings.fetch("https://settings/put", {
      method: "POST",
      body: JSON.stringify({ dailyBudgetUSD: 0, streaming: false }),
    })
    const stub = env.CONVERSATION.getByName(`C1:serialized-${action}`)
    const result = await runInDurableObject(stub, async (instance) => {
      const counters = { prompts: 0 }
      instance.transport = (port) => ({
        async fetch(input: Request | string | URL): Promise<Response> {
          const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
          const json = (body: unknown, status = 200) =>
            new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
          if (port === 4001) {
            if (url.pathname === "/status") return json({ initialized: true })
            if (url.pathname === "/configure") return json({ ok: true })

            if (url.pathname === "/start") return json(accountingPolicyStart)
            if (url.pathname === "/checkpoint") return new Response(null, { status: 204 })
          }
          if (url.pathname === "/api/config") return json(accountingPolicyConfig)
          if (url.pathname === "/api/session") return json({ data: { id: "ses_1" } })
          if (url.pathname === "/api/session/ses_1/model") return new Response(null, { status: 204 })
          if (url.pathname === "/api/session/ses_1/prompt") {
            counters.prompts++
            return json({ data: {} })
          }
          if (url.pathname === "/api/session/ses_1/context") return json({ data: [] })
          if (url.pathname === "/api/session/ses_1/permission") return json({ data: [] })
          return json({ error: "not found" }, 404)
        },
      })

      let enterCleanup!: () => void
      let finishCleanup!: () => void
      const cleanupEntered = new Promise<void>((resolve) => { enterCleanup = resolve })
      const cleanupGate = new Promise<void>((resolve) => { finishCleanup = resolve })
      const lifecycle = instance as unknown as { checkpoints: { deleteAll(): Promise<void> } }
      const originalCleanup = lifecycle.checkpoints.deleteAll.bind(lifecycle.checkpoints)
      lifecycle.checkpoints.deleteAll = async () => {
        enterCleanup()
        await cleanupGate
        await originalCleanup()
      }

      const cleanup = instance.fetch(new Request(
        action === "reset" ? "https://conversation/reset" : "https://conversation/delete",
        { method: action === "reset" ? "POST" : "DELETE" },
      ))
      await cleanupEntered
      let messageFinished = false
      const message = instance.fetch(
        new Request("https://conversation/message", {
          method: "POST",
          body: JSON.stringify({ text: "hello" }),
        }),
      ).then((response) => {
        messageFinished = true
        return response
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      const pendingBeforeCleanup = !messageFinished
      const promptsBeforeCleanup = counters.prompts
      finishCleanup()
      const cleanupResponse = await cleanup
      const messageResponse = await message
      return {
        cleanupStatus: cleanupResponse.status,
        messageStatus: messageResponse.status,
        pendingBeforeCleanup,
        promptsBeforeCleanup,
        promptsAfterCleanup: counters.prompts,
      }
    })
    const usage = await (await settings.fetch("https://settings/usage/today")).json() as {
      reservedUSD?: number
    }

    expect(result.cleanupStatus).toBe(200)
    expect(result.pendingBeforeCleanup).toBe(true)
    expect(result.promptsBeforeCleanup).toBe(0)
    expect(result.messageStatus).toBe(200)
    expect(result.promptsAfterCleanup).toBe(1)
    expect(usage.reservedUSD).toBe(0.1)
  })
})

describe("conversation recycle", () => {
  it("refuses to recycle when the checkpoint fails", async () => {
    const stub = env.CONVERSATION.getByName("C1:recycle-checkpoint")
    const result = await runInDurableObject(stub, async (instance) => {
      ;(instance as unknown as { checkpoints: { capture(): Promise<boolean> } }).checkpoints.capture = async () => false
      const response = await instance.fetch(
        new Request("https://conversation/recycle", { method: "POST" }),
      )
      return { status: response.status, body: (await response.json()) as Record<string, unknown> }
    })

    expect(result.status).toBe(503)
    expect(result.body).toMatchObject({ ok: false })
  })
})
