import { beforeEach, describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import worker from "../src/index"
import type { Env } from "../src/env"
import type { Conversation } from "../src/conversation"
import { ConversationStore } from "../src/state"
import { workspaceCheckObjectOID } from "../src/workspace-check-snapshot"
import { parseWorkspaceCheckCollectorClaim, parseWorkspaceCheckExecution, type WorkspaceCheckCollectorClaim } from "../src/workspace-check-dispatch"
import type { WorkspaceCheckLocalReceipt } from "../src/workspace-check"
import type { ConversationWorkspaceCheckDispatcher } from "../src/conversation/workspace-check-dispatcher"
import { runtimeCache } from "./helpers/runtime-cache"

const token = "test-collector-capability-distinct-0123456789"
const collectorID = "22222222-2222-4222-8222-222222222222"
const imageID = `sha256:${"1".repeat(64)}`
const channel = "CARFINTEST"
const config = { CHECK_COLLECTOR_TOKEN: token, CHECK_COLLECTOR_ID: collectorID, CHECK_RUNNER_IMAGE_ID: imageID, CHECK_RUNNER_PLATFORM: "linux/amd64", CHECK_RUNNER_TIMEOUT_MS: "1000", CHECK_SLACK_CHANNEL_ID: channel }
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
const enc = new TextEncoder()
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
async function hash(value: string): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value)))].map(byte => byte.toString(16).padStart(2, "0")).join("") }
function api(path: string, method = "GET", body?: unknown, auth = headers, extra: Partial<Env> = {}) {
  return worker.fetch(new Request(`https://harness.test/api/check-collector/${path}`, { method, headers: auth,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { ...env, ...config, ...extra } as Env, { waitUntil() {} } as unknown as ExecutionContext)
}
function dispatcher(instance: Conversation): ConversationWorkspaceCheckDispatcher { return Reflect.get(instance, "checkDispatcher") }
async function fixture(instance: Conversation, state: DurableObjectState) {
  Object.assign(Reflect.get(instance, "env"), config)
  const store = new ConversationStore(state.storage)
  const selected = await store.selectWorkspaceRepository({ repository: "https://github.com/example/dispatch-fixture", baseBranch: "main", workingBranch: "task/check" }, crypto.randomUUID())
  const binding = { ...selected.binding!, status: "bound" as const, baseCommit: "a".repeat(40) }
  await store.acknowledgeWorkspaceRepository(binding)
  const blob = enc.encode("trusted synthetic source\n"), blobOID = await workspaceCheckObjectOID("blob", blob, "SHA-1")
  const prefix = enc.encode("100644 file.txt\0"), tree = new Uint8Array(prefix.length + 20)
  tree.set(prefix); tree.set(Uint8Array.from(blobOID.match(/../g)!, value => parseInt(value, 16)), prefix.length)
  const treeOID = await workspaceCheckObjectOID("tree", tree, "SHA-1")
  const commit = enc.encode(`tree ${treeOID}\nauthor Fixture <f@example.invalid> 1 +0000\ncommitter Fixture <f@example.invalid> 1 +0000\n\nfixture\n`)
  const commitOID = await workspaceCheckObjectOID("commit", commit, "SHA-1")
  const graph = { schemaVersion: 1, mode: "committed_only", worktreeChanges: "unverified", workspaceRepository: binding, commit: commitOID, tree: treeOID,
    objects: [{ oid: commitOID, type: "commit", contentBase64: b64(commit) }, { oid: treeOID, type: "tree", contentBase64: b64(tree) }, { oid: blobOID, type: "blob", contentBase64: b64(blob) }] }
  const calls: string[] = [], messages: { channel: string; replyTs?: string; text: string }[] = []
  let failNotify = false, schedules = 0
  instance.transport = port => ({ async fetch(input, init) {
    const req = input instanceof Request ? input : new Request(input, init), path = new URL(req.url).pathname
    calls.push(`${port} ${path}`)
    if (path === "/workspace/checks/head") return Response.json({ ...graph, objects: undefined })
    if (path === "/workspace/checks/snapshot") return Response.json(graph)
    throw new Error("No preparation/session/provider/checkpoint operation is allowed")
  } })
  await Reflect.get(instance, "controlPlane").token()
  runtimeCache(instance).markVerified(instance.transport(4000), "test-generation", true)
  const service = dispatcher(instance), options = Reflect.get(service, "options"), realSchedule = options.schedule
  options.schedule = async () => { schedules++ }
  options.notify = async (target: { channel: string; replyTs?: string }, text: string) => { messages.push({ ...target, text }); return !failNotify }
  return { service, store, calls, messages, graph, realSchedule, schedules: () => schedules, failNotify(value: boolean) { failNotify = value } }
}
async function queue(key: string, eventID = "event-check") {
  await runInDurableObject(env.CONVERSATION.getByName(key), async (instance, state) => {
    const f = await fixture(instance, state)
    expect(await f.service.queue(["bun", "--no-env-file", "--no-install", "test"], { channel, replyTs: "100.1" }, eventID)).toContain("queued")
    expect(f.calls).toEqual(["4001 /workspace/checks/head", "4001 /workspace/checks/snapshot"])
  })
}
async function claim(key: string, claimRequestID = crypto.randomUUID()): Promise<WorkspaceCheckCollectorClaim> {
  const result = await api(`conversations/${key}/claim`, "POST", { collectorID, claimRequestID, imageID })
  expect(result.status).toBe(200)
  return parseWorkspaceCheckCollectorClaim((await result.json() as { claim: unknown }).claim)
}
async function completion(claim: WorkspaceCheckCollectorClaim, cleanup = true) {
  const empty = { sha256: await hash(""), bytes: 0, capturedBytes: 0, truncated: false }
  const intent = claim.workspaceCheck, now = Date.now()
  const receipt: WorkspaceCheckLocalReceipt = { schemaVersion: 1, mode: "committed_only", provenance: "local_operator", request: {
    requestID: intent.requestID, expectedBindingID: intent.expectedBindingID, commitOID: intent.commitOID, argv: intent.argv, imageID: intent.imageID, timeoutMs: intent.timeoutMs,
  }, binding: intent.binding, treeOID: intent.source!.treeOID, sourceSHA256: intent.source!.sourceSHA256, platform: "linux/amd64", startedAt: now, finishedAt: now,
    outcome: cleanup ? "passed" : "cleanup_unknown", exitCode: 0, cleanupConfirmed: cleanup, freshness: { before: "matched", after: "matched" },
    worktreeChanges: "unverified", baselineChecks: "not_run", testOrConfigChanges: "not_evaluated", logs: { stdout: empty, stderr: empty } }
  return { collectorID: claim.collectorID, claimRequestID: claim.claimRequestID, attemptID: claim.attemptID, receipt, logs: { stdoutBase64: "", stderrBase64: "" } }
}

beforeEach(async () => { await runInDurableObject(env.SETTINGS.getByName("global"), async (_instance, state) => state.storage.deleteAll()) })

describe("trusted workspace check dispatch", () => {
  it("keeps ordinary API/Slack authority out of collector routes and rejects equal capabilities", async () => {
    expect((await api("pending", "GET", undefined, { authorization: "Bearer test-token", "content-type": "application/json" })).status).toBe(401)
    expect((await api("pending", "GET", undefined, headers, { API_TOKEN: token })).status).toBe(503)
    const result = await api("pending")
    expect(result.status).toBe(200); expect(await result.json()).toEqual({ pending: [], owner: null, nextCursor: null })
    await runInDurableObject(env.SETTINGS.getByName("global"), async (_instance, state) => expect((await state.storage.list()).size).toBe(0))
  })

  it("queues warm source once, freezes Slack target and exposes passive status", async () => {
    const key = "dispatch-queue"
    await runInDurableObject(env.CONVERSATION.getByName(key), async (instance, state) => {
      const f = await fixture(instance, state)
      const first = await f.service.queue(["bun", "test"], { channel, replyTs: "100.1" }, "same-event")
      runtimeCache(instance).resetAfterStop()
      expect(await f.service.queue(["bun", "test"], { channel, replyTs: "100.1" }, "same-event")).toBe(first)
      await expect(f.service.queue(["bun", "other"], { channel, replyTs: "100.1" }, "same-event")).rejects.toThrow()
      await expect(f.service.queue(["bun", "test"], { channel: "COTHER", replyTs: "100.1" }, "same-event")).rejects.toThrow()
      expect(f.calls.length).toBe(2)
      expect(await f.service.status()).toContain("queued")
      expect((await state.storage.list({ prefix: "workspaceCheckExecution:" })).size).toBe(1)
      expect(f.schedules()).toBe(0)
    })
    const pending = await api("pending")
    expect((await pending.json() as { pending: unknown[] }).pending).toHaveLength(1)
  })

  it("refuses cold Slack checks without intent, preparation, sessions or provider work", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("dispatch-cold-slack"), async (instance, state) => {
      const f = await fixture(instance, state)
      runtimeCache(instance).resetAfterStop()
      const adapter = Reflect.get(instance, "slackAdapter"), replies: string[] = []
      adapter.postChunked = async (_channel: string, text: string) => { replies.push(text) }
      adapter.slack = async () => ({ ok: true, messages: [] })
      const result = await instance.fetch(new Request("https://conversation/slack", { method: "POST", body: JSON.stringify({
        eventID: "cold-check", replyTs: "100.1", event: { type: "app_mention", channel, ts: "100.2", text: "!check" },
      }) }))
      expect(result.status).toBe(200)
      expect(replies.join("\n")).toContain("workspace is not warm")
      expect(f.calls).toEqual([])
      expect((await state.storage.list({ prefix: "workspaceCheck:" })).size).toBe(0)
      expect((await state.storage.list({ prefix: "workspaceCheckExecution:" })).size).toBe(0)
      expect((await f.store.get()).budgetReservation).toBeUndefined()
    })
  })

  it("publishes the notification wake through the actual Lifecycle durable job queue", async () => {
    const key = "dispatch-real-schedule"
    await runInDurableObject(env.CONVERSATION.getByName(key), async (instance, state) => {
      const f = await fixture(instance, state)
      Reflect.get(f.service, "options").schedule = f.realSchedule
      await f.service.queue(["bun", "test"], { channel, replyTs: "100.1" }, "scheduled-event")
    })
    const claimed = await claim(key), body = await completion(claimed)
    expect((await api(`conversations/${key}/attempts/${claimed.attemptID}/complete`, "POST", body)).status).toBe(200)
    await runInDurableObject(env.CONVERSATION.getByName(key), async instance => {
      const execution = await dispatcher(instance).get(claimed.workspaceCheck.requestID)
      const scheduler = Reflect.get(instance, "scheduler")
      expect(scheduler.has("check:notify") || execution?.notification.status === "delivered").toBe(true)
    })
  })

  it("never claims twice after lost acknowledgement and enforces one global owner without a TTL", async () => {
    await queue("dispatch-first"); await queue("dispatch-second")
    const nonce = crypto.randomUUID(), first = await claim("dispatch-first", nonce)
    expect(await claim("dispatch-first", nonce)).toEqual(first)
    const refused = await api("conversations/dispatch-second/claim", "POST", { collectorID, claimRequestID: crypto.randomUUID(), imageID })
    expect(refused.status).toBe(409)
    const pending = await (await api("pending")).json() as { pending: { status: string; attemptID: string }[]; owner: unknown }
    expect(pending.pending.some(row => row.status === "claimed" && row.attemptID === first.attemptID)).toBe(true)
    expect(pending.owner).not.toBeNull()
    await runInDurableObject(env.CONVERSATION.getByName("dispatch-first"), async instance => expect((await instance.fetch(new Request("https://conversation/reset", { method: "POST" }))).status).toBe(409))
  })

  it("rejects injected receipts/logs, encrypts accepted captured logs and makes completion retry exact", async () => {
    const key = "dispatch-complete"; await queue(key)
    const claimed = await claim(key), body = await completion(claimed), path = `conversations/${key}/attempts/${claimed.attemptID}`
    expect((await api(path + "/source")).status).toBe(200)
    expect((await api(path + "/complete", "POST", { ...body, receipt: { ...body.receipt, sourceSHA256: "f".repeat(64) } })).status).toBe(409)
    expect((await api(path + "/complete", "POST", { ...body, logs: { stdoutBase64: "eA==", stderrBase64: "" } })).status).toBe(409)
    expect((await api(path + "/complete", "POST", { ...body, receipt: { ...body.receipt, freshness: { before: "unknown", after: "matched" } } })).status).toBe(409)
    const accepted = await api(path + "/complete", "POST", body)
    expect(accepted.status).toBe(200)
    const execution = parseWorkspaceCheckExecution((await accepted.json() as { execution: unknown }).execution)
    expect(execution.receipt?.outcome).toBe("passed")
    expect(execution.target).toEqual({ channel, replyTs: "100.1" })
    const publicStatus = await worker.fetch(new Request(`https://harness.test/api/conversations/${key}/workspace/checks/${execution.requestID}`, { headers: { authorization: "Bearer test-token" } }), env, { waitUntil() {} } as unknown as ExecutionContext)
    expect(publicStatus.status).toBe(200)
    const publicBody = await publicStatus.json() as { workspaceCheck: { checksNotRun: boolean }; execution: { status: string } }
    expect(publicBody.workspaceCheck.checksNotRun).toBe(true)
    expect(publicBody.execution.status).toBe("completed")
    const logObject = await env.CHECKPOINTS.get(execution.logs!.key)
    expect(logObject?.customMetadata?.encrypted).toBe("1")
    expect(await logObject!.text()).not.toContain("stdoutBase64")
    expect((await api(path + "/complete", "POST", body)).status).toBe(200)
    expect((await api(path + "/complete", "POST", { ...body, receipt: { ...body.receipt, outcome: "failed", exitCode: 1 } })).status).toBe(409)
    expect((await (await api("pending")).json() as { owner: unknown }).owner).toBeNull()
  })

  it("accepts the configured native arm64 collector and rejects an architecture mismatch for the same frozen image", async () => {
    const key = "dispatch-platform-arm64"; await queue(key)
    await runInDurableObject(env.CONVERSATION.getByName(key), async instance => {
      Reflect.set(Reflect.get(instance, "env"), "CHECK_RUNNER_PLATFORM", "linux/arm64")
    })
    const claimed = await claim(key), body = await completion(claimed), path = `conversations/${key}/attempts/${claimed.attemptID}/complete`
    expect((await api(path, "POST", body)).status).toBe(409)
    expect((await api(path, "POST", { ...body, receipt: { ...body.receipt, platform: "linux/arm64" } })).status).toBe(200)
    expect((await api("pending", "GET", undefined, headers, { CHECK_RUNNER_PLATFORM: "darwin/arm64" })).status).toBe(503)
  })

  it("retains cleanup unknown, requires explicit separate-capability absence observation, never upgrades the result", async () => {
    const key = "dispatch-unknown"; await queue(key)
    const claimed = await claim(key), body = await completion(claimed, false), path = `conversations/${key}/attempts/${claimed.attemptID}`
    expect((await api(path + "/complete", "POST", body)).status).toBe(200)
    expect((await (await api("pending")).json() as { owner: unknown }).owner).not.toBeNull()
    expect(await claim(key, claimed.claimRequestID)).toEqual(claimed)
    const observation = { collectorID, claimRequestID: claimed.claimRequestID, attemptID: claimed.attemptID, cleanupConfirmed: true }
    expect((await api(path + "/reconcile", "POST", observation, { authorization: "Bearer test-token", "content-type": "application/json" })).status).toBe(401)
    expect((await api(path + "/reconcile", "POST", { ...observation, claimRequestID: crypto.randomUUID() })).status).toBe(409)
    const reconciled = await api(path + "/reconcile", "POST", observation)
    expect(reconciled.status).toBe(200)
    const execution = parseWorkspaceCheckExecution((await reconciled.json() as { execution: unknown }).execution)
    expect(execution.receipt).toEqual(body.receipt); expect(execution.cleanupReconciledAt).not.toBeNull()
    expect((await api(path + "/reconcile", "POST", observation)).status).toBe(200)
    expect((await (await api("pending")).json() as { owner: unknown }).owner).toBeNull()
  })

  it("recovers an R2 log put with a lost acknowledgement without changing source or issuing a second attempt", async () => {
    const key = "dispatch-lost-log-ack"; await queue(key)
    const claimed = await claim(key), body = await completion(claimed), path = `conversations/${key}/attempts/${claimed.attemptID}/complete`
    let puts = 0
    await runInDurableObject(env.CONVERSATION.getByName(key), async instance => {
      const options = Reflect.get(dispatcher(instance), "options"), original = options.bucket as R2Bucket
      options.bucket = { get: original.get.bind(original), put: async (...args: Parameters<R2Bucket["put"]>) => {
        puts++; await original.put(...args); throw new Error("synthetic lost storage acknowledgement")
      } }
    })
    expect((await api(path, "POST", body)).status).toBe(503)
    expect((await api(path, "POST", body)).status).toBe(200)
    expect(puts).toBe(1)
    await runInDurableObject(env.CONVERSATION.getByName(key), async instance => expect((await dispatcher(instance).get(claimed.workspaceCheck.requestID))?.attempt?.attemptID).toBe(claimed.attemptID))
  })

  it("retains a global owner before actor acknowledgement and releases it only on definitive same-nonce no-claim", async () => {
    const owner = { conversationKey: "dispatch-no-actor-ack", collectorID, claimRequestID: crypto.randomUUID(), imageID, claimedAt: Date.now() }
    expect((await env.SETTINGS.getByName("global").fetch("https://settings/check-collector-owner/acquire", { method: "POST", body: JSON.stringify(owner) })).status).toBe(200)
    expect((await (await api("pending")).json() as { owner: unknown }).owner).toEqual(owner)
    const retry = await api(`conversations/${owner.conversationKey}/claim`, "POST", { collectorID, claimRequestID: owner.claimRequestID, imageID })
    expect(await retry.json()).toEqual({ claim: null })
    expect((await (await api("pending")).json() as { owner: unknown }).owner).toBeNull()
  })

  it("retries only Slack delivery after completion, preserving the persisted thread and execution count", async () => {
    const key = "dispatch-notify"; await queue(key)
    const claimed = await claim(key), body = await completion(claimed)
    expect((await api(`conversations/${key}/attempts/${claimed.attemptID}/complete`, "POST", body)).status).toBe(200)
    await runInDurableObject(env.CONVERSATION.getByName(key), async (instance, state) => {
      const service = dispatcher(instance), options = Reflect.get(service, "options"), realSchedule = options.schedule, messages: unknown[] = []
      let succeeds = false
      options.notify = async (target: unknown, text: string) => { messages.push({ target, text }); return succeeds }
      expect(await service.notify()).toHaveProperty("rescheduleAt")
      const execution = (await service.get(claimed.workspaceCheck.requestID))!
      expect(execution.status).toBe("completed"); expect(execution.notification.status).toBe("pending")
      await state.storage.put("workspaceCheckExecution:" + execution.requestID, { ...execution, notification: { ...execution.notification, nextAttemptAt: 0 } })
      succeeds = true
      expect(await service.notify()).toBeUndefined()
      expect((await service.get(execution.requestID))?.notification.status).toBe("delivered")
      expect(messages).toHaveLength(2)
      expect(JSON.stringify(messages)).toContain("100.1"); expect(JSON.stringify(messages)).not.toContain("@here")
      expect((await state.storage.list({ prefix: "workspaceCheckExecution:" })).size).toBe(1)
    })
  })
})
