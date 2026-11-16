import { beforeEach, describe, expect, it } from "vitest"
import { env, runInDurableObject, SELF } from "cloudflare:test"
import type { Conversation } from "../src/conversation"
import { ConversationStore } from "../src/state"
import type { WorkspaceCheckIntent, WorkspaceCheckRequest } from "../src/workspace-check"
import type { WorkspaceRepositoryReceipt } from "../src/workspace-repository"
import { workspaceCheckObjectOID, verifyWorkspaceCheckSnapshot, type WorkspaceCheckSnapshot } from "../src/workspace-check-snapshot"
import { readWorkspaceCheckBytes } from "../src/conversation/workspace-checks"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"
import { runtimeCache } from "./helpers/runtime-cache"
import type { ContainerPort } from "../src/opencode"
import type { ConversationRuntimeAccess } from "../src/conversation/runtime-access"

const API = { authorization: "Bearer test-token", "content-type": "application/json" }
const PATH = "/workspace/checks"
const encoder = new TextEncoder()
function base64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)) }
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function internal(instance: Conversation) {
  return instance as unknown as {
    ctx: object
    runtimeAccess: ConversationRuntimeAccess
    ensureReadyOwned(): Promise<ContainerPort>
    checkpoints: { captureOwned(): Promise<boolean> }
    env: { VAULT_MASTER_KEY?: string; ALLOW_PLAINTEXT_ARCHIVES?: string }
    controlPlane: { token(): Promise<string> }
    workspaceChecks: { options: { bucket: R2Bucket }; exported(intent: WorkspaceCheckIntent, source: unknown): Promise<WorkspaceCheckIntent> }
  }
}

async function graph(binding: WorkspaceRepositoryReceipt): Promise<WorkspaceCheckSnapshot> {
  const blob = encoder.encode("synthetic committed source\n")
  const blobOID = await workspaceCheckObjectOID("blob", blob, "SHA-1")
  const prefix = encoder.encode("100644 check.txt\0")
  const tree = new Uint8Array(prefix.length + 20)
  tree.set(prefix); tree.set(Uint8Array.from(blobOID.match(/../g)!, value => parseInt(value, 16)), prefix.length)
  const treeOID = await workspaceCheckObjectOID("tree", tree, "SHA-1")
  const commit = encoder.encode(`tree ${treeOID}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nfixture\n`)
  const commitOID = await workspaceCheckObjectOID("commit", commit, "SHA-1")
  return { schemaVersion: 1, mode: "committed_only", worktreeChanges: "unverified", workspaceRepository: binding, commit: commitOID, tree: treeOID,
    objects: [{ oid: commitOID, type: "commit", contentBase64: base64(commit) }, { oid: treeOID, type: "tree", contentBase64: base64(tree) }, { oid: blobOID, type: "blob", contentBase64: base64(blob) }] }
}

async function fixture(instance: Conversation, state: DurableObjectState) {
  const store = new ConversationStore(state.storage)
  const selection = { repository: "https://github.com/example/check-fixture", baseBranch: "main", workingBranch: "task/check" }
  const selected = await store.selectWorkspaceRepository(selection, crypto.randomUUID())
  const binding: WorkspaceRepositoryReceipt = { ...selected.binding!, status: "bound", baseCommit: "a".repeat(40) }
  expect(await store.acknowledgeWorkspaceRepository(binding)).toBe(true)
  const snapshot = await graph(binding)
  const request: WorkspaceCheckRequest = { requestID: crypto.randomUUID(), expectedBindingID: binding.bindingID, commitOID: snapshot.commit,
    argv: ["bun", "test"], imageID: `sha256:${"1".repeat(64)}`, timeoutMs: 1000 }
  const calls: string[] = []
  let snapshots = 0, starts = 0, head = snapshot.commit, headAvailable = true, snapshotStatus = 200
  instance.transport = port => ({ async fetch(input: Request | string | URL, init?: RequestInit) {
    const inputRequest = input instanceof Request ? input : new Request(input, init)
    const path = new URL(inputRequest.url).pathname
    calls.push(`${port} ${inputRequest.method} ${path}`)
    if (path === "/status") return Response.json({ initialized: true })
    if (path === "/configure") return Response.json({ ok: true })
    if (path === "/start") { starts++; return Response.json({ ...accountingPolicyStart, workspaceRepository: binding }) }
    if (path === "/api/config") return Response.json(accountingPolicyConfig)
    if (path === "/workspace/checks/snapshot") {
      snapshots++
      // Intent must be durable before the first readonly native export.
      expect((await state.storage.list({ prefix: "workspaceCheck:" })).size).toBeGreaterThan(0)
      expect(await inputRequest.json()).toEqual({ workspaceRepository: binding, commit: snapshot.commit })
      return Response.json(snapshotStatus === 200 ? snapshot : { error: "synthetic refusal" }, { status: snapshotStatus })
    }
    if (path === "/workspace/checks/head") {
      expect(await inputRequest.json()).toEqual({ workspaceRepository: binding })
      return Response.json({ workspaceRepository: binding, commit: head, tree: snapshot.tree, mode: "committed_only", worktreeChanges: "unverified" }, { status: headAvailable ? 200 : 503 })
    }
    throw new Error("unexpected session/provider/control operation")
  } })
  await internal(instance).controlPlane.token()
  runtimeCache(instance).markVerified(instance.transport(4000), "test-opencode-generation", true)
  return { store, binding, snapshot, request, calls, snapshots: () => snapshots, starts: () => starts,
    setHead(value: string) { head = value }, setHeadAvailable(value: boolean) { headAvailable = value }, setSnapshotStatus(value: number) { snapshotStatus = value } }
}

function create(instance: Conversation, request: WorkspaceCheckRequest) {
  return instance.fetch(new Request(`https://conversation${PATH}`, { method: "POST", body: JSON.stringify(request) }))
}
function get(instance: Conversation, id: string, suffix = "") {
  return instance.fetch(new Request(`https://conversation${PATH}/${id}${suffix}`))
}

beforeEach(async () => {
  await runInDurableObject(env.SETTINGS.getByName("global"), async (_instance, state) => state.storage.deleteAll())
  await env.SETTINGS.getByName("global").fetch("https://settings/put", { method: "POST", body: JSON.stringify({ streaming: false, dailyBudgetUSD: 0 }) })
})

describe("immutable workspace check exports", () => {
  it("authenticates and keeps status/source/freshness and unsupported methods passive", async () => {
    const id = crypto.randomUUID(), key = "checks-public-cold"
    const url = `https://harness.test/api/conversations/${key}${PATH}`
    expect((await SELF.fetch(`${url}/${id}`)).status).toBe(401)
    expect((await SELF.fetch("https://harness.test/api/conversations/bad%2Fkey/workspace/checks", { method: "POST", headers: API, body: "{}" })).status).toBe(400)
    const before = await (await env.SETTINGS.getByName("global").fetch("https://settings/conversations")).json()
    for (const suffix of ["", "/source", "/freshness"]) expect((await SELF.fetch(`${url}/${id}${suffix}`, { headers: API })).status).toBe(404)
    const method = await SELF.fetch(`${url}/${id}`, { method: "POST", headers: API, body: JSON.stringify({ outcome: "passed" }) })
    expect(method.status).toBe(405)
    expect(method.headers.get("allow")).toBe("GET")
    expect((await SELF.fetch(`${url}/${id}/result`, { method: "POST", headers: API, body: "{}" })).status).toBe(404)
    await runInDurableObject(env.CONVERSATION.getByName(key), async (_instance, state) => {
      expect((await state.storage.list()).size).toBe(0)
      expect(await state.storage.getAlarm()).toBeNull()
    })
    expect(await (await env.SETTINGS.getByName("global").fetch("https://settings/conversations")).json()).toEqual(before)
  })

  it("exports through the public API with encrypted storage, exact source identity and no session/provider", async () => {
    const key = "checks-public-export"
    let request!: WorkspaceCheckRequest
    await runInDurableObject(env.CONVERSATION.getByName(key), async (instance, state) => { request = (await fixture(instance, state)).request })
    const url = `https://harness.test/api/conversations/${key}${PATH}`
    const response = await SELF.fetch(url, { method: "POST", headers: API, body: JSON.stringify(request) })
    expect(response.status).toBe(201)
    const intent = (await response.json() as { workspaceCheck: WorkspaceCheckIntent }).workspaceCheck
    expect(intent).toMatchObject({ ...request, status: "exported", mode: "committed_only", checksNotRun: true, worktreeChanges: "unverified" })
    const sourceResponse = await SELF.fetch(`${url}/${request.requestID}/source`, { headers: API })
    expect(sourceResponse.headers.get("cache-control")).toBe("no-store")
    const source = await verifyWorkspaceCheckSnapshot(await sourceResponse.json())
    expect(source.commit).toBe(request.commitOID)
    expect(source.snapshotSHA256).toBe(intent.source?.sourceSHA256)
    await runInDurableObject(env.CONVERSATION.getByName(key), async (_instance, state) => {
      const object = await env.CHECKPOINTS.get(`workspaces/${state.id.toString()}/checks/${request.requestID}.json`)
      expect(object?.customMetadata?.encrypted).toBe("1")
      expect(new TextDecoder().decode(await object!.arrayBuffer())).not.toContain("synthetic committed source")
      expect((await new ConversationStore(state.storage).get()).budgetReservation).toBeUndefined()
      expect((await new ConversationStore(state.storage).get()).sessionID).toBeUndefined()
    })
  })

  it("does not enter normal preparation or checkpoint paths when settings changed on a warm workspace", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("checks-no-settings-application"), async (instance, state) => {
      const f = await fixture(instance, state)
      const settings = env.SETTINGS.getByName("global")
      const version = (await (await settings.fetch("https://settings/get")).json() as { version: number }).version
      await f.store.patch({ settingsVersion: version })
      await settings.fetch("https://settings/put", { method: "POST", body: JSON.stringify({ workspaceBranch: "changed-global-base" }) })
      let inactivity = 0
      Object.defineProperty(internal(instance).ctx, "container", { configurable: true, value: {
        running: true, images: { base: "registry.invalid/base", evented: "registry.invalid/evented" },
        async setInactivityTimeout() { inactivity++ },
      } })
      runtimeCache(instance).markVerified(instance.transport!(4000), "test-opencode-generation", true)
      let prepares = 0, checkpoints = 0
      const originalPrepare = internal(instance).ensureReadyOwned.bind(instance)
      internal(instance).ensureReadyOwned = async () => { prepares++; return originalPrepare() }
      internal(instance).checkpoints.captureOwned = async () => { checkpoints++; throw new Error("legacy checkpoint entered") }
      const epoch = internal(instance).runtimeAccess.activityEpoch
      const response = await create(instance, f.request)
      expect(checkpoints).toBe(0)
      expect(prepares).toBe(0)
      expect(response.status).toBe(201)
      expect(inactivity).toBe(0)
      expect(internal(instance).runtimeAccess.activityEpoch).toBe(epoch)
      expect(f.calls).toEqual(["4001 POST /workspace/checks/snapshot"])
    })
  })

  it("refuses a cold bound runtime before creating intent without preparing or starting anything", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("checks-cold-bound"), async (instance, state) => {
      const f = await fixture(instance, state)
      runtimeCache(instance).invalidate()
      let prepares = 0
      internal(instance).ensureReadyOwned = async () => { prepares++; throw new Error("preparation is forbidden") }
      const response = await create(instance, f.request)
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ code: "WORKSPACE_CHECK_RUNTIME_NOT_WARM" })
      expect(prepares).toBe(0)
      expect(f.calls).toEqual([])
      expect(f.starts()).toBe(0)
      expect((await state.storage.list({ prefix: "workspaceCheck:" })).size).toBe(0)
      expect((await env.CHECKPOINTS.list({ prefix: `workspaces/${state.id.toString()}/checks/` })).objects).toEqual([])
    })
  })

  it("serializes identical retries and rejects a changed command without exporting again", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("checks-retries"), async (instance, state) => {
      const f = await fixture(instance, state)
      const [one, two] = await Promise.all([create(instance, f.request), create(instance, f.request)])
      expect([one.status, two.status].sort()).toEqual([200, 201])
      expect(await one.json()).toEqual(await two.json())
      expect(f.snapshots()).toBe(1)
      expect((await create(instance, { ...f.request, argv: ["bun", "different"] })).status).toBe(409)
      expect(f.snapshots()).toBe(1)
      runtimeCache(instance).invalidate()
      const count = f.calls.length
      expect((await create(instance, f.request)).status).toBe(200)
      expect(f.calls).toHaveLength(count)
    })
  })

  it("refuses unbound, pending, busy or wrong-binding workspaces without native export", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("checks-unbound"), async (instance, state) => {
      const request = { requestID: crypto.randomUUID(), expectedBindingID: crypto.randomUUID(), commitOID: "a".repeat(40), argv: ["true"], imageID: `sha256:${"1".repeat(64)}`, timeoutMs: 1000 }
      expect((await create(instance, request)).status).toBe(409)
      expect((await state.storage.list()).size).toBe(0)
    })
    for (const kind of ["busy", "hold", "queue", "wrong-binding"]) await runInDurableObject(env.CONVERSATION.getByName(`checks-refuse-${kind}`), async (instance, state) => {
      const f = await fixture(instance, state)
      if (kind === "busy") await f.store.patch({ phase: "running" })
      if (kind === "hold") await f.store.patch({ budgetReservation: { reservationID: "existing", dispatched: false } })
      if (kind === "queue") await f.store.enqueue({ id: "queued", enqueuedAt: Date.now(), source: "http", text: "pending", attempts: 0 }, 10)
      const request = kind === "wrong-binding" ? { ...f.request, expectedBindingID: crypto.randomUUID() } : f.request
      expect((await create(instance, request)).status).toBe(409)
      expect(f.calls).toEqual([])
      expect((await state.storage.list({ prefix: "workspaceCheck:" })).size).toBe(0)
    })
  })

  it("never permits plaintext exports even when legacy plaintext archives are enabled", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("checks-encryption"), async (instance, state) => {
      const f = await fixture(instance, state)
      // Exercise the actual legacy archive policy; the checks path must refuse
      // cryptoKey() returning undefined rather than export plaintext.
      const options = internal(instance).workspaceChecks.options as unknown as { checkpoints: { options: { archiveEnv: { VAULT_MASTER_KEY?: string; ALLOW_PLAINTEXT_ARCHIVES?: string } } } }
      const original = options.checkpoints.options.archiveEnv
      options.checkpoints.options.archiveEnv = { ALLOW_PLAINTEXT_ARCHIVES: "1" }
      try {
        expect((await create(instance, f.request)).status).toBe(503)
        expect(f.snapshots()).toBe(0)
        expect(await env.CHECKPOINTS.head(`workspaces/${state.id.toString()}/checks/${f.request.requestID}.json`)).toBeNull()
      } finally { options.checkpoints.options.archiveEnv = original }
    })
  })

  it("reconciles a lost object-write acknowledgement without a second native export", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("checks-r2-lost-ack"), async (instance, state) => {
      const f = await fixture(instance, state)
      const options = internal(instance).workspaceChecks.options
      const bucket = options.bucket
      let lost = true
      options.bucket = new Proxy(bucket, { get(target, property) {
        if (property === "put") return async (...args: Parameters<R2Bucket["put"]>) => {
          const result = await bucket.put(...args)
          if (lost) { lost = false; throw new Error("synthetic lost storage acknowledgement") }
          return result
        }
        const value = Reflect.get(target, property, target)
        return typeof value === "function" ? value.bind(target) : value
      } })
      expect((await create(instance, f.request)).status).toBe(201)
      expect((await create(instance, f.request)).status).toBe(200)
      expect(f.snapshots()).toBe(1)
      expect((await get(instance, f.request.requestID, "/source")).status).toBe(200)
    })
  })

  it("retains exported status after a lost DO acknowledgement and rejects corrupt source without native work", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("checks-do-lost-ack"), async (instance, state) => {
      const f = await fixture(instance, state)
      const checks = internal(instance).workspaceChecks
      const exported = checks.exported.bind(checks)
      let lost = true
      checks.exported = async (intent, source) => {
        const value = await exported(intent, source)
        if (lost) { lost = false; throw new Error("synthetic lost DO acknowledgement") }
        return value
      }
      expect((await create(instance, f.request)).status).toBe(503)
      expect((await create(instance, f.request)).status).toBe(200)
      expect(f.snapshots()).toBe(1)
      const key = `workspaces/${state.id.toString()}/checks/${f.request.requestID}.json`
      const object = await env.CHECKPOINTS.get(key)
      await env.CHECKPOINTS.put(key, new Uint8Array([1, 2, 3]), { customMetadata: object!.customMetadata })
      runtimeCache(instance).invalidate()
      const calls = f.calls.length
      expect((await get(instance, f.request.requestID, "/source")).status).toBe(503)
      expect(f.calls).toHaveLength(calls)
    })
  })

  it("reconciles an already stored export while cold without preparing or re-exporting", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("checks-cold-recovery"), async (instance, state) => {
      const f = await fixture(instance, state)
      const checks = internal(instance).workspaceChecks
      const exported = checks.exported.bind(checks)
      let lost = true
      checks.exported = async (intent, source) => {
        if (lost) { lost = false; throw new Error("synthetic lost acknowledgement before intent update") }
        return exported(intent, source)
      }
      expect((await create(instance, f.request)).status).toBe(503)
      expect(await (await get(instance, f.request.requestID)).json()).toMatchObject({ workspaceCheck: { status: "requested" } })
      runtimeCache(instance).invalidate()
      const calls = f.calls.length
      internal(instance).ensureReadyOwned = async () => { throw new Error("preparation is forbidden") }
      expect((await create(instance, f.request)).status).toBe(200)
      expect((await get(instance, f.request.requestID, "/source")).status).toBe(200)
      expect(f.calls).toHaveLength(calls)
      expect(f.snapshots()).toBe(1)
    })
  })

  it("reports head movement separately, preserves historical bytes and reports cold/unavailable freshness unknown", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("checks-freshness"), async (instance, state) => {
      const f = await fixture(instance, state)
      expect((await create(instance, f.request)).status).toBe(201)
      const source = await (await get(instance, f.request.requestID, "/source")).text()
      expect(await (await get(instance, f.request.requestID, "/freshness")).json()).toMatchObject({ status: "current", worktreeChanges: "unverified" })
      f.setHead("b".repeat(40))
      expect(await (await get(instance, f.request.requestID, "/freshness")).json()).toMatchObject({ status: "stale", observedCommitOID: "b".repeat(40) })
      expect(await (await get(instance, f.request.requestID, "/source")).text()).toBe(source)
      f.setHeadAvailable(false)
      expect(await (await get(instance, f.request.requestID, "/freshness")).json()).toMatchObject({ status: "unknown" })
      runtimeCache(instance).invalidate()
      const calls = f.calls.length
      expect(await (await get(instance, f.request.requestID, "/freshness")).json()).toMatchObject({ status: "unknown" })
      expect(f.calls).toHaveLength(calls)
      expect(f.snapshots()).toBe(1)
    })
  })

  it("caps durable intents without pruning evidence and clears its rows in the existing guarded reset", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("checks-limit-reset"), async (instance, state) => {
      const f = await fixture(instance, state)
      for (let index = 0; index < 10; index++) expect((await create(instance, { ...f.request, requestID: crypto.randomUUID() })).status).toBe(201)
      expect((await create(instance, f.request)).status).toBe(429)
      expect((await state.storage.list({ prefix: "workspaceCheck:" })).size).toBe(10)
      const reset = await instance.fetch(new Request("https://conversation/reset", { method: "POST" }))
      expect(reset.status).toBe(200)
      expect((await state.storage.list({ prefix: "workspaceCheck:" })).size).toBe(0)
      expect((await env.CHECKPOINTS.list({ prefix: `workspaces/${state.id.toString()}/checks/` })).objects).toEqual([])
      const bind = await instance.fetch(new Request("https://conversation/workspace/repository", { method: "PUT", body: JSON.stringify({ repository: "https://github.com/example/new-task", baseBranch: "main", workingBranch: "task/new" }) }))
      expect(bind.status).toBe(201)
    })
  })

  it("retains a requested intent on snapshot refusal and does not accept caller result uploads", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("checks-refused-export"), async (instance, state) => {
      const f = await fixture(instance, state)
      f.setSnapshotStatus(409)
      expect((await create(instance, f.request)).status).toBe(409)
      expect(await (await get(instance, f.request.requestID)).json()).toMatchObject({ workspaceCheck: { status: "requested", checksNotRun: true } })
      expect((await get(instance, f.request.requestID, "/source")).status).toBe(409)
      expect((await instance.fetch(new Request(`https://conversation${PATH}/${f.request.requestID}`, { method: "POST", body: JSON.stringify({ outcome: "passed" }) }))).status).toBe(405)
    })
  })

  it("keeps reset fenced until an in-flight encrypted export finishes and cannot resurrect deleted intent/source", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("checks-reset-race"), async (instance, state) => {
      const f = await fixture(instance, state)
      const options = internal(instance).workspaceChecks.options
      const bucket = options.bucket
      const entered = deferred(), release = deferred()
      options.bucket = new Proxy(bucket, { get(target, property) {
        if (property === "put") return async (...args: Parameters<R2Bucket["put"]>) => {
          entered.resolve(); await release.promise
          return bucket.put(...args)
        }
        const value = Reflect.get(target, property, target)
        return typeof value === "function" ? value.bind(target) : value
      } })
      const exporting = create(instance, f.request)
      await entered.promise
      let resetFinished = false
      const resetting = instance.fetch(new Request("https://conversation/reset", { method: "POST" })).then(response => { resetFinished = true; return response })
      await Promise.resolve()
      expect(resetFinished).toBe(false)
      expect((await state.storage.list({ prefix: "workspaceCheck:" })).size).toBe(1)
      release.resolve()
      expect((await exporting).status).toBe(201)
      expect((await resetting).status).toBe(200)
      expect((await state.storage.list({ prefix: "workspaceCheck:" })).size).toBe(0)
      expect((await env.CHECKPOINTS.list({ prefix: `workspaces/${state.id.toString()}/checks/` })).objects).toEqual([])
      expect((await create(instance, f.request)).status).toBe(409)
      expect((await state.storage.list({ prefix: "workspaceCheck:" })).size).toBe(0)
    })
  })

  it("bounds stalled stream reads even when cancellation never resolves", async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return new Promise<void>(() => {}) } })
    await expect(readWorkspaceCheckBytes(stream, 1024, 10)).rejects.toMatchObject({ code: "WORKSPACE_CHECK_SOURCE_TIMEOUT" })
    expect(cancelled).toBe(true)
    await expect(readWorkspaceCheckBytes(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1025)) } }), 1024))
      .rejects.toMatchObject({ code: "WORKSPACE_CHECK_SIZE_LIMIT" })
  })
})
