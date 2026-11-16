import { beforeEach, describe, expect, it, vi } from "vitest"
import { env, runInDurableObject, SELF } from "cloudflare:test"
import { ConversationStore } from "../src/state"
import { runtimeCache } from "./helpers/runtime-cache"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"
import worker from "../src/index"
import type { Env } from "../src/env"
import type { Conversation } from "../src/conversation"
import type { CredentialEntry } from "@opencode/client"
import type { ConversationProviderRepair } from "../src/conversation/provider-repair"

const CHANNEL = "C0A5YNXLP6C", sourceID = "cred_new", oldID = "cred_old", oldKey = "FAKE_EXPIRED_KEY", newKey = "FAKE_REPLACEMENT_KEY"
const API = { authorization: "Bearer test-token", "content-type": "application/json" }
const credential = (id: string, key: string): CredentialEntry => ({ id, integrationID: "opencode", label: "Synthetic key", active: true, value: { type: "key", key } })
const service = (instance: Conversation) => Reflect.get(instance, "providerRepair") as ConversationProviderRepair
async function fixture(instance: Conversation, state: DurableObjectState) {
  Reflect.set(Reflect.get(instance, "env"), "SLACK_CANARY_CHANNEL", CHANNEL)
  const store = new ConversationStore(state.storage)
  const settings = await (await env.SETTINGS.getByName("global").fetch("https://settings/get")).json() as { version: number }
  await store.patch({ phase: "idle", sessionID: "ses_history", lastReply: "retained history", settingsVersion: settings.version })
  let credentials: CredentialEntry[] = [credential(oldID, oldKey), { ...credential("cred_custom_other", "FAKE_CUSTOM"), integrationID: "other" }]
  let history = ["retained-user", "retained-assistant-error"]
  let failAfterActivation = false
  let selected = oldID, initialized = true, checkpointFails = false, loseCreate = false, loseActivate = false, loseCompletion = false, created = 0, activated = 0
  const calls: string[] = []
  instance.transport = port => ({ async fetch(input, init) {
    const request = input instanceof Request ? input : new Request(input, init), url = new URL(request.url), path = url.pathname
    calls.push(`${port} ${request.method} ${path}`)
    if (path === "/health") return Response.json({ ok: true })
    if (port === 4001) {
      if (path === "/status") return Response.json({ initialized })
      if (path === "/configure") return Response.json({ ok: true })
      if (path === "/start") { initialized = true; return Response.json(accountingPolicyStart) }
      if (path === "/checkpoint") {
        if (checkpointFails && (!failAfterActivation || selected === sourceID)) return new Response("synthetic unavailable", { status: 503 })
        if (url.searchParams.get("part") === "state") return new Response(JSON.stringify({ credentials, selected, history }), { headers: { "x-state-fingerprint": "state-" + selected } })
        return new Response("fixture workspace archive", { headers: { "x-aboiteau-checkpoint": "split", "x-workspace-fingerprint": "workspace-preserved" } })
      }
      if (path === "/restore") {
        if (url.searchParams.get("part") === "state") {
          const restored = await request.json() as { credentials: CredentialEntry[]; selected: string; history: string[] }
          credentials = restored.credentials; selected = restored.selected; history = restored.history
        }
        return Response.json({ ok: true })
      }
      throw new Error("unexpected model-free control path")
    }
    if (path === "/api/config") return Response.json(accountingPolicyConfig)
    if (path === "/api/credential" && request.method === "GET") return Response.json({ data: credentials })
    if (path === "/api/integration/opencode") return Response.json({ data: { id: "opencode", connections: [{ type: "credential", id: selected, method: "key" }] } })
    if (path === "/api/credential" && request.method === "POST") {
      const body = await request.json() as CredentialEntry & { activate: boolean }
      expect(body.activate).toBe(false)
      credentials.push({ ...body, active: false }); created++
      if (loseCreate) { loseCreate = false; throw new Error("synthetic lost create acknowledgement") }
      return Response.json({ data: { ...body, active: false } })
    }
    if (path === `/api/credential/${sourceID}/activate` && request.method === "POST") {
      selected = sourceID; credentials = credentials.map(entry => entry.id === sourceID ? { ...entry, active: true } : entry); activated++
      if (loseActivate) { loseActivate = false; throw new Error("synthetic lost activation acknowledgement") }
      return new Response(null, { status: 204 })
    }
    throw new Error("unexpected session/provider operation")
  } })
  await Reflect.get(instance, "controlPlane").token()
  runtimeCache(instance).markVerified(instance.transport(4000), accountingPolicyStart.opencodeGeneration, true)
  const repair = service(instance), options = Reflect.get(repair, "options")
  options.source = async () => [credential("cred_other_active", "FAKE_OLD_SOURCE"), credential(sourceID, newKey)]
  return { store, repair, calls, credentials: () => credentials, selected: () => selected, history: () => history, creates: () => created, activations: () => activated,
    setSelected(id: string) { selected = id }, setCurrentKey(key: string) { credentials[0] = credential(oldID, key) }, setSource(key: string) { options.source = async () => [credential(sourceID, key)] },
    loseCreate() { loseCreate = true }, loseActivate() { loseActivate = true }, failCheckpoint(value: boolean, afterActivation = false) { checkpointFails = value; failAfterActivation = afterActivation },
    cold() { history = []; initialized = false; credentials = [credential(oldID, oldKey)]; selected = oldID; runtimeCache(instance).resetAfterStop() },
    loseCompletion() {
      loseCompletion = true
      const original = options.storage as DurableObjectStorage
      options.storage = new Proxy(original, { get(target, property) {
        if (property === "transaction") return async (callback: (transaction: DurableObjectTransaction) => Promise<unknown>) => {
          const result = await original.transaction(callback)
          if (loseCompletion && (await original.get<{ status: string }>("providerCredentialRepair:" + lastRequest))?.status === "complete") { loseCompletion = false; throw new Error("synthetic lost completion acknowledgement") }
          return result
        }
        const value = Reflect.get(target, property)
        return typeof value === "function" ? value.bind(target) : value
      } })
    },
  }
}
let lastRequest = ""
async function preview(instance: Conversation) {
  const response = await instance.fetch(new Request(`https://conversation/providers/repair?sourceCredentialID=${sourceID}`))
  expect(response.status).toBe(200)
  const body = await response.json() as { previewID: string; sourceCredentialID: string; expectedCurrentCredentialID: string }
  lastRequest = crypto.randomUUID()
  return { requestID: lastRequest, previewID: body.previewID, sourceCredentialID: body.sourceCredentialID, expectedCurrentCredentialID: body.expectedCurrentCredentialID }
}
const apply = (instance: Conversation, body: unknown) => instance.fetch(new Request("https://conversation/providers/repair", { method: "POST", body: JSON.stringify(body) }))
beforeEach(async () => {
  await runInDurableObject(env.SETTINGS.getByName("global"), async (_instance, state) => state.storage.deleteAll())
  await env.SETTINGS.getByName("global").fetch("https://settings/put", { method: "POST", body: JSON.stringify({ streaming: false, dailyBudgetUSD: 0 }) })
})

describe("scoped provider credential repair", () => {
  it("authenticates public repair, restricts the canary thread and preserves method handling", async () => {
    const path = "https://harness.test/api/conversations/other-thread/providers/repair?sourceCredentialID=" + sourceID
    expect((await SELF.fetch(path)).status).toBe(401)
    expect((await SELF.fetch(path, { headers: API })).status).toBe(404)
    expect((await SELF.fetch(path, { method: "PUT", headers: API, body: "{}" })).status).toBe(405)
  })

  it("validates OpenCode keys at the issuer before the authenticated onboarding proxy mutates a runtime", async () => {
    let upstreamStatus = 401, proxies = 0
    const issuer = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const request = input instanceof Request ? input : new Request(input)
      expect(request.url).toBe("https://opencode.ai/inference/v1/models")
      expect(request.method).toBe("GET"); expect(request.redirect).toBe("manual")
      return Response.json(upstreamStatus === 200 ? { data: [{ id: "fixture/model" }] } : { error: { code: "api_key_expired", message: "FAKE_KEY_MUST_NOT_LEAK" } }, { status: upstreamStatus })
    })
    const fakeEnv = { ...env, CONVERSATION: { getByName() { return { async fetch() { proxies++; return Response.json(null) } } } } } as unknown as Env
    const url = "https://harness.test/api/onboarding/opencode/integrations/opencode/connect/key"
    const context = { waitUntil() {} } as unknown as ExecutionContext
    try {
      expect((await worker.fetch(new Request(url, { method: "POST", body: JSON.stringify({ key: "FAKE_KEY" }) }), fakeEnv, context)).status).toBe(401)
      expect(issuer).not.toHaveBeenCalled()
      const rejected = await worker.fetch(new Request(url, { method: "POST", headers: API, body: JSON.stringify({ key: "FAKE_KEY" }) }), fakeEnv, context)
      expect(rejected.status).toBe(400); expect(proxies).toBe(0)
      expect(await rejected.text()).not.toContain("FAKE_KEY")
      upstreamStatus = 200
      expect((await worker.fetch(new Request(url, { method: "POST", headers: API, body: JSON.stringify({ key: "FAKE_KEY" }) }), fakeEnv, context)).status).toBe(200)
      expect(proxies).toBe(1)
    } finally { issuer.mockRestore() }
  })

  it("rotates only the explicitly selected source, preserves history/custom keys and persists encrypted cold-restore state", async () => {
    await runInDurableObject(env.CONVERSATION.getByName(CHANNEL + ":100.1"), async (instance, state) => {
      const f = await fixture(instance, state), body = await preview(instance)
      expect(body.sourceCredentialID).toBe(sourceID); expect(body.expectedCurrentCredentialID).toBe(oldID)
      const applied = await apply(instance, body)
      expect(applied.status).toBe(200)
      expect(f.selected()).toBe(sourceID); expect(f.creates()).toBe(1); expect(f.activations()).toBe(1)
      expect(f.credentials().find(entry => entry.id === "cred_custom_other")?.value).toEqual({ type: "key", key: "FAKE_CUSTOM" })
      expect((await f.store.get()).sessionID).toBe("ses_history"); expect((await f.store.get()).lastReply).toBe("retained history")
      const capsule = await env.CHECKPOINTS.get(`workspaces/${state.id}/provider-repairs/${body.requestID}.json`)
      expect(capsule?.customMetadata?.encrypted).toBe("1"); expect(await capsule!.text()).not.toContain(newKey)
      expect(JSON.stringify(await state.storage.get("providerCredentialRepair:" + body.requestID))).not.toContain(newKey)
      expect(await f.repair.hasPending()).toBe(false)
      const oldCreates = f.creates()
      expect((await apply(instance, body)).status).toBe(200); expect(f.creates()).toBe(oldCreates)
      f.cold()
      const port = await Reflect.get(instance, "ensureReadyOwned").call(instance)
      await f.repair.verifyPrepared(port)
      expect(f.selected()).toBe(sourceID); expect((await f.store.get()).sessionID).toBe("ses_history")
      expect(f.calls.some(call => call.includes("/api/session"))).toBe(false)
    })
  })

  it("rejects settling/held work and stale credential/source CAS without mutations", async () => {
    await runInDurableObject(env.CONVERSATION.getByName(CHANNEL + ":100.2"), async (instance, state) => {
      const f = await fixture(instance, state), body = await preview(instance)
      await f.store.patch({ phase: "settling", budgetReservation: { reservationID: "held", date: "2026-11-15", dispatched: true } })
      expect((await apply(instance, body)).status).toBe(409)
      expect(f.creates()).toBe(0); expect(await f.repair.hasPending()).toBe(false)
      await f.store.patch({ phase: "idle", budgetReservation: undefined })
      f.setCurrentKey("FAKE_CUSTOM_REPLACED_WHILE_PREVIEWED")
      expect((await apply(instance, body)).status).toBe(409); expect(f.creates()).toBe(0)
      f.setCurrentKey(oldKey)
      f.setSource("FAKE_CHANGED_SOURCE")
      expect((await apply(instance, body)).status).toBe(409); expect(f.creates()).toBe(0)
    })
  })

  it.each(["create", "activate", "completion"] as const)("reconciles a lost %s acknowledgement with the same immutable request", async lost => {
    await runInDurableObject(env.CONVERSATION.getByName(CHANNEL + ":101." + lost.length), async (instance, state) => {
      const f = await fixture(instance, state), body = await preview(instance)
      if (lost === "create") f.loseCreate()
      if (lost === "activate") f.loseActivate()
      if (lost === "completion") f.loseCompletion()
      expect((await apply(instance, body)).status).toBe(503)
      expect((await apply(instance, body)).status).toBe(200)
      expect(f.creates()).toBe(1); expect(f.activations()).toBe(1)
      expect((await f.store.get()).sessionID).toBe("ses_history")
    })
  })

  it("reconciles an encrypted repair-bundle put with a lost acknowledgement before touching credentials", async () => {
    await runInDurableObject(env.CONVERSATION.getByName(CHANNEL + ":100.5"), async (instance, state) => {
      const f = await fixture(instance, state), body = await preview(instance), options = Reflect.get(f.repair, "options"), original = options.bucket as R2Bucket
      let puts = 0
      options.bucket = { get: original.get.bind(original), put: async (...args: Parameters<R2Bucket["put"]>) => {
        puts++; await original.put(...args); throw new Error("synthetic lost encrypted bundle acknowledgement")
      } }
      expect((await apply(instance, body)).status).toBe(503)
      expect(f.creates()).toBe(0); expect(await f.repair.hasPending()).toBe(true)
      expect((await apply(instance, body)).status).toBe(200)
      expect(puts).toBe(1); expect(f.creates()).toBe(1); expect(f.activations()).toBe(1)
    })
  })

  it("retains a pending fence after checkpoint failure, rejects prompts/reset, and retries from its encrypted bundle", async () => {
    await runInDurableObject(env.CONVERSATION.getByName(CHANNEL + ":100.3"), async (instance, state) => {
      const f = await fixture(instance, state), body = await preview(instance)
      f.failCheckpoint(true, true)
      expect((await apply(instance, body)).status).toBe(503)
      expect(await f.repair.hasPending()).toBe(true)
      const admissions = Reflect.get(instance, "admissions")
      expect(await admissions.claim()).toBe(false)
      expect((await admissions.enqueue("must not queue")).kind).toBe("unavailable")
      expect((await f.store.get()).queue ?? []).toEqual([])
      expect((await instance.fetch(new Request("https://conversation/message", { method: "POST", body: JSON.stringify({ text: "do not dispatch" }) }))).status).toBe(409)
      expect((await instance.fetch(new Request("https://conversation/reset", { method: "POST" }))).status).toBe(409)
      f.setSource("FAKE_LATER_ROTATION")
      f.cold()
      f.failCheckpoint(false)
      expect((await apply(instance, body)).status).toBe(200)
      expect(f.history()).toEqual(["retained-user", "retained-assistant-error"])
      expect(f.credentials().filter(entry => entry.id === sourceID)).toHaveLength(1)
      expect(await f.repair.hasPending()).toBe(false)
    })
  }, 10000)

  it("refuses a silently restored expired credential before provider/session use after a completed repair", async () => {
    await runInDurableObject(env.CONVERSATION.getByName(CHANNEL + ":100.4"), async (instance, state) => {
      const f = await fixture(instance, state), body = await preview(instance)
      expect((await apply(instance, body)).status).toBe(200)
      f.setSelected(oldID)
      await expect(Reflect.get(instance, "ensureReadyOwned").call(instance)).rejects.toThrow("PROVIDER_REPAIR_RESTORED_CREDENTIAL_MISMATCH")
      expect(f.calls.some(call => call.includes("/api/session"))).toBe(false)
    })
  })
})
