import { beforeEach, describe, expect, it } from "vitest"
import { env, runInDurableObject, SELF } from "cloudflare:test"
import type { Conversation } from "../src/conversation"
import { ConversationStore, type ConversationState } from "../src/state"
import type { WorkspaceRepositoryBinding, WorkspaceRepositoryReceipt } from "../src/workspace-repository"
import type { ConversationRuntimeAccess } from "../src/conversation/runtime-access"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"
import { runtimeCache } from "./helpers/runtime-cache"
import { encryptBytes } from "../src/archive-crypto"
import { deriveWorkspaceKey } from "@chester-hill-solutions/vault/core"
import { workspaceID } from "../src/vault"

const API = { authorization: "Bearer test-token", "content-type": "application/json" }
const PATH = "/workspace/repository"
const selection = { repository: "https://github.com/example/selected", baseBranch: "main", workingBranch: "task/example" }
const commit = "a".repeat(40)

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function internal(instance: Conversation) {
  return instance as unknown as {
    ctx: object
    store: ConversationStore
    env: { EVENTED_FRESH_CONVERSATIONS?: string }
    admissions: { withLock<T>(operation: () => Promise<T>): Promise<T>; claim(): Promise<boolean> }
    runtimeAccess: ConversationRuntimeAccess
    readiness: { prepare(): Promise<unknown> }
    ensureReady(): Promise<unknown>
  }
}

function put(instance: Conversation, value: unknown = selection) {
  return instance.fetch(new Request(`https://conversation${PATH}`, { method: "PUT", body: JSON.stringify(value) }))
}

function installRuntime(instance: Conversation, options: { configureStatus?: number; receipt?: "missing" | "wrong-id" | "wrong-base"; initialized?: boolean; unexpectedReceipt?: WorkspaceRepositoryReceipt } = {}) {
  const calls: string[] = []
  const configured: Array<Record<string, unknown>> = []
  const restores: string[] = []
  let initialized = options.initialized ?? false
  let materializations = 0
  let prompts = 0
  let sessions = 0
  let lastReceipt: WorkspaceRepositoryReceipt | undefined
  const container = {
    running: false,
    images: { base: "registry.invalid/base@sha256:base", evented: "registry.invalid/evented@sha256:evented" },
    start() { calls.push("container.start"); this.running = true },
    async destroy() { calls.push("container.destroy"); this.running = false },
    async setInactivityTimeout() {},
    getTcpPort(port: number) {
      return { async fetch(input: Request | string | URL, init?: RequestInit) {
        const request = input instanceof Request ? input : new Request(input, init)
        const url = new URL(request.url)
        calls.push(`${port} ${request.method} ${url.pathname}`)
        if (url.pathname === "/health") return Response.json({ ok: true })
        if (url.pathname === "/status") return Response.json({ initialized })
        if (url.pathname === "/configure") {
          configured.push(await request.json() as Record<string, unknown>)
          return Response.json({ ok: options.configureStatus === undefined }, { status: options.configureStatus ?? 200 })
        }
        if (url.pathname === "/start") {
          const binding = configured.at(-1)?.workspaceRepository as WorkspaceRepositoryBinding | undefined
          if (binding && !lastReceipt) {
            if (!initialized) materializations++
            lastReceipt = { ...binding, status: "bound", baseCommit: commit }
          }
          initialized = true
          let receipt: unknown = lastReceipt
          if (options.receipt === "missing") receipt = undefined
          if (lastReceipt && options.receipt === "wrong-id") receipt = { ...lastReceipt, bindingID: crypto.randomUUID() }
          if (lastReceipt && options.receipt === "wrong-base") receipt = { ...lastReceipt, baseCommit: "b".repeat(40) }
          return Response.json({ ...accountingPolicyStart, workspaceRepository: options.unexpectedReceipt ?? receipt })
        }
        if (url.pathname === "/checkpoint") return new Response(null, { status: 204 })
        if (url.pathname === "/restore") {
          restores.push(`${url.searchParams.get("part")}:${await request.text()}`)
          initialized = true
          return Response.json({ ok: true })
        }
        if (url.pathname === "/seed-state") return Response.json({ ok: true })
        const path = url.pathname.replace(/^\/opencode/, "")
        if (path === "/api/config") return Response.json(accountingPolicyConfig)
        if (path === "/api/session" && request.method === "POST") {
          sessions++
          return Response.json({ data: { id: "ses_repository" } })
        }
        if (path === "/api/session/ses_repository") return Response.json({ data: { id: "ses_repository" } })
        if (path.endsWith("/model")) return new Response(null, { status: 204 })
        if (path.endsWith("/prompt")) {
          expect((await internal(instance).store.get()).workspaceRepository).toMatchObject({ status: "bound", baseCommit: commit })
          prompts++
          return Response.json({ data: {} })
        }
        return Response.json({ data: [] })
      } }
    },
  }
  Object.defineProperty(internal(instance).ctx, "container", { configurable: true, value: container })
  const previous = internal(instance).env
  const environment = Object.create(previous) as typeof previous
  Object.defineProperty(environment, "EVENTED_FRESH_CONVERSATIONS", { value: "true", enumerable: true })
  internal(instance).env = environment
  return { calls, configured, restores, container, materializations: () => materializations, prompts: () => prompts, sessions: () => sessions }
}

async function settings(value: Record<string, unknown>) {
  const response = await env.SETTINGS.getByName("global").fetch("https://settings/put", { method: "POST", body: JSON.stringify(value) })
  expect(response.status).toBe(200)
}

beforeEach(async () => {
  await runInDurableObject(env.SETTINGS.getByName("global"), async (_instance, state) => state.storage.deleteAll())
  await settings({ workspaceRepo: "https://github.com/example/default", workspaceBranch: "default-base", streaming: false, dailyBudgetUSD: 0, maxContainers: 10 })
})

describe("opt-in workspace repository API", () => {
  it("authenticates, validates methods/keys and keeps GET/PUT intent-only without registry/startup/accounting", async () => {
    const key = "repository-public"
    const url = `https://harness.test/api/conversations/${key}${PATH}`
    const before = await (await env.SETTINGS.getByName("global").fetch("https://settings/conversations")).json()
    expect((await SELF.fetch(url)).status).toBe(401)
    expect((await SELF.fetch("https://harness.test/api/conversations/bad%2Fkey/workspace/repository", { headers: API })).status).toBe(400)
    const method = await SELF.fetch(url, { method: "POST", headers: API })
    expect(method.status).toBe(405)
    expect(method.headers.get("allow")).toBe("GET, PUT")
    const get = await SELF.fetch(url, { headers: API })
    expect(await get.json()).toEqual({ workspaceRepository: null })
    const response = await SELF.fetch(url, { method: "PUT", headers: API, body: JSON.stringify(selection) })
    expect(response.status).toBe(201)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const selected = await response.json() as { workspaceRepository: WorkspaceRepositoryBinding }
    expect(selected.workspaceRepository).toMatchObject({ ...selection, status: "pending", baseCommit: null })
    const retry = await SELF.fetch(url, { method: "PUT", headers: API, body: JSON.stringify(selection) })
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual(selected)
    expect(await (await env.SETTINGS.getByName("global").fetch("https://settings/conversations")).json()).toEqual(before)
    await runInDurableObject(env.CONVERSATION.getByName(key), async (_instance, state) => {
      expect([...await state.storage.list()].map(([name]) => name)).toEqual(["state"])
      expect(await state.storage.getAlarm()).toBeNull()
    })
  })

  it("freezes defaults once, keeps retries stable after settings changes and never rebinds another selection", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("repository-defaults"), async instance => {
      const first = await put(instance, { workingBranch: "task/defaults" })
      expect(first.status).toBe(201)
      const receipt = await first.json()
      expect(receipt).toMatchObject({ workspaceRepository: { repository: "https://github.com/example/default", baseBranch: "default-base" } })
      await settings({ workspaceRepo: "https://github.com/example/changed", workspaceBranch: "other-base" })
      const retry = await put(instance, { workingBranch: "task/defaults" })
      expect(retry.status).toBe(200)
      expect(await retry.json()).toEqual(receipt)
      expect((await put(instance, { ...selection, workingBranch: "other/task" })).status).toBe(409)
    })
  })

  it("rejects malformed or credential-bearing selections without writing an intent", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("repository-invalid"), async (instance, state) => {
      for (const value of [{}, [], { ...selection, repository: null }, { workingBranch: "task/x", baseBranch: null },
        { ...selection, repository: "https://token@github.com/example/repo" }, { ...selection, baseCommit: commit },
        { ...selection, workingBranch: "../escape" }]) {
        expect((await put(instance, value)).status).toBe(400)
        expect(await state.storage.get("state")).toBeUndefined()
      }
    })
  })

  it("serializes competing selections and retains the winner after a lost response and busy work", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("repository-competing"), async (instance, state) => {
      const [one, two] = await Promise.all([put(instance), put(instance, { ...selection, repository: "https://github.com/example/other" })])
      expect([one.status, two.status].sort()).toEqual([201, 409])
      const binding = (await new ConversationStore(state.storage).get()).workspaceRepository!
      await new ConversationStore(state.storage).patch({ phase: "running", sessionID: "ses_existing" })
      const retry = await put(instance, { repository: binding.repository, baseBranch: binding.baseBranch, workingBranch: binding.workingBranch })
      expect(retry.status).toBe(200)
      expect(await retry.json()).toEqual({ workspaceRepository: binding })
    })
  })

  it("refuses legacy work, checkpoints, runtime history and running native execution before binding", async () => {
    const cases: Array<{ state?: Partial<ConversationState>; key?: string; running?: boolean }> = [
      { state: { sessionID: "ses_legacy" } }, { state: { phase: "admitting", admissionID: "claim" } },
      { state: { checkpointKey: "legacy/archive" } }, { state: { containerStarts: 1 } },
      { state: { seen: ["msg:accepted"] } }, { key: "snapshot" }, { key: "controlToken" }, { running: true },
    ]
    for (const [index, item] of cases.entries()) await runInDurableObject(env.CONVERSATION.getByName(`repository-history-${index}`), async (instance, state) => {
      if (item.state) await new ConversationStore(state.storage).patch(item.state)
      if (item.key) await state.storage.put(item.key, "prior-runtime-history")
      if (item.running) Object.defineProperty(internal(instance).ctx, "container", { configurable: true, value: { running: true } })
      expect((await put(instance)).status).toBe(409)
      expect((await new ConversationStore(state.storage).get()).workspaceRepository).toBeUndefined()
    })
  })

  it("rereads accepted work after waiting for the admission lock", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("repository-lock"), async (instance, state) => {
      const entered = deferred()
      const release = deferred()
      const claim = internal(instance).admissions.withLock(async () => {
        entered.resolve()
        await release.promise
        await new ConversationStore(state.storage).patch({ phase: "admitting", admissionID: "accepted-claim" })
      })
      await entered.promise
      const request = put(instance)
      release.resolve()
      await claim
      expect((await request).status).toBe(409)
    })
  })

  it("applies the durable selection over changed globals and acknowledges actual base before session/provider use", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("repository-start"), async (instance, state) => {
      expect((await put(instance)).status).toBe(201)
      await settings({ workspaceRepo: "https://github.com/example/changed", workspaceBranch: "other-base" })
      const runtime = installRuntime(instance)
      await internal(instance).ensureReady()
      const current = await new ConversationStore(state.storage).get()
      expect(current.workspaceRepository).toMatchObject({ ...selection, status: "bound", baseCommit: commit })
      expect(runtime.configured.at(-1)).toMatchObject({ workspaceRepository: { ...selection, bindingID: current.workspaceRepository!.bindingID } })
      expect(runtime.configured.at(-1)).not.toHaveProperty("workspaceRepo")
      expect(runtime.configured.at(-1)).not.toHaveProperty("workspaceBranch")
      expect(runtime.configured.at(-1)).not.toHaveProperty("githubToken")
      expect(await state.storage.get("containerImageVariant")).toBe("evented")
      expect(runtimeCache(instance).ready).toBe(true)
      expect(runtime.sessions()).toBe(0)
      expect(runtime.prompts()).toBe(0)
      await internal(instance).ensureReady()
      expect(runtime.materializations()).toBe(1)
      expect(runtime.configured).toHaveLength(2)
    })
  })

  it("reconciles a lost DO acknowledgement without replacing the intent or rematerializing checkout", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("repository-lost-ack"), async (instance, state) => {
      expect((await put(instance)).status).toBe(201)
      const originalBinding = (await new ConversationStore(state.storage).get()).workspaceRepository!
      const runtime = installRuntime(instance)
      const store = internal(instance).store
      const acknowledge = store.acknowledgeWorkspaceRepository.bind(store)
      let lost = true
      store.acknowledgeWorkspaceRepository = async receipt => {
        if (lost) { lost = false; return false }
        return acknowledge(receipt)
      }
      await expect(internal(instance).ensureReady()).rejects.toMatchObject({ code: "WORKSPACE_REPOSITORY_CONFLICT" })
      expect((await store.get()).workspaceRepository).toEqual(originalBinding)
      await internal(instance).ensureReady()
      expect((await store.get()).workspaceRepository).toMatchObject({ bindingID: originalBinding.bindingID, status: "bound", baseCommit: commit })
      expect(runtime.materializations()).toBe(1)
      expect(runtime.prompts()).toBe(0)
      expect(runtime.sessions()).toBe(0)
    })
  })

  it("restores split encrypted archives and verifies the retained binding/base despite changed defaults", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("repository-restore"), async (instance, state) => {
      expect((await put(instance)).status).toBe(201)
      const store = new ConversationStore(state.storage)
      const binding = (await store.get()).workspaceRepository!
      const receipt: WorkspaceRepositoryReceipt = { ...binding, status: "bound", baseCommit: commit }
      expect(await store.acknowledgeWorkspaceRepository(receipt)).toBe(true)
      const key = await deriveWorkspaceKey(env.VAULT_MASTER_KEY!, workspaceID(env))
      const parts = { workspace: "synthetic restored workspace bytes", state: "synthetic restored harness bytes" }
      const workspace = await encryptBytes(new TextEncoder().encode(parts.workspace), key)
      const harness = await encryptBytes(new TextEncoder().encode(parts.state), key)
      const prefix = `workspaces/${state.id.toString()}/repository-fixture`
      await env.CHECKPOINTS.put(`${prefix}/workspace`, workspace, { customMetadata: { encrypted: "1" } })
      await env.CHECKPOINTS.put(`${prefix}/state`, harness, { customMetadata: { encrypted: "1" } })
      await store.patch({ checkpointManifest: { workspace: { key: `${prefix}/workspace`, size: workspace.byteLength, encrypted: true },
        state: { key: `${prefix}/state`, size: harness.byteLength, encrypted: true }, createdAt: Date.now() }, containerStarts: 1 })
      await state.storage.put("containerImageVariant", "evented")
      await settings({ workspaceRepo: "https://github.com/example/changed", workspaceBranch: "changed-base" })
      const runtime = installRuntime(instance)
      await internal(instance).ensureReady()
      expect(runtime.restores).toEqual([`workspace:${parts.workspace}`, `state:${parts.state}`])
      expect(runtime.configured.at(-1)?.workspaceRepository).toEqual(receipt)
      expect((await store.get()).workspaceRepository).toEqual(receipt)
      expect(runtime.materializations()).toBe(0)
      expect(runtime.prompts()).toBe(0)
    })
  })

  it("fails closed on control refusal or malformed proof without session, prompt, hold or automatic queue", async () => {
    for (const [index, options] of [{ configureStatus: 409 }, { receipt: "missing" as const }, { receipt: "wrong-id" as const }].entries()) {
      await runInDurableObject(env.CONVERSATION.getByName(`repository-refusal-${index}`), async (instance, state) => {
        expect((await put(instance)).status).toBe(201)
        const runtime = installRuntime(instance, options)
        const response = await instance.fetch(new Request("https://conversation/message", { method: "POST", body: JSON.stringify({ text: "synthetic task", idempotencyKey: "not-dispatched" }) }))
        expect(response.status).toBe(409)
        expect(await response.json()).toMatchObject({ code: "WORKSPACE_REPOSITORY_CONFLICT" })
        const current = await new ConversationStore(state.storage).get()
        expect(current.sessionID).toBeUndefined()
        expect(current.budgetReservation).toBeUndefined()
        expect(current.queue).toEqual([])
        expect(current.seen).not.toContain("msg:not-dispatched")
        expect(runtime.sessions()).toBe(0)
        expect(runtime.prompts()).toBe(0)
        expect(runtimeCache(instance).ready).toBe(false)
      })
    }
  })

  it("uses the existing session/admission/accounting path only after acknowledging the selected checkout", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("repository-message"), async (instance, state) => {
      expect((await put(instance)).status).toBe(201)
      const runtime = installRuntime(instance)
      const response = await instance.fetch(new Request("https://conversation/message", {
        method: "POST", body: JSON.stringify({ text: "synthetic task", idempotencyKey: "bound-message" }),
      }))
      expect(response.status).toBe(200)
      expect(runtime.sessions()).toBe(1)
      expect(runtime.prompts()).toBe(1)
      expect(runtime.materializations()).toBe(1)
      expect((await new ConversationStore(state.storage).get()).budgetReservation?.dispatched).toBe(true)
    })
  })

  it("refuses an already-bound runtime for an unbound conversation before creating a session or prompt", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("repository-unbound-refusal"), async (instance, state) => {
      const runtime = installRuntime(instance, { initialized: true, unexpectedReceipt: {
        ...selection, schemaVersion: 1, bindingID: crypto.randomUUID(), status: "bound", baseCommit: commit,
      } })
      const response = await instance.fetch(new Request("https://conversation/message", {
        method: "POST", body: JSON.stringify({ text: "synthetic unbound task" }),
      }))
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ code: "WORKSPACE_REPOSITORY_CONFLICT" })
      expect(runtime.sessions()).toBe(0)
      expect(runtime.prompts()).toBe(0)
      const current = await new ConversationStore(state.storage).get()
      expect(current.workspaceRepository).toBeUndefined()
      expect(current.budgetReservation).toBeUndefined()
      expect(current.queue).toEqual([])
      expect(runtimeCache(instance).ready).toBe(false)
    })
  })

  it("does not skip bound verification on a warm idle runtime or accept a different resolved base", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("repository-warm-conflict"), async (instance, state) => {
      expect((await put(instance)).status).toBe(201)
      const runtime = installRuntime(instance)
      await internal(instance).ensureReady()
      const binding = (await new ConversationStore(state.storage).get()).workspaceRepository!
      const conflicting = installRuntime(instance, { receipt: "wrong-base", initialized: true })
      await expect(internal(instance).ensureReady()).rejects.toMatchObject({ code: "WORKSPACE_REPOSITORY_CONFLICT" })
      expect((await new ConversationStore(state.storage).get()).workspaceRepository).toEqual(binding)
      expect(conflicting.sessions()).toBe(0)
      expect(conflicting.prompts()).toBe(0)
      expect(runtime.materializations()).toBe(1)
      expect(runtimeCache(instance).ready).toBe(false)
    })
  })
})
