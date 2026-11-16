import { describe, expect, it } from "vitest"
import { env, runInDurableObject, SELF } from "cloudflare:test"
import type { Conversation } from "../src/conversation"
import { ConversationStore } from "../src/state"
import { ConversationWorkspaceLifecycle, WorkspaceMaintenanceError } from "../src/conversation/workspace-lifecycle"
import type { ConversationRuntimeAccess } from "../src/conversation/runtime-access"
import type { WorkspaceProfile } from "../src/workspace-profile"

const API = { authorization: "Bearer test-token", "content-type": "application/json" }
function call(instance: Conversation, path: string, method = "GET", value?: unknown) {
  return instance.fetch(new Request("https://conversation/workspace/" + path, { method, ...(value === undefined ? {} : { body: JSON.stringify(value) }) }))
}
async function profile(instance: Conversation) { return (await (await call(instance, "profile")).json() as { workspace: WorkspaceProfile }).workspace }
async function mode(instance: Conversation, retention: "persistent" | "disposable", name?: string) {
  const p = await profile(instance)
  const response = await call(instance, "profile", "PUT", { expectedProfileID: p.profileID, expectedRevision: p.revision, retention, ...(name ? { name } : {}) })
  expect(response.status).toBe(200)
  return profile(instance)
}
function request(p: WorkspaceProfile, requestID = crypto.randomUUID()) { return { requestID, expectedProfileID: p.profileID, expectedRevision: p.revision } }
function core(instance: Conversation) { return Reflect.get(instance, "workspaceLifecycle") as ConversationWorkspaceLifecycle }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

describe("workspace retention and explicit discard", () => {
  it("authenticates public routes, reads default passively and changes metadata without runtime preparation", async () => {
    const key = "workspace-public-" + crypto.randomUUID(), base = "https://worker/api/conversations/" + key + "/workspace/"
    expect((await SELF.fetch(base + "profile")).status).toBe(401)
    const get = await SELF.fetch(base + "profile", { headers: API })
    expect(get.status).toBe(200); expect(get.headers.get("cache-control")).toBe("no-store")
    const p = (await get.json() as { workspace: WorkspaceProfile }).workspace
    expect(p).toMatchObject({ retention: "persistent", status: "active", revision: 1, name: null })
    await runInDurableObject(env.CONVERSATION.getByName(key), async (instance, runtime) => {
      expect(await runtime.storage.list()).toEqual(new Map())
      expect(await profile(instance)).toEqual(p)
      instance.transport = () => { throw new Error("metadata must not start runtime") }
    })
    const put = await SELF.fetch(base + "profile", { method: "PUT", headers: API, body: JSON.stringify({ expectedProfileID: p.profileID, expectedRevision: 1, retention: "disposable", name: "Scratch work" }) })
    expect(put.status).toBe(200)
    expect((await put.json() as { workspace: WorkspaceProfile }).workspace).toMatchObject({ profileID: p.profileID, retention: "disposable", name: "Scratch work", revision: 2 })
    const bad = await SELF.fetch(base + "discard", { method: "PUT", headers: API })
    expect(bad.status).toBe(405); expect(bad.headers.get("allow")).toBe("GET, POST")
  })

  it("promotes in place and harmless preferences retain fresh root-binding eligibility", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("workspace-fresh-" + crypto.randomUUID()), async (instance, runtime) => {
      const p = await mode(instance, "disposable", "Draft")
      const promoted = await mode(instance, "persistent")
      expect(promoted.profileID).toBe(p.profileID)
      const binding = await instance.fetch(new Request("https://conversation/workspace/repository", { method: "PUT", body: JSON.stringify({ repository: "https://github.com/example/selected", baseBranch: "main", workingBranch: "task/draft" }) }))
      expect(binding.status).toBe(201)
      const store = new ConversationStore(runtime.storage)
      await store.patch({ sessionID: "ses_kept" })
      await mode(instance, "disposable")
      await mode(instance, "persistent", "Keep draft")
      expect((await store.get()).sessionID).toBe("ses_kept")
      expect((await store.get()).workspaceRepository).toBeDefined()
    })
  })

  it("busy and permission refusals retain a prepared tuple without fencing current work", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("workspace-busy-" + crypto.randomUUID()), async (instance, runtime) => {
      const store = new ConversationStore(runtime.storage), p = await mode(instance, "disposable"), body = request(p)
      await store.patch({ phase: "running" })
      expect((await call(instance, "discard", "POST", body)).status).toBe(409)
      expect(await core(instance).hasPending()).toBe(false)
      expect((await profile(instance)).status).toBe("active")
      const prepared = await (await call(instance, "discard?requestID=" + body.requestID)).json()
      expect(prepared).toMatchObject({ discard: { ...body, status: "prepared" } })
      // The actual runtime policy seam remains open for the active turn to observe/settle.
      let observed = 0
      const access = Reflect.get(instance, "runtimeAccess") as ConversationRuntimeAccess
      const options = Reflect.get(access, "options")
      const port = { fetch: async () => new Response() }
      options.identity = () => ({ ready: true, running: true, generation: "g1", port })
      await access.useWarm(async () => { observed++ })
      expect(observed).toBe(1)
      await store.patch({ phase: "idle", pending: { approval: "ses_kept" } })
      expect((await call(instance, "discard", "POST", body)).status).toBe(409)
      expect(await core(instance).hasPending()).toBe(false)
      await store.patch({ pending: {} })
      expect((await call(instance, "discard", "POST", request(p))).status).toBe(200)
      const successor = await mode(instance, "disposable", "Later work")
      await store.patch({ pending: { later: "ses_new" } })
      expect((await call(instance, "discard", "POST", body)).status).toBe(409)
      expect(await profile(instance)).toEqual(successor)
      expect((await store.get()).pending).toEqual({ later: "ses_new" })
      expect(await core(instance).hasPending()).toBe(false)
    })
  })

  it("persistent refusal freezes identity before later demotion and cleanup", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("workspace-persistent-" + crypto.randomUUID()), async (instance) => {
      const p = await profile(instance), body = request(p)
      expect((await call(instance, "discard", "POST", body)).status).toBe(409)
      expect(await core(instance).hasPending()).toBe(false)
      expect(await (await call(instance, "discard?requestID=" + body.requestID)).json()).toMatchObject({ discard: { status: "prepared", expectedRevision: 1 } })
      await mode(instance, "disposable")
      expect((await call(instance, "discard", "POST", body)).status).toBe(409)
    })
  })

  it("fences queued runtime users after partial cleanup, resumes through durable aliases and keeps historical retries harmless", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("workspace-fault-" + crypto.randomUUID()), async (instance, runtime) => {
      const p = await mode(instance, "disposable"), body = request(p), entered = deferred(), release = deferred()
      // A prepared refusal must later alias to B when B owns partial cleanup.
      const alias = request(p), store = new ConversationStore(runtime.storage)
      await store.patch({ phase: "running" })
      expect((await call(instance, "discard", "POST", alias)).status).toBe(409)
      await store.patch({ phase: "idle" })
      const checkpoints = Reflect.get(instance, "checkpoints"), original = checkpoints.deleteAll.bind(checkpoints)
      let deletes = 0
      checkpoints.deleteAll = async () => { deletes++; if (deletes === 1) { entered.resolve(); await release.promise; throw new Error("synthetic R2 failure") }; return original() }
      const first = call(instance, "discard", "POST", body)
      await entered.promise
      expect(await core(instance).hasPending()).toBe(true)
      const access = Reflect.get(instance, "runtimeAccess") as ConversationRuntimeAccess
      const opts = Reflect.get(access, "options")
      let invoked = 0
      opts.prepareOwned = async () => { invoked++; throw new Error("unexpected prepare") }
      const warm = access.useWarm(async () => { invoked++ }).catch(error => error)
      const prepare = access.prepare().catch(error => error)
      let messageFinished = false
      const message = instance.fetch(new Request("https://conversation/message", { method: "POST", body: JSON.stringify({ text: "new work after cleanup" }) }))
        .then(response => { messageFinished = true; return response })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(messageFinished).toBe(false)
      release.resolve()
      expect((await first).status).toBe(503)
      expect((await message).status).toBe(503)
      expect((await store.get()).queue ?? []).toEqual([])
      expect(await warm).toBeInstanceOf(WorkspaceMaintenanceError)
      expect(await prepare).toBeInstanceOf(WorkspaceMaintenanceError)
      expect(invoked).toBe(0)
      expect((await call(instance, "profile", "PUT", { expectedProfileID: p.profileID, expectedRevision: p.revision, retention: "persistent" })).status).toBe(409)
      const recovered = await call(instance, "discard", "POST", alias)
      expect(recovered.status).toBe(200)
      expect(await core(instance).hasPending()).toBe(false)
      expect(await (await call(instance, "discard?requestID=" + alias.requestID)).json()).toMatchObject({ discard: { requestID: alias.requestID, status: "complete" } })
      const current = await mode(instance, "disposable", "New work")
      const file = "workspaces/" + runtime.id + "/new-work"
      await env.CHECKPOINTS.put(file, "preserve me")
      for (const historical of [body, alias]) expect((await call(instance, "discard", "POST", historical)).status).toBe(200)
      expect(await profile(instance)).toEqual(current)
      expect(await (await env.CHECKPOINTS.get(file))?.text()).toBe("preserve me")
      expect(deletes).toBe(2)
      expect((await call(instance, "discard", "POST", { ...body, expectedRevision: p.revision + 1 })).status).toBe(409)
    })
  })

  it("recovers a lost completion acknowledgement without deleting successor work", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("workspace-ack-" + crypto.randomUUID()), async (instance, runtime) => {
      const p = await mode(instance, "disposable"), body = request(p), lifecycle = core(instance)
      const options = Reflect.get(lifecycle, "options"), actual = options.storage as DurableObjectStorage
      let lost = false
      options.storage = new Proxy(actual, { get(target, property) {
        if (property === "transaction") return async (callback: (txn: DurableObjectTransaction) => Promise<unknown>) => {
          const result = await target.transaction(callback)
          const raw = await target.get<{status:string}>("workspaceLifecycle:discard:" + body.requestID)
          if (!lost && raw?.status === "complete") { lost = true; throw new Error("lost completion acknowledgement") }
          return result
        }
        const value = Reflect.get(target, property, target)
        return typeof value === "function" ? value.bind(target) : value
      } })
      expect((await call(instance, "discard", "POST", body)).status).toBe(503)
      expect(lost).toBe(true)
      const successor = await mode(instance, "persistent", "Recovered successor")
      const key = "workspaces/" + runtime.id + "/new-work"
      await env.CHECKPOINTS.put(key, "preserve")
      expect((await call(instance, "discard", "POST", body)).status).toBe(200)
      expect(await profile(instance)).toEqual(successor)
      expect(await (await env.CHECKPOINTS.get(key))?.text()).toBe("preserve")
    })
  })

  it("retains workspace control intake identity when a command fails before its first POST", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("workspace-intake-" + crypto.randomUUID()), async (instance, runtime) => {
      const store = new ConversationStore(runtime.storage), eventID = "EvInitialReadFailed"
      expect(await store.claimEvent(eventID, "workspace")).toBe(true)
      // Command service read fails before preparing a destructive request.
      expect(await (await call(instance, "discard?requestID=" + crypto.randomUUID())).json()).toEqual({ discard: null })
      expect((await core(instance).legacyCleanup("reset")).status).toBe(200)
      const later = await mode(instance, "disposable", "Later workspace")
      expect(await store.claimEvent(eventID, "workspace")).toBe(false)
      expect(await profile(instance)).toEqual(later)
      // A new harmless preference event remains compatible with fresh binding.
      expect(await store.claimEvent("EvNewPreference", "workspace")).toBe(true)
      const binding = await instance.fetch(new Request("https://conversation/workspace/repository", { method: "PUT", body: JSON.stringify({ repository: "https://github.com/example/new", baseBranch: "main", workingBranch: "task/new" }) }))
      expect(binding.status).toBe(201)
    })
  })

  it("a refused legacy reset publishes no maintenance intent", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("workspace-reset-" + crypto.randomUUID()), async (instance, runtime) => {
      const store = new ConversationStore(runtime.storage), p = await mode(instance, "disposable")
      await store.patch({ phase: "running" })
      expect((await core(instance).legacyCleanup("reset")).status).toBe(409)
      expect(await core(instance).hasPending()).toBe(false)
      expect(await profile(instance)).toEqual(p)
      await store.patch({ phase: "idle" })
      expect((await core(instance).legacyCleanup("reset")).status).toBe(200)
      expect((await profile(instance)).profileID).not.toBe(p.profileID)
    })
  })
})
