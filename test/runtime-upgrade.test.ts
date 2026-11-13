import { beforeEach, describe, expect, it } from "vitest"
import { env, runInDurableObject, SELF } from "cloudflare:test"
import type { Conversation } from "../src/conversation"
import type { ConversationState } from "../src/state"
import { ACCOUNTING_POLICY_ID } from "../src/accounting-policy"
import { accountingPolicyConfig } from "./helpers/accounting-policy"
import { runtimeCache } from "./helpers/runtime-cache"

const API = { authorization: "Bearer test-token" }
const BASE_IMAGE = `registry.cloudflare.com/test/runtime-base@sha256:${"1".repeat(64)}`
const EVENTED_IMAGE = `registry.cloudflare.com/test/runtime-evented@sha256:${"2".repeat(64)}`
const SESSION = "ses_upgrade_original"
const workspaceArchive = new TextEncoder().encode("workspace checkpoint payload")
const stateArchive = new TextEncoder().encode("state checkpoint payload")

type Options = { eventPersistence?: boolean; missingStatePart?: boolean; wrongHistory?: boolean; failDestroy?: boolean; pendingInbox?: boolean; gatedPermissionReply?: boolean; inboxAfterPermissionReply?: boolean }

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

function installRuntime(instance: Conversation, options: Options = {}) {
  const internal = instance as unknown as {
    ctx: object
    key?: string
    transport?: unknown
  }
  const calls: string[] = []
  const restores: string[] = []
  const contexts: string[] = []
  let notifyPermissionStarted!: () => void
  let releasePermission!: () => void
  let permissionReplyResolved = false
  const permissionReplyStarted = new Promise<void>((resolve) => { notifyPermissionStarted = resolve })
  const permissionReplyGate = new Promise<void>((resolve) => { releasePermission = resolve })
  let initialized = true
  let generation = "runtime-base-generation"
  let starts = 0
  let destroys = 0
  let promptCalls = 0
  const images: Record<string, string> = { base: BASE_IMAGE, evented: EVENTED_IMAGE }
  const container = {
    images,
    running: true,
    start(startOptions: { image?: string }) {
      starts++
      this.running = true
      initialized = false
      if (startOptions.image) generation = startOptions.image === EVENTED_IMAGE ? "runtime-evented-generation" : "runtime-base-generation"
    },
    async destroy() {
      destroys++
      if (options.failDestroy && destroys === 1) throw new Error("simulated destroy failure")
      this.running = false
      initialized = false
    },
    async setInactivityTimeout() {},
    async snapshotContainer() { return { id: "base-fast-snapshot", size: 5 } },
    getTcpPort(port: number) {
      return {
        async fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
          const request = input instanceof Request ? input : new Request(input, init)
          const url = new URL(request.url)
          calls.push(`${port} ${request.method} ${url.pathname}${url.search}`)
          const path = port === 4001 && url.pathname.startsWith("/opencode/")
            ? url.pathname.slice("/opencode".length)
            : url.pathname
          if (path === "/health") return json({ ok: true })
          if (port === 4001 && !url.pathname.startsWith("/opencode/")) {
            if (path === "/status") return json({ initialized })
            if (path === "/configure") return json({ ok: true })
            if (path === "/start") return json({
              ok: true,
              accountingPolicy: ACCOUNTING_POLICY_ID,
              opencodeGeneration: generation,
              eventPersistence: generation === "runtime-evented-generation" && options.eventPersistence === false
                ? false
                : true,
            })
            if (path === "/checkpoint") {
              if (url.searchParams.get("part") === "state" && options.missingStatePart) return new Response(null, { status: 404 })
              const statePart = url.searchParams.get("part") === "state"
              const bytes = statePart ? stateArchive : workspaceArchive
              return new Response(bytes.slice(), { headers: {
                "content-type": "application/gzip",
                "x-aboiteau-checkpoint": "split",
                ...(statePart ? { "x-state-fingerprint": "b".repeat(64) } : { "x-workspace-fingerprint": "a".repeat(64) }),
              } })
            }
            if (path === "/restore" && request.method === "POST") {
              const part = url.searchParams.get("part") ?? "workspace"
              const body = new Uint8Array(await request.arrayBuffer())
              restores.push(`${part}:${new TextDecoder().decode(body)}`)
              if (part === "state") initialized = true
              return json({ ok: true })
            }
            return json({ error: "not found" }, 404)
          }
          if (path === "/api/config") return json(accountingPolicyConfig)
          if (path === `/api/session/${SESSION}`) return json({ data: {
            id: SESSION,
            location: { directory: "/workspace" },
            time: { created: 1, idle: Date.now(), updated: Date.now() },
          } })
          if (path === `/api/session/${SESSION}/context`) {
            const context = options.wrongHistory && generation === "runtime-evented-generation"
            ? [{ id: "mutated-history", type: "assistant", content: [{ type: "text", text: "different history" }] }]
            : [{ id: "history-1", type: "assistant", content: [{ type: "text", text: "saved history" }] }]
            contexts.push(JSON.stringify(context))
            return json({ data: context })
          }
          if (path === `/api/experimental/session/${SESSION}/wait`) return new Response(null, { status: 204 })
          if (path === `/api/session/${SESSION}/inbox`) return json({ data:
            (options.pendingInbox && generation === "runtime-evented-generation") ||
              (options.inboxAfterPermissionReply && permissionReplyResolved && generation === "runtime-base-generation")
              ? [{ id: "pending-inbox-item" }] : [],
          })
          if (path === `/api/session/${SESSION}/permission/req-upgrade/reply`) {
            notifyPermissionStarted()
            if (options.gatedPermissionReply) await permissionReplyGate
            permissionReplyResolved = true
            return new Response(null, { status: 204 })
          }
          if (path === `/api/session/${SESSION}/form` || path === "/api/permission/request") return json({ data: [] })
          if (path === `/api/session/${SESSION}/prompt`) {
            promptCalls++
            return json({ data: {} })
          }
          return json({ error: "not found" }, 404)
        },
      }
    },
  }
  Object.defineProperty(internal.ctx, "container", { configurable: true, value: container })
  runtimeCache(instance).invalidate()
  // Real container port startup is important here: the test records selected
  // image, start/destroy ordering, archive restore and the native API proof.
  internal.transport = undefined
  return {
    container, calls, restores, contexts, permissionReplyStarted, releasePermissionReply: releasePermission,
    get starts() { return starts }, get destroys() { return destroys }, get promptCalls() { return promptCalls },
  }
}

async function clearSettings(): Promise<void> {
  await runInDurableObject(env.SETTINGS.getByName("global"), async (_instance, state) => state.storage.deleteAll())
  await env.SETTINGS.getByName("global").fetch("https://settings/put", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ streaming: false, dailyBudgetUSD: 0 }),
  })
}

async function setup(key: string, options: Options = {}) {
  const stub = env.CONVERSATION.getByName(key)
  const runtime = await runInDurableObject(stub, async (instance, state) => {
    await state.storage.deleteAll()
    const settingsResponse = await env.SETTINGS.getByName("global").fetch("https://settings/get")
    const settings = await settingsResponse.json() as { version: number }
    await state.storage.put("state", {
      sessionID: SESSION,
      phase: "idle",
      settingsVersion: settings.version,
      seen: [],
      pending: {},
    } satisfies ConversationState)
    await state.storage.put("snapshot", { id: "base-fast-snapshot", size: 5 })
    return installRuntime(instance as Conversation, options)
  })
  return { stub, runtime }
}

async function call(key: string, method: "GET" | "POST", body?: unknown) {
  return SELF.fetch(`https://harness.test/api/conversations/${encodeURIComponent(key)}/runtime/upgrade`, {
    method,
    headers: { ...API, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function storedState(key: string) {
  return runInDurableObject(env.CONVERSATION.getByName(key), async (_instance, state) => ({
    state: await state.storage.get<ConversationState>("state"),
    pending: await state.storage.get<Record<string, unknown>>("runtimeUpgradePending"),
    receipt: await state.storage.get<Record<string, unknown>>("runtimeUpgradeCompletion"),
    image: await state.storage.get<string>("containerImageVariant"),
    snapshot: await state.storage.get("snapshot"),
  }))
}

describe("operator-controlled evented runtime upgrade", () => {
  beforeEach(clearSettings)

  it("requires API auth and refuses held or queued work without checkpointing", async () => {
    const key = "C1:runtime-upgrade-blocked"
    const { runtime } = await setup(key)
    expect((await SELF.fetch(`https://harness.test/api/conversations/${encodeURIComponent(key)}/runtime/upgrade`)).status).toBe(401)
    await runInDurableObject(env.CONVERSATION.getByName(key), async (_instance, state) => {
      await state.storage.put("state", {
        ...(await state.storage.get<ConversationState>("state")),
        queued: { text: "must not dispatch", attempts: 0, nextAttemptAt: Date.now() + 5000 },
      })
    })
    const response = await call(key, "GET")
    expect(response.status).toBe(409)
    expect(runtime.calls.some((entry) => entry.includes("/checkpoint"))).toBe(false)
    expect(runtime.destroys).toBe(0)
  })

  it("checkpoints both split parts, restores the original history, retains archives, and replays completion safely", async () => {
    const key = "C1:runtime-upgrade-happy"
    const { runtime } = await setup(key)
    const previewResponse = await call(key, "GET")
    expect(previewResponse.status, `${await previewResponse.clone().text()}\n${runtime.calls.join("\n")}`).toBe(200)
    const preview = await previewResponse.json() as { canApply: boolean; planID: string; targetImage: string; sessionID: string }
    expect(preview).toMatchObject({ canApply: true, targetImage: EVENTED_IMAGE, sessionID: SESSION })
    const apply = await call(key, "POST", { expectedPlanID: preview.planID })
    expect(apply.status, `${await apply.clone().text()}\n${runtime.calls.join("\n")}\n${runtime.restores.join("\n")}\n${runtime.contexts.join("\n")}`).toBe(200)
    expect(await apply.json()).toMatchObject({ ok: true, completed: true })
    expect(runtime.destroys).toBe(1)
    expect(runtime.starts).toBe(1)
    expect(runtime.restores).toEqual([
      `workspace:${new TextDecoder().decode(workspaceArchive)}`,
      `state:${new TextDecoder().decode(stateArchive)}`,
    ])
    expect(runtime.promptCalls).toBe(0)
    const state = await storedState(key)
    expect(state.pending).toBeUndefined()
    expect(state.image).toBe("evented")
    expect(state.receipt).toMatchObject({ planID: preview.planID, sessionID: SESSION, targetImage: EVENTED_IMAGE })
    expect(state.snapshot).toEqual({ id: "base-fast-snapshot", size: 5 })
    const prefix = `workspaces/${(await runInDurableObject(env.CONVERSATION.getByName(key), async (_instance, runtime) => runtime.id.toString()))}/`
    const archives = await env.CHECKPOINTS.list({ prefix })
    expect(archives.objects.map((object) => object.key)).toHaveLength(2)
    const replay = await call(key, "POST", { expectedPlanID: preview.planID })
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ ok: true, completed: true, replayed: true })
    expect(runtime.destroys).toBe(1)
  })

  it("keeps the base runtime if checkpoint publication omits the state part", async () => {
    const key = "C1:runtime-upgrade-no-state-archive"
    const { runtime } = await setup(key, { missingStatePart: true })
    const preview = await (await call(key, "GET")).json() as { planID: string }
    const response = await call(key, "POST", { expectedPlanID: preview.planID })
    expect(response.status).toBe(503)
    expect(runtime.destroys).toBe(0)
    expect((await storedState(key)).pending).toBeUndefined()
    expect((await storedState(key)).image).toBeUndefined()
  })

  it("leaves a failed persistent-event restore pending and refuses messages without queuing", async () => {
    const key = "C1:runtime-upgrade-no-events"
    const { stub } = await setup(key, { eventPersistence: false })
    const preview = await (await call(key, "GET")).json() as { planID: string }
    const response = await call(key, "POST", { expectedPlanID: preview.planID })
    expect(response.status).toBe(503)
    expect((await storedState(key)).pending).toMatchObject({ planID: preview.planID })
    const message = await stub.fetch("https://conversation/message", {
      method: "POST", body: JSON.stringify({ text: "must not run" }),
    })
    expect(message.status).toBe(409)
    expect(await message.json()).toMatchObject({ error: expect.stringContaining("no message was queued") })
    expect((await storedState(key)).state?.queued).toBeUndefined()
  })

  it("resumes a pre-destroy crash from the saved manifest and rechecks idle on restore", async () => {
    const key = "C1:runtime-upgrade-pre-destroy-retry"
    const { runtime } = await setup(key, { failDestroy: true })
    const preview = await (await call(key, "GET")).json() as { planID: string }
    const first = await call(key, "POST", { expectedPlanID: preview.planID })
    expect(first.status).toBe(503)
    expect((await storedState(key)).pending).toMatchObject({ planID: preview.planID })
    expect(runtime.container.running).toBe(true)
    const retry = await call(key, "POST", { expectedPlanID: preview.planID })
    expect(retry.status, await retry.clone().text()).toBe(200)
    expect(runtime.destroys).toBe(2)
    expect((await storedState(key)).pending).toBeUndefined()
    expect(runtime.restores.map((entry) => entry.split(":", 1)[0])).toEqual(["workspace", "state"])
  })

  it.each([
    ["changed history", { wrongHistory: true }],
    ["pending inbox", { pendingInbox: true }],
  ] as const)("keeps migration pending when restored native state has %s", async (label, options) => {
    const key = `C1:runtime-upgrade-invalid-${label.replaceAll(" ", "-")}`
    const { runtime } = await setup(key, options)
    const preview = await (await call(key, "GET")).json() as { planID: string }
    const response = await call(key, "POST", { expectedPlanID: preview.planID })
    expect(response.status).toBe(503)
    const state = await storedState(key)
    expect(state.pending).toMatchObject({ planID: preview.planID })
    expect(state.receipt).toBeUndefined()
    expect(runtime.promptCalls).toBe(0)
    expect(runtime.calls.some((entry) => entry.includes("/api/session") && entry.endsWith("/prompt"))).toBe(false)
  })

  it("does not destroy the old runtime when the configured target drifts after preview", async () => {
    const key = "C1:runtime-upgrade-target-drift"
    const { runtime } = await setup(key)
    const preview = await (await call(key, "GET")).json() as { planID: string }
    runtime.container.images.evented = `registry.cloudflare.com/test/drifted@sha256:${"3".repeat(64)}`
    const response = await call(key, "POST", { expectedPlanID: preview.planID })
    expect(response.status).toBe(409)
    expect(runtime.destroys).toBe(0)
    expect((await storedState(key)).pending).toBeUndefined()
  })

  it("serializes an in-flight permission reply before checkpointing and takes fresh quiescence evidence", async () => {
    const key = "C1:runtime-upgrade-permission-race"
    await runInDurableObject(env.CONVERSATION.getByName(key), async (instance, storage) => {
      await storage.storage.deleteAll()
      const settingsResponse = await env.SETTINGS.getByName("global").fetch("https://settings/get")
      const settings = await settingsResponse.json() as { version: number }
      await storage.storage.put("state", {
        sessionID: SESSION, phase: "idle", settingsVersion: settings.version,
        seen: [], pending: {},
      } satisfies ConversationState)
      const runtime = installRuntime(instance as Conversation, { gatedPermissionReply: true, inboxAfterPermissionReply: true })
      const conversation = instance as unknown as Conversation
      const previewResponse = await conversation.fetch(new Request("https://conversation/runtime/upgrade"))
      expect(previewResponse.status).toBe(200)
      const preview = await previewResponse.json() as { planID: string }
      await storage.storage.put("state", {
        ...(await storage.storage.get<ConversationState>("state")),
        pending: { "req-upgrade": SESSION },
      })
      const permissionReply = conversation.fetch(new Request("https://conversation/permission", {
        method: "POST", body: JSON.stringify({ requestID: "req-upgrade", sessionID: SESSION, decision: "once" }),
      }))
      await runtime.permissionReplyStarted
      const upgrade = conversation.fetch(new Request("https://conversation/runtime/upgrade", {
        method: "POST", body: JSON.stringify({ expectedPlanID: preview.planID }),
      }))
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(runtime.calls.some((entry) => entry.includes("/checkpoint"))).toBe(false)
      expect(runtime.destroys).toBe(0)

      runtime.releasePermissionReply()
      expect((await permissionReply).status).toBe(200)
      const response = await upgrade
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ error: expect.stringContaining("quiescence could not be verified") })
      expect(runtime.calls.some((entry) => entry.includes("/opencode/api/session/ses_upgrade_original/inbox"))).toBe(true)
      expect(runtime.calls.some((entry) => entry.includes("/checkpoint"))).toBe(false)
      expect(runtime.destroys).toBe(0)
      expect((await storage.storage.get<ConversationState>("state"))?.pending).toEqual({})
      expect(await storage.storage.get("runtimeUpgradePending")).toBeUndefined()
    })
  })
})
