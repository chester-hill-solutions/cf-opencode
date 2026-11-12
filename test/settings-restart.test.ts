import { beforeEach, describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { ACCOUNT_STATE_KEY } from "../src/conversation"
import type { ConversationState } from "../src/state"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"
import { runtimeCache } from "./helpers/runtime-cache"

const settings = () => env.SETTINGS.getByName("global")

async function resetSettings(): Promise<number> {
  await runInDurableObject(settings(), async (_instance, runtime) => runtime.storage.deleteAll())
  const saved = await settings().fetch("https://settings/put", {
    method: "POST", body: JSON.stringify({ streaming: false, dailyBudgetUSD: 0 }),
  })
  expect(saved.ok).toBe(true)
  const current = await (await settings().fetch("https://settings/get")).json() as { version: number }
  await env.CHECKPOINTS.delete(ACCOUNT_STATE_KEY)
  await env.CHECKPOINTS.put(ACCOUNT_STATE_KEY, new Uint8Array([7, 8, 9]), {
    customMetadata: { encrypted: "1" },
  })
  return current.version
}

function installContainer(
  instance: unknown,
  calls: string[],
  options: {
    checkpointFails?: boolean
    splitCheckpoint?: boolean
    stateCheckpoint?: { entered(): void; wait: Promise<void> }
  } = {},
  restorePayloads: Array<{ path: string; bytes: number[] }> = [],
) {
  const container = {
    running: true,
    async setInactivityTimeout() {},
    async destroy() { calls.push("container.destroy"); this.running = false },
    async snapshotContainer() { calls.push("container.snapshot"); return { id: "snapshot", size: 1 } },
  }
  Object.defineProperty((instance as { ctx: object }).ctx, "container", {
    configurable: true, value: container,
  })
  ;(instance as { transport?: unknown }).transport = (port: number) => ({
    async fetch(input: Request | string | URL): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input)
      const url = new URL(request.url)
      calls.push(`${port} ${request.method} ${url.pathname}${url.pathname === "/restore" ? url.search : ""}`)
      if (port === 4001 && url.pathname === "/status") return Response.json({ initialized: container.running })
      if (port === 4001 && url.pathname === "/configure") return Response.json({ ok: true })
      if (port === 4001 && url.pathname === "/start") return Response.json(accountingPolicyStart)
      if (port === 4001 && url.pathname === "/checkpoint") {
        if (options.checkpointFails) return Response.json({ error: "archive unavailable" }, { status: 503 })
        if (options.splitCheckpoint && url.searchParams.get("part") === "state") {
          return new Response(new Uint8Array([9, 4, 2]), {
            headers: {
              "content-type": "application/gzip", "content-length": "3",
              "x-state-fingerprint": "fresh-state-fingerprint", "x-aboiteau-checkpoint": "split",
            },
          })
        }
        if (options.splitCheckpoint) {
          return new Response(new Uint8Array([31, 139, 8]), {
            headers: {
              "content-type": "application/gzip", "content-length": "3",
              "x-workspace-fingerprint": "fresh-workspace-fingerprint",
              "x-aboiteau-checkpoint": "split",
            },
          })
        }
        return new Response(new Uint8Array([31, 139, 8]), {
          headers: {
            "content-type": "application/gzip",
            "content-length": "3",
            "x-workspace-fingerprint": "fresh-workspace-fingerprint",
          },
        })
      }
      if (port === 4001 && url.pathname === "/state-checkpoint" && options.stateCheckpoint) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([4, 5, 6]))
            options.stateCheckpoint!.entered()
            void options.stateCheckpoint!.wait.then(() => controller.close())
          },
        }), {
          headers: { "content-type": "application/gzip", "content-length": "3" },
        })
      }
      if (port === 4001 && url.pathname === "/restore") {
        restorePayloads.push({ path: url.pathname + url.search, bytes: [...new Uint8Array(await request.arrayBuffer())] })
        return Response.json({ ok: true })
      }
      if (port === 4000 && url.pathname === "/api/config") return Response.json(accountingPolicyConfig)
      return Response.json({ error: "not found" }, { status: 404 })
    },
  })
  return container
}

async function seedConversation(
  stub: ReturnType<typeof env.CONVERSATION.getByName>,
  settingsVersion: number,
  patch: Partial<ConversationState> = {},
) {
  await runInDurableObject(stub, async (_instance, runtime) => {
    await runtime.storage.deleteAll()
    await runtime.storage.put("state", {
      phase: "idle", sessionID: "ses_existing", settingsVersion: settingsVersion - 1,
      modelOverride: "opencode/model", turnBaseline: "assistant-old", seen: [], pending: {},
      ...patch,
    } satisfies ConversationState)
    await runtime.storage.put("usage-source:preserve", { id: "source-1", amount: 3 })
    await runtime.storage.put("snapshot", { id: "old-image", size: 44 })
  })
}

describe("settings-driven container restart", () => {
  beforeEach(async () => { await resetSettings() })

  it("checkpoints connected state before destroy and preserves the encrypted account seed", async () => {
    const version = await resetSettings()
    const stub = env.CONVERSATION.getByName("settings-restart-checkpoint-first")
    await seedConversation(stub, version)
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const calls: string[] = []
      const container = installContainer(instance, calls)
      const internal = instance as unknown as {
        doEnsureReady(): Promise<unknown>
      }
      const cache = runtimeCache(instance)
      cache.markVerified({ fetch: async () => new Response(null) }, "old-generation", true)
      cache.applyInactivity(container)
      await internal.doEnsureReady()
      const state = await runtime.storage.get<ConversationState>("state")
      if (!state) throw new Error("state missing after settings restart")
      return {
        calls,
        state,
        source: await runtime.storage.get("usage-source:preserve"),
        snapshot: await runtime.storage.get("snapshot"),
        containerRunning: container.running,
        ready: cache.ready,
        generation: cache.generation,
        inactivitySet: cache.inactivitySet,
      }
    })
    const checkpoint = result.calls.findIndex((call) => call === "4001 GET /checkpoint")
    const destroy = result.calls.indexOf("container.destroy")

    expect(checkpoint).toBeGreaterThanOrEqual(0)
    expect(destroy).toBeGreaterThan(checkpoint)
    expect(result.calls).not.toContain("container.snapshot")
    expect(result.state).toMatchObject({
      sessionID: "ses_existing", modelOverride: "opencode/model", turnBaseline: "assistant-old",
    })
    expect(result.source).toEqual({ id: "source-1", amount: 3 })
    expect(result.snapshot).toBeUndefined()
    expect(result.containerRunning).toBe(false)
    expect(result.ready).toBe(true)
    expect(result.generation).toBe(accountingPolicyStart.opencodeGeneration)
    expect(result.inactivitySet).toBe(false)
    const accountSeed = await env.CHECKPOINTS.get(ACCOUNT_STATE_KEY)
    expect(accountSeed?.customMetadata).toMatchObject({ encrypted: "1" })
  })

  it("keeps the running container and old snapshot if the fresh checkpoint fails", async () => {
    const version = await resetSettings()
    const stub = env.CONVERSATION.getByName("settings-restart-checkpoint-failure")
    await seedConversation(stub, version)
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const calls: string[] = []
      const container = installContainer(instance, calls, { checkpointFails: true })
      const internal = instance as unknown as { doEnsureReady(): Promise<unknown> }
      let error = ""
      try { await internal.doEnsureReady() } catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
      return {
        calls, error, containerRunning: container.running,
        snapshot: await runtime.storage.get("snapshot"),
      }
    })
    expect(result.error).toContain("checkpoint failed")
    expect(result.calls.some((call) => call === "4001 GET /checkpoint")).toBe(true)
    expect(result.calls).not.toContain("container.destroy")
    expect(result.containerRunning).toBe(true)
    expect(result.snapshot).toEqual({ id: "old-image", size: 44 })
  })

  it("defers a settings restart while a dispatched reservation is held", async () => {
    const version = await resetSettings()
    const stub = env.CONVERSATION.getByName("settings-restart-held-reservation")
    await seedConversation(stub, version, {
      budgetReservation: { reservationID: "hold-1", date: new Date().toISOString().slice(0, 10), dispatched: true },
    })
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const calls: string[] = []
      const container = installContainer(instance, calls)
      const internal = instance as unknown as {
        doEnsureReady(): Promise<unknown>
      }
      runtimeCache(instance).markVerified({ fetch: async () => new Response(null) }, "current-generation", true)
      await internal.doEnsureReady()
      return {
        calls, containerRunning: container.running,
        snapshot: await runtime.storage.get("snapshot"),
        state: await runtime.storage.get<ConversationState>("state"),
      }
    })
    expect(result.calls).toEqual([])
    expect(result.containerRunning).toBe(true)
    expect(result.snapshot).toEqual({ id: "old-image", size: 44 })
    expect(result.state?.budgetReservation).toMatchObject({ reservationID: "hold-1", dispatched: true })
  })

  it("restores split workspace and provider state archives before configure and start", async () => {
    const version = await resetSettings()
    const stub = env.CONVERSATION.getByName("settings-restart-restores-split-state")
    await seedConversation(stub, version)
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const calls: string[] = []
      const restores: Array<{ path: string; bytes: number[] }> = []
      installContainer(instance, calls, { splitCheckpoint: true }, restores)
      const internal = instance as unknown as { doEnsureReady(): Promise<unknown> }
      await internal.doEnsureReady()
      const state = await runtime.storage.get<ConversationState>("state")
      if (!state) throw new Error("conversation state missing after split restore")
      return { calls, restores, state }
    })
    const checkpoint = result.calls.indexOf("4001 GET /checkpoint")
    const workspaceRestore = result.calls.indexOf("4001 POST /restore?part=workspace")
    const stateRestore = result.calls.indexOf("4001 POST /restore?part=state")
    const configure = result.calls.indexOf("4001 POST /configure")
    const start = result.calls.indexOf("4001 POST /start")
    expect(checkpoint).toBeGreaterThanOrEqual(0)
    expect(workspaceRestore).toBeGreaterThan(checkpoint)
    expect(stateRestore).toBeGreaterThan(workspaceRestore)
    expect(configure).toBeGreaterThan(stateRestore)
    expect(start).toBeGreaterThan(configure)
    expect(result.restores).toEqual([
      { path: "/restore?part=workspace", bytes: [31, 139, 8] },
      { path: "/restore?part=state", bytes: [9, 4, 2] },
    ])
    expect(result.state).toMatchObject({
      sessionID: "ses_existing", checkpointManifest: {
        workspace: { encrypted: true }, state: { encrypted: true },
      },
    })
  })

  it("keeps the source runtime alive until an in-flight onboarding request finishes", async () => {
    const version = await resetSettings()
    const stub = env.CONVERSATION.getByName("settings-restart-onboarding-race")
    await seedConversation(stub, version)
    const result = await runInDurableObject(stub, async (instance) => {
      const calls: string[] = []
      const container = installContainer(instance, calls)
      let releaseModel!: () => void
      let modelEntered!: () => void
      const modelGate = new Promise<void>((resolve) => { releaseModel = resolve })
      const entered = new Promise<void>((resolve) => { modelEntered = resolve })
      const previous = instance.transport!
      instance.transport = (port) => {
        const base = previous(port)
        return {
          async fetch(input: Request | string | URL): Promise<Response> {
            const request = input instanceof Request ? input : new Request(input)
            const url = new URL(request.url)
            if (port === 4000 && url.pathname === "/api/model") {
              modelEntered()
              await modelGate
              calls.push("4000 GET /api/model")
              return Response.json({ data: [] })
            }
            return base.fetch(input)
          },
        }
      }
      const internal = instance as unknown as {
        doEnsureReady(): Promise<unknown>
      }
      runtimeCache(instance).markVerified(instance.transport!(4000), "live-generation", true)
      const onboarding = instance.fetch(new Request("https://conversation/onboarding/models", {
        headers: { "x-conversation-key": "onboarding" },
      }))
      await entered
      await internal.doEnsureReady()
      const callsWhileOnboarding = [...calls]
      const runningWhileOnboarding = container.running
      releaseModel()
      const response = await onboarding
      const catalogue = await response.json()
      await internal.doEnsureReady()
      return { callsWhileOnboarding, runningWhileOnboarding, calls, catalogue }
    })
    expect(result.callsWhileOnboarding).not.toContain("container.destroy")
    expect(result.runningWhileOnboarding).toBe(true)
    expect(result.catalogue).toEqual({ data: [] })
    expect(result.calls.indexOf("container.destroy")).toBeGreaterThan(result.calls.indexOf("4001 GET /checkpoint"))
  })

  it("holds the restart fence until the onboarding snapshot stream is fully buffered", async () => {
    const version = await resetSettings()
    const stub = env.CONVERSATION.getByName("settings-restart-snapshot-stream")
    await seedConversation(stub, version)
    const result = await runInDurableObject(stub, async (instance) => {
      const calls: string[] = []
      let release!: () => void
      let entered!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const streamEntered = new Promise<void>((resolve) => { entered = resolve })
      const container = installContainer(instance, calls, {
        stateCheckpoint: { entered, wait: gate },
      })
      const internal = instance as unknown as {
        doEnsureReady(): Promise<unknown>
      }
      runtimeCache(instance).markVerified(instance.transport!(4000), "live-generation", true)

      const pending = instance.fetch(new Request("https://conversation/onboarding/state-checkpoint", {
        headers: { "x-conversation-key": "onboarding" },
      }))
      await streamEntered
      await internal.doEnsureReady()
      const callsWhileStreaming = [...calls]
      const runningWhileStreaming = container.running
      release()
      const response = await pending
      const bytes = [...new Uint8Array(await response.arrayBuffer())]
      await internal.doEnsureReady()
      return { callsWhileStreaming, runningWhileStreaming, calls, bytes }
    })

    expect(result.callsWhileStreaming).not.toContain("container.destroy")
    expect(result.callsWhileStreaming).not.toContain("4001 GET /checkpoint")
    expect(result.runningWhileStreaming).toBe(true)
    expect(result.bytes).toEqual([4, 5, 6])
    expect(result.calls.indexOf("container.destroy")).toBeGreaterThan(result.calls.indexOf("4001 GET /checkpoint"))
  })
})
