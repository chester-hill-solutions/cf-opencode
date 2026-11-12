import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import type { ContainerStartupOptions } from "@cloudflare/workers-types"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"
import { driveConversationJobs } from "./helpers/conversation-jobs"
import { runtimeCache } from "./helpers/runtime-cache"

const BASE_IMAGE = "registry.cloudflare.com/test/conversation-base@sha256:base"
const EVENTED_IMAGE = "registry.cloudflare.com/test/conversation-evented@sha256:evented"

type Internal = {
  env: { EVENTED_FRESH_CONVERSATIONS?: string; SLACK_BOT_TOKEN?: string }
  key?: string
  controlPlane: { token(): Promise<string> }
  startOptions(): ContainerStartupOptions
  snapshotHandle(): Promise<unknown>
  startContainer(): Promise<boolean>
  startBoundContainer(container: unknown): Promise<boolean>
  doEnsureReady(): Promise<unknown>
  leases: { ensureHeld(): Promise<void> }
}

function installContainer(instance: unknown, images: Record<string, string>) {
  const starts: ContainerStartupOptions[] = []
  const container = {
    images,
    start(options: ContainerStartupOptions) { starts.push(options) },
    async setInactivityTimeout() {},
  }
  const context = (instance as { ctx: object }).ctx
  Object.defineProperty(context, "container", { configurable: true, value: container })
  return { container, starts }
}

function enableFreshEventedRouting(instance: unknown): () => void {
  const environment = (instance as unknown as { env: Internal["env"] }).env
  const previous = environment.EVENTED_FRESH_CONVERSATIONS
  environment.EVENTED_FRESH_CONVERSATIONS = "true"
  return () => { environment.EVENTED_FRESH_CONVERSATIONS = previous }
}

const settings = () => env.SETTINGS.getByName("global")

async function resetSettings(): Promise<void> {
  await runInDurableObject(settings(), async (_instance, runtime) => runtime.storage.deleteAll())
  const response = await settings().fetch("https://settings/put", {
    method: "POST",
    body: JSON.stringify({ streaming: false, dailyBudgetUSD: 0 }),
  })
  if (!response.ok) throw new Error("failed to reset test settings")
}

function installMessagePorts(
  instance: unknown,
  options: { eventPersistence?: boolean; initialized?: boolean } = {},
) {
  const calls: string[] = []
  let initialized = options.initialized ?? false
  let prompts = 0
  let sessionsCreated = 0
  let starts = 0
  const imageStarts: ContainerStartupOptions[] = []
  const container = {
    running: options.initialized ?? false,
    images: { base: BASE_IMAGE, evented: EVENTED_IMAGE },
    start(startOptions: ContainerStartupOptions) {
      calls.push("container.start")
      imageStarts.push(startOptions)
      starts++
      this.running = true
      return startOptions
    },
    async destroy() { this.running = false },
    async setInactivityTimeout() {},
    async snapshotContainer() { return { id: "test-snapshot", size: 1 } },
    getTcpPort(port: number) {
      return {
        async fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
          const request = input instanceof Request ? input : new Request(input, init)
          const url = new URL(request.url)
          calls.push(`${port} ${request.method} ${url.pathname}`)
          if (url.pathname === "/health") return json({ ok: true })
          if (port !== 4001) return json({ error: "unexpected port" }, 404)
          if (url.pathname === "/status") return json({ initialized })
          if (url.pathname === "/configure" || url.pathname === "/seed-state") return json({ ok: true })
          if (url.pathname === "/start") {
            starts++
            initialized = true
            const proof: Record<string, unknown> = { ...accountingPolicyStart }
            if (options.eventPersistence === undefined) delete proof.eventPersistence
            else proof.eventPersistence = options.eventPersistence
            return json({
              ...proof,
            })
          }
          if (url.pathname === "/checkpoint") return new Response(null, { status: 204 })
          if (!url.pathname.startsWith("/opencode/")) return json({ error: "not found" }, 404)
          const apiPath = url.pathname.slice("/opencode".length)
          if (apiPath === "/api/config") return json(accountingPolicyConfig)
          if (apiPath === "/api/model") return json({ data: [
            { providerID: "opencode", id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", enabled: true, type: "chat" },
          ] })
          if (apiPath === "/api/session" && request.method === "POST") {
            sessionsCreated++
            return json({ data: { id: "ses_canary" } })
          }
          if (apiPath === "/api/session/ses_canary/model") return new Response(null, { status: 204 })
          if (apiPath === "/api/session/ses_canary/context") return json({ data: [] })
          if (apiPath === "/api/session/ses_canary/prompt") {
            prompts++
            return json({ data: {} })
          }
          if (apiPath === "/api/session/ses_canary/permission") return json({ data: [] })
          return json({ error: "not found" }, 404)
        },
      }
    },
  }
  const context = (instance as unknown as { ctx: object }).ctx
  Object.defineProperty(context, "container", { configurable: true, value: container })
  const json = (value: unknown, status = 200) => Response.json(value, { status })
  return {
    container,
    calls,
    prompts: () => prompts,
    sessionsCreated: () => sessionsCreated,
    starts: () => starts,
    imageStarts,
  }
}

describe("isolated evented container image selection", () => {
  it("reports the actual binding state separately from runtime readiness", async () => {
    const stub = env.CONVERSATION.getByName("runtime-debug-running-state")
    const result = await runInDurableObject(stub, async (instance) => {
      const internal = instance as unknown as { ctx: object }
      runtimeCache(instance).markVerified({ fetch: async () => new Response(null) }, "verified-generation", true)
      Object.defineProperty(internal.ctx, "container", {
        configurable: true,
        value: { running: false },
      })
      const response = await instance.fetch(new Request("https://conversation/debug"))
      return response.json() as Promise<Record<string, unknown>>
    })

    expect(result).toMatchObject({
      ready: true,
      containerRunning: false,
      runtimeGeneration: "verified-generation",
    })
  })

  beforeEach(async () => {
    env.EVENTED_FRESH_CONVERSATIONS = undefined
    await resetSettings()
  })
  afterEach(() => {
    env.EVENTED_FRESH_CONVERSATIONS = undefined
    vi.unstubAllGlobals()
  })

  it("keeps ordinary held conversation keys on the pinned base image", async () => {
    const stub = env.CONVERSATION.getByName("image-selection-base")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const { starts } = installContainer(instance, { base: BASE_IMAGE, evented: EVENTED_IMAGE })
      await runtime.storage.put("state", {
        sessionID: "ses_existing",
        phase: "idle",
        budgetReservation: { reservationID: "hold-existing", dispatched: true },
        seen: [],
        pending: {},
      })
      const internal = instance as unknown as Internal
      internal.key = "slack-held-conversation"
      await runtime.storage.put("controlToken", "control-token-test")
      await internal.controlPlane.token()
      const context = (instance as unknown as { ctx: { container: unknown } }).ctx
      const usedSnapshot = await internal.startBoundContainer(context.container)
      return {
        starts,
        usedSnapshot,
        imageBinding: await runtime.storage.get("containerImageVariant"),
      }
    })

    expect(result.usedSnapshot).toBe(false)
    expect(result.starts).toHaveLength(1)
    expect(result.starts[0]?.image).toBe(BASE_IMAGE)
    expect(result.starts[0]?.env).toEqual({ CONTROL_TOKEN: "control-token-test" })
    expect(result.imageBinding).toBeUndefined()
  })

  it("selects the evented image only for the exact configured canary key", async () => {
    const stub = env.CONVERSATION.getByName("image-selection-evented")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      installContainer(instance, { base: BASE_IMAGE, evented: EVENTED_IMAGE })
      const internal = instance as unknown as Internal
      internal.key = env.EVENTED_CANARY_KEY
      await runtime.storage.put("controlToken", "control-token-test")
      await internal.controlPlane.token()
      return internal.startOptions()
    })

    expect(result.image).toBe(EVENTED_IMAGE)
    expect(result.env).toEqual({ CONTROL_TOKEN: "control-token-test" })
  })

  it("fails closed when the canary image is missing", async () => {
    const stub = env.CONVERSATION.getByName("image-selection-evented-missing")
    const result = await runInDurableObject(stub, async (instance) => {
      const { container, starts } = installContainer(instance, { base: BASE_IMAGE })
      const internal = instance as unknown as Internal
      internal.key = env.EVENTED_CANARY_KEY
      let error = ""
      try {
        await internal.startBoundContainer(container)
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
      }
      return { starts, error }
    })

    expect(result.error).toBe("evented canary image is not configured")
    expect(result.starts).toEqual([])
  })

  it("fails before startup mutations when the base image is missing", async () => {
    const stub = env.CONVERSATION.getByName("image-selection-base-missing")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const { starts } = installContainer(instance, { evented: EVENTED_IMAGE })
      const internal = instance as unknown as Internal
      let error = ""
      try {
        await internal.startContainer()
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
      }
      return { error, starts, keys: [...(await runtime.storage.list()).keys()].sort() }
    })

    expect(result.error).toBe("base container image is not configured")
    expect(result.starts).toEqual([])
    expect(result.keys).toEqual([])
  })

  it("preserves an existing snapshot when the base image is missing", async () => {
    const stub = env.CONVERSATION.getByName("image-selection-base-missing-snapshot")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const { container, starts } = installContainer(instance, { evented: EVENTED_IMAGE })
      const saved = { id: "base-image-snapshot", size: 17 }
      await runtime.storage.put("snapshot", saved)
      let error = ""
      try {
        await (instance as unknown as Internal).startBoundContainer(container)
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
      }
      return { error, starts, snapshot: await runtime.storage.get("snapshot") }
    })

    expect(result.error).toBe("base container image is not configured")
    expect(result.starts).toEqual([])
    expect(result.snapshot).toEqual({ id: "base-image-snapshot", size: 17 })
  })

  it("rejects a selected existing or held conversation before changing storage", async () => {
    const stub = env.CONVERSATION.getByName("image-selection-existing-hold")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const { starts } = installContainer(instance, { base: BASE_IMAGE, evented: EVENTED_IMAGE })
      await runtime.storage.put("state", {
        sessionID: "ses_existing",
        phase: "idle",
        budgetReservation: { reservationID: "hold-existing", dispatched: true },
        seen: [],
        pending: {},
      })
      const internal = instance as unknown as Internal
      internal.key = env.EVENTED_CANARY_KEY
      let error = ""
      try {
        await internal.startContainer()
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
      }
      return {
        error,
        starts,
        keys: [...(await runtime.storage.list()).keys()].sort(),
        imageBinding: await runtime.storage.get("containerImageVariant"),
      }
    })

    expect(result.error).toContain("fresh conversation")
    expect(result.starts).toEqual([])
    expect(result.keys).toEqual(["state"])
    expect(result.imageBinding).toBeUndefined()
  })

  it("binds the evented image across a cold DO and ignores, but does not delete, a base snapshot", async () => {
    const stub = env.CONVERSATION.getByName("image-selection-evented-snapshot")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const { container, starts } = installContainer(instance, { base: BASE_IMAGE, evented: EVENTED_IMAGE })
      const internal = instance as unknown as Internal
      internal.key = env.EVENTED_CANARY_KEY
      const usedSnapshot = await internal.startBoundContainer(container)
      await runtime.storage.put("snapshot", { id: "base-image-snapshot", size: 17 })
      internal.key = undefined
      runtimeCache(instance).bindImage(undefined)
      const coldStartUsedSnapshot = await internal.startBoundContainer(container)
      return {
        starts,
        usedSnapshot,
        coldStartUsedSnapshot,
        savedSnapshot: await runtime.storage.get("snapshot"),
        imageBinding: await runtime.storage.get("containerImageVariant"),
      }
    })

    expect(result.usedSnapshot).toBe(false)
    expect(result.coldStartUsedSnapshot).toBe(false)
    expect(result.starts).toHaveLength(2)
    expect(result.starts[0]).toMatchObject({ image: EVENTED_IMAGE })
    expect(result.starts[1]).toMatchObject({ image: EVENTED_IMAGE })
    expect(result.starts[0]?.containerSnapshot).toBeUndefined()
    expect(result.imageBinding).toBe("evented")
    expect(result.savedSnapshot).toEqual({ id: "base-image-snapshot", size: 17 })
  })

  it("keeps using a saved snapshot for a non-canary conversation", async () => {
    const stub = env.CONVERSATION.getByName("image-selection-base-snapshot")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const { container, starts } = installContainer(instance, { base: BASE_IMAGE, evented: EVENTED_IMAGE })
      await runtime.storage.put("snapshot", { id: "base-image-snapshot", size: 17 })
      const internal = instance as unknown as Internal
      internal.key = "another-existing-conversation"
      const usedSnapshot = await internal.startBoundContainer(container)
      return { starts, usedSnapshot, imageBinding: await runtime.storage.get("containerImageVariant") }
    })

    expect(result.usedSnapshot).toBe(true)
    expect(result.starts).toHaveLength(1)
    expect(result.starts[0]?.image).toBeUndefined()
    expect(result.starts[0]?.containerSnapshot).toEqual({ id: "base-image-snapshot", size: 17 })
    expect(result.imageBinding).toBeUndefined()
  })

  it("allows the real first HTTP admission state and prompts once through the evented image", async () => {
    const stub = env.CONVERSATION.getByName("image-selection-first-message")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const fake = installMessagePorts(instance, { eventPersistence: true })
      const response = await instance.fetch(new Request("https://conversation/message", {
        method: "POST",
        headers: { "x-conversation-key": env.EVENTED_CANARY_KEY ?? "" },
        body: JSON.stringify({ text: "hello", idempotencyKey: "first-canary-message" }),
      }))
      return {
        status: response.status,
        body: await response.json(),
        calls: fake.calls,
        prompts: fake.prompts(),
        imageStarts: fake.imageStarts,
        imageBinding: await runtime.storage.get("containerImageVariant"),
        state: await runtime.storage.get<Record<string, unknown>>("state"),
      }
    })

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok: true, sessionID: "ses_canary" })
    expect(result.calls).toContain("container.start")
    expect(result.imageStarts[0]?.image).toBe(EVENTED_IMAGE)
    expect(result.calls).toContain("4001 POST /start")
    expect(result.calls).toContain("4001 POST /opencode/api/session/ses_canary/prompt")
    expect(result.prompts).toBe(1)
    expect(result.imageBinding).toBe("evented")
    expect(result.state).toMatchObject({
      sessionID: "ses_canary",
      phase: "running",
      budgetReservation: { dispatched: true },
    })
  })

  it("routes an ordinary proven-fresh conversation to evented only with the opt-in", async () => {
    const stub = env.CONVERSATION.getByName("image-selection-fresh-opt-in")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const restore = enableFreshEventedRouting(instance)
      try {
        const fake = installMessagePorts(instance, { eventPersistence: true })
        const response = await instance.fetch(new Request("https://conversation/message", {
          method: "POST",
          headers: { "x-conversation-key": "ordinary-fresh-opt-in" },
          body: JSON.stringify({ text: "hello" }),
        }))
        return {
          status: response.status,
          prompts: fake.prompts(),
          image: fake.imageStarts[0]?.image,
          binding: await runtime.storage.get("containerImageVariant"),
        }
      } finally {
        restore()
      }
    })

    expect(result.status).toBe(200)
    expect(result.prompts).toBe(1)
    expect(result.image).toBe(EVENTED_IMAGE)
    expect(result.binding).toBe("evented")
  })

  it("fails before durable writes when fresh routing is enabled without its image", async () => {
    const stub = env.CONVERSATION.getByName("image-selection-fresh-missing-image")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const restore = enableFreshEventedRouting(instance)
      try {
        const { starts } = installContainer(instance, { base: BASE_IMAGE })
        const internal = instance as unknown as Internal
        internal.key = "ordinary-fresh-missing-image"
        let error = ""
        try {
          await internal.startContainer()
        } catch (cause) {
          error = cause instanceof Error ? cause.message : String(cause)
        }
        return { error, starts, keys: [...(await runtime.storage.list()).keys()].sort() }
      } finally {
        restore()
      }
    })

    expect(result.error).toBe("evented canary image is not configured")
    expect(result.starts).toEqual([])
    expect(result.keys).toEqual([])
  })

  it.each([
    ["control token", "controlToken"],
    ["existing session", "session"],
    ["unresolved hold", "hold"],
    ["saved snapshot", "snapshot"],
  ] as const)("keeps a fresh-routing candidate on base when it has %s", async (_label, evidence) => {
    const stub = env.CONVERSATION.getByName(`image-selection-fresh-existing-${evidence}`)
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const restore = enableFreshEventedRouting(instance)
      try {
        const { container, starts } = installContainer(instance, { base: BASE_IMAGE, evented: EVENTED_IMAGE })
        if (evidence === "controlToken") await runtime.storage.put("controlToken", "legacy-token")
        if (evidence === "session") await runtime.storage.put("state", {
          sessionID: "ses_existing", phase: "idle", seen: [], pending: {},
        })
        if (evidence === "hold") await runtime.storage.put("state", {
          phase: "idle", budgetReservation: { reservationID: "hold-existing", dispatched: true }, seen: [], pending: {},
        })
        if (evidence === "snapshot") await runtime.storage.put("snapshot", { id: "legacy-snapshot", size: 9 })
        const before = await runtime.storage.list()
        await (instance as unknown as Internal).startBoundContainer(container)
        const after = await runtime.storage.list()
        return {
          starts,
          before: [...before.entries()],
          after: [...after.entries()],
          binding: await runtime.storage.get("containerImageVariant"),
        }
      } finally {
        restore()
      }
    })

    expect(result.binding).toBeUndefined()
    expect(result.before).toEqual(result.after)
    expect(result.starts).toHaveLength(1)
    if (evidence === "snapshot") {
      expect(result.starts[0]?.image).toBeUndefined()
      expect(result.starts[0]?.containerSnapshot).toEqual({ id: "legacy-snapshot", size: 9 })
    } else {
      expect(result.starts[0]?.image).toBe(BASE_IMAGE)
    }
  })

  it("allows !new, help tombstones and a pre-prompt model choice on an enabled fresh conversation", async () => {
    const stub = env.CONVERSATION.getByName("image-selection-help-model-prompt")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const restore = enableFreshEventedRouting(instance)
      const internal = instance as unknown as Internal
      const priorSlackToken = internal.env.SLACK_BOT_TOKEN
      internal.env.SLACK_BOT_TOKEN = "xoxb-test"
      vi.stubGlobal("fetch", async () => Response.json({ ok: true }))
      try {
        const fake = installMessagePorts(instance, { eventPersistence: true })
        const command = async (eventID: string, text: string) => instance.fetch(new Request("https://conversation/slack", {
          method: "POST",
          headers: { "x-conversation-key": "ordinary-help-model-prompt" },
          body: JSON.stringify({
            eventID,
            event: { type: "message", channel_type: "im", channel: "D_TEST", ts: eventID, text },
          }),
        }))
        const fresh = await command("new-event-0", "!new")
        const help = await command("help-event-1", "!help")
        const model = await command("model-event-2", "!model opencode/deepseek-v4.1-flash")
        const beforePrompt = await runtime.storage.get<Record<string, unknown>>("state")
        const prompt = await instance.fetch(new Request("https://conversation/message", {
          method: "POST",
          headers: { "x-conversation-key": "ordinary-help-model-prompt" },
          body: JSON.stringify({ text: "hello" }),
        }))
        return {
          helpStatus: help.status,
          freshStatus: fresh.status,
          modelStatus: model.status,
          promptStatus: prompt.status,
          beforePrompt,
          modelOverride: beforePrompt?.modelOverride,
          binding: await runtime.storage.get("containerImageVariant"),
          imageStarts: fake.imageStarts,
          prompts: fake.prompts(),
          state: await runtime.storage.get<Record<string, unknown>>("state"),
          tombstones: [...(await runtime.storage.list()).keys()].filter((key) => key.startsWith("tombstones:")),
        }
      } finally {
        internal.env.SLACK_BOT_TOKEN = priorSlackToken
        restore()
      }
    })

    expect(result.helpStatus).toBe(200)
    expect(result.freshStatus).toBe(200)
    expect(result.modelStatus).toBe(200)
    expect(result.modelOverride).toBe("opencode/deepseek-v4.1-flash")
    expect(result.promptStatus).toBe(200)
    expect(result.binding, JSON.stringify(result.beforePrompt)).toBe("evented")
    expect(result.imageStarts[0]?.image).toBe(EVENTED_IMAGE)
    expect(result.prompts).toBe(1)
    expect(result.state?.budgetReservation).toMatchObject({ dispatched: true })
    expect(result.tombstones.length).toBeGreaterThan(0)
  })

  it("keeps a validated evented binding across capacity denial and a cold queued retry", async () => {
    const stub = env.CONVERSATION.getByName("image-selection-capacity-retry")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const fake = installMessagePorts(instance, { eventPersistence: true })
      const internal = instance as unknown as Internal
      let leaseAttempts = 0
      internal.leases.ensureHeld = async () => {
        leaseAttempts++
        if (leaseAttempts === 1) throw new Error("container capacity reached")
      }

      const first = await instance.fetch(new Request("https://conversation/message", {
        method: "POST",
        headers: { "x-conversation-key": env.EVENTED_CANARY_KEY ?? "" },
        body: JSON.stringify({ text: "hello", idempotencyKey: "capacity-retry-message" }),
      }))
      const firstBody = await first.json()
      const firstSessionsCreated = fake.sessionsCreated()
      const firstPrompts = fake.prompts()
      const firstState = await runtime.storage.get<Record<string, unknown>>("state")
      const bindingAfterDenial = await runtime.storage.get("containerImageVariant")

      // Simulate a cold DO before the alarm drains the queued turn. The durable
      // image marker, not the lost request key or startup cache, selects image.
      internal.key = undefined
      runtimeCache(instance).bindImage(undefined)
      runtimeCache(instance).invalidate()
      const state = firstState as Record<string, unknown> & { queued: Record<string, unknown> }
      await runtime.storage.put("state", {
        ...state,
        queued: { ...state.queued, nextAttemptAt: Date.now() - 1 },
      })
      await driveConversationJobs(instance, runtime.storage, ["admission:retry"], { queued: true })

      return {
        firstStatus: first.status,
        firstBody,
        firstSessionsCreated,
        firstPrompts,
        firstState,
        bindingAfterDenial,
        bindingAfterRetry: await runtime.storage.get("containerImageVariant"),
        leaseAttempts,
        prompts: fake.prompts(),
        sessionsCreated: fake.sessionsCreated(),
        imageStarts: fake.imageStarts,
        calls: fake.calls,
        finalState: await runtime.storage.get<Record<string, unknown>>("state"),
      }
    })

    expect(result.firstStatus).toBe(202)
    expect(result.firstBody).toMatchObject({ ok: true, queued: true })
    expect(result.bindingAfterDenial).toBe("evented")
    expect(result.firstState?.budgetReservation).toBeUndefined()
    expect(result.firstSessionsCreated).toBe(0)
    expect(result.firstPrompts).toBe(0)
    expect(result.sessionsCreated).toBe(1)
    expect(result.bindingAfterRetry).toBe("evented")
    expect(result.leaseAttempts).toBeGreaterThanOrEqual(4)
    expect(result.imageStarts).toHaveLength(1)
    expect(result.imageStarts[0]?.image).toBe(EVENTED_IMAGE)
    expect(result.prompts).toBe(1)
    expect(result.calls.filter((call) => call === "4001 POST /opencode/api/session/ses_canary/prompt")).toHaveLength(1)
    expect(result.finalState?.queued).toBeUndefined()
    expect(result.finalState?.budgetReservation).toMatchObject({ dispatched: true })
  })

  it("keeps base-image starts compatible when the control server confirms persistent events", async () => {
    const stub = env.CONVERSATION.getByName("image-selection-base-proof")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const fake = installMessagePorts(instance, { eventPersistence: true })
      const response = await instance.fetch(new Request("https://conversation/message", {
        method: "POST",
        headers: { "x-conversation-key": "ordinary-new-conversation" },
        body: JSON.stringify({ text: "hello" }),
      }))
      return {
        status: response.status,
        calls: fake.calls,
        prompts: fake.prompts(),
        imageStarts: fake.imageStarts,
        binding: await runtime.storage.get("containerImageVariant"),
      }
    })

    expect(result.status).toBe(200)
    expect(result.prompts).toBe(1)
    expect(result.calls).toContain("container.start")
    expect(result.imageStarts[0]?.image).toBe(BASE_IMAGE)
    expect(result.binding).toBeUndefined()
  })

  it.each([
    ["missing", undefined],
    ["false", false],
  ] as const)("blocks a base prompt without persistent-event proof (%s) before reserving", async (label, eventPersistence) => {
    const stub = env.CONVERSATION.getByName(`image-selection-base-disabled-${label}`)
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const fake = installMessagePorts(instance, { eventPersistence })
      const response = await instance.fetch(new Request("https://conversation/message", {
        method: "POST",
        headers: { "x-conversation-key": `ordinary-base-${label}` },
        body: JSON.stringify({ text: "hello" }),
      }))
      return {
        status: response.status,
        body: await response.json(),
        calls: fake.calls,
        prompts: fake.prompts(),
        state: await runtime.storage.get<Record<string, unknown>>("state"),
      }
    })

    expect(result.status).toBe(202)
    expect(result.body).toMatchObject({ ok: true, queued: true })
    expect(result.prompts).toBe(0)
    expect(result.calls).not.toContain("4001 POST /opencode/api/session/ses_canary/prompt")
    expect(result.calls).not.toContain("4001 POST /opencode/api/session")
    expect(result.state?.budgetReservation).toBeUndefined()
  })

  it.each([
    ["missing", undefined],
    ["false", false],
  ] as const)("rejects an evented runtime without persistent-event proof (%s) before prompting", async (label, eventPersistence) => {
    const stub = env.CONVERSATION.getByName(`image-selection-proof-${label}`)
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const fake = installMessagePorts(instance, { eventPersistence })
      const response = await instance.fetch(new Request("https://conversation/message", {
        method: "POST",
        headers: { "x-conversation-key": env.EVENTED_CANARY_KEY ?? "" },
        body: JSON.stringify({ text: "hello" }),
      }))
      return {
        status: response.status,
        body: await response.json(),
        calls: fake.calls,
        prompts: fake.prompts(),
        imageStarts: fake.imageStarts,
        state: await runtime.storage.get<Record<string, unknown>>("state"),
        imageBinding: await runtime.storage.get("containerImageVariant"),
      }
    })

    expect(result.status).toBe(202)
    expect(result.prompts).toBe(0)
    expect(result.imageStarts[0]?.image).toBe(EVENTED_IMAGE)
    expect(result.calls).not.toContain("4001 POST /opencode/api/session/ses_canary/prompt")
    expect(result.imageBinding).toBe("evented")
    expect(result.state?.budgetReservation).toBeUndefined()
    expect(result.body).toMatchObject({ ok: true, queued: true })
  })

  it("loads the durable evented binding on a cold DO with a running container and requires fresh proof", async () => {
    const stub = env.CONVERSATION.getByName("image-selection-cold-running-proof")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      await runtime.storage.put("containerImageVariant", "evented")
      const fake = installMessagePorts(instance, { eventPersistence: false, initialized: true })
      const internal = instance as unknown as Internal
      internal.key = undefined
      runtimeCache(instance).invalidate()
      let error = ""
      try {
        await internal.doEnsureReady()
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
      }
      return {
        error,
        calls: fake.calls,
        binding: runtimeCache(instance).imageVariant,
        persisted: await runtime.storage.get("containerImageVariant"),
      }
    })

    expect(result.binding).toBe("evented")
    expect(result.persisted).toBe("evented")
    expect(result.error).toContain("did not confirm persistent events")
    expect(result.calls).toContain("4001 POST /start")
    expect(result.calls).not.toContain("4000 GET /api/config")
  })
})
