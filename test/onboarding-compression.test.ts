import { beforeEach, describe, expect, it } from "vitest"
import { env, runInDurableObject, SELF } from "cloudflare:test"
import { ACCOUNT_STATE_KEY } from "../src/conversation"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"
import { runtimeCache } from "./helpers/runtime-cache"

const BASE = "https://harness.test"
const API = { authorization: "Bearer test-token" }

async function resetOnboarding(): Promise<void> {
  await runInDurableObject(env.SETTINGS.getByName("global"), async (_instance, runtime) => {
    await runtime.storage.deleteAll()
  })
  await env.CHECKPOINTS.delete(ACCOUNT_STATE_KEY)
  await runInDurableObject(env.CONVERSATION.getByName("onboarding"), async (instance, runtime) => {
    await runtime.storage.deleteAll()
    runtimeCache(instance).invalidate()
  })
}

function attachContainer(instance: unknown, options: { connected?: boolean; integrationFailure?: boolean } = {}) {
  const calls: string[] = []
  ;(instance as { transport?: unknown }).transport = (port: number) => ({
    async fetch(input: Request | string | URL): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input)
      const path = new URL(request.url).pathname
      calls.push(`${port} ${request.method} ${path}`)
      if (port === 4001 && path === "/status") return Response.json({ initialized: true })
      if (port === 4001 && path === "/configure") return Response.json({ ok: true })
      if (port === 4001 && path === "/start") return Response.json(accountingPolicyStart)
      if (port === 4001 && path === "/integrations") {
        // Reproduce Workers' decoded upstream body with stale compressed-body headers.
        const body = JSON.stringify({ data: [{ name: "Provider", connections: [{ id: "connected" }] }] })
        return new Response(body, {
          headers: { "content-type": "application/json", "content-encoding": "br", "content-length": "9876" },
        })
      }
      if (port === 4001 && path === "/state-checkpoint") {
        return new Response(new Uint8Array([31, 139, 8, 0]), {
          headers: { "content-type": "application/gzip", "content-length": "4" },
        })
      }
      if (port !== 4001 && path === "/api/config") return Response.json(accountingPolicyConfig)
      if (port !== 4001 && path === "/api/integration") {
        if (options.integrationFailure) return Response.json({ error: "provider store unavailable" }, { status: 500 })
        const body = JSON.stringify({ data: [{ name: "Provider", connections: options.connected === false ? [] : [{ id: "connected" }] }] })
        return new Response(body, {
          headers: { "content-type": "application/json", "content-encoding": "br", "content-length": "9876" },
        })
      }
      if (port !== 4001 && path === "/api/model") {
        const body = JSON.stringify({ data: [{ providerID: "p", id: "model", name: "Model", type: "chat" }] })
        return new Response(body, {
          headers: { "content-type": "application/json", "content-encoding": "br", "content-length": "9876" },
        })
      }
      return Response.json({ error: "not found" }, { status: 404 })
    },
  })
  return calls
}

describe("onboarding proxy compression headers", () => {
  beforeEach(resetOnboarding)

  it("returns fresh provider/model JSON and completes encrypted account snapshot", async () => {
    const stub = env.CONVERSATION.getByName("onboarding")
    const calls = await runInDurableObject(stub, async (instance) => attachContainer(instance))

    const status = await SELF.fetch(`${BASE}/api/onboarding/opencode/integrations`, { headers: API })
    expect(status.status).toBe(200)
    expect(status.headers.get("content-encoding")).toBeNull()
    expect(status.headers.get("content-length")).toBeNull()
    await expect(status.json()).resolves.toMatchObject({
      data: [{ connections: [{ id: "connected" }] }],
    })

    const models = await SELF.fetch(`${BASE}/api/onboarding/opencode/models`, { headers: API })
    expect(models.status).toBe(200)
    expect(models.headers.get("content-encoding")).toBeNull()
    expect(models.headers.get("content-length")).toBeNull()
    await expect(models.json()).resolves.toMatchObject({
      data: [{ providerID: "p", id: "model", type: "chat" }],
    })

    const finish = await SELF.fetch(`${BASE}/api/onboarding/finish`, {
      method: "POST", headers: API,
    })
    expect(finish.status).toBe(200)
    expect(await finish.json()).toMatchObject({ ok: true, snapshot: true })

    const snapshot = await env.CHECKPOINTS.get(ACCOUNT_STATE_KEY)
    expect(snapshot).toBeDefined()
    expect(snapshot?.customMetadata).toMatchObject({ encrypted: "1" })
    expect(calls).not.toContain("4001 GET /integrations")
    expect(calls).toContain("4000 GET /api/integration")
    expect(calls).toContain("4000 GET /api/model")
    expect(calls).toContain("4001 GET /state-checkpoint")
  })

  it("keeps provider status private and returns only connected state", async () => {
    const stub = env.CONVERSATION.getByName("onboarding")
    await runInDurableObject(stub, async (instance) => {
      attachContainer(instance)
      runtimeCache(instance).invalidate()
    })
    const request = (target: typeof stub, key: string, method = "GET") => target.fetch(new Request("https://conversation/provider-status", {
      method, headers: { "x-conversation-key": key },
    }))

    const connected = await request(stub, "onboarding")
    expect(connected.status).toBe(200)
    expect(await connected.json()).toEqual({ connected: true })
    expect((await request(stub, "other-conversation")).status).toBe(400)
    const otherStub = env.CONVERSATION.getByName("other-conversation")
    expect((await request(otherStub, "other-conversation")).status).toBe(403)
    expect((await request(stub, "onboarding", "POST")).status).toBe(403)
    const publicRoute = await SELF.fetch(`${BASE}/api/onboarding/provider-status`, { headers: API })
    expect(publicRoute.status).toBe(404)
  })

  it("reports disconnected and masks SDK integration lookup errors", async () => {
    const disconnectedStub = env.CONVERSATION.getByName("onboarding")
    await runInDurableObject(disconnectedStub, async (instance) => {
      attachContainer(instance, { connected: false })
      runtimeCache(instance).invalidate()
    })
    const disconnected = await disconnectedStub.fetch(new Request("https://conversation/provider-status", {
    }))
    expect(disconnected.status).toBe(200)
    expect(await disconnected.json()).toEqual({ connected: false })

    await runInDurableObject(disconnectedStub, async (instance) => {
      attachContainer(instance, { integrationFailure: true })
      runtimeCache(instance).invalidate()
    })
    const failed = await disconnectedStub.fetch(new Request("https://conversation/provider-status"))
    expect(failed.status).toBe(503)
    expect(await failed.json()).toMatchObject({ error: "provider status unavailable", retryable: true })
  })
})
