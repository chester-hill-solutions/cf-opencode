import { afterEach, describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import type { CredentialEntry } from "@opencode/client"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"
import { runtimeCache } from "./helpers/runtime-cache"

type CredentialPayload = {
  id: string
  integrationID: string
  label: string
  value: { type: "key"; key: string }
  activate: boolean
}

function fakeContainer(options: {
  credentials?: CredentialEntry[]
  created?: CredentialPayload[]
  listCalls?: number[]
  generation?: string
} = {}) {
  const credentials = options.credentials ?? []
  const created = options.created ?? []
  const listCalls = options.listCalls ?? []
  return (port: number) => ({
    async fetch(input: Request | string | URL): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input)
      const url = new URL(request.url)
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })
      if (port === 4001) {
        if (url.pathname === "/status") return json({ initialized: true })
        if (url.pathname === "/start") return json({
          ...accountingPolicyStart,
          ...(options.generation ? { opencodeGeneration: options.generation } : {}),
        })
        return json({ error: "not found" }, 404)
      }
      if (url.pathname === "/health") return json({ ok: true })
      if (url.pathname === "/api/config") return json(accountingPolicyConfig)
      if (url.pathname === "/api/model" && request.method === "GET") return json({ data: [] })
      if (url.pathname === "/api/credential" && request.method === "GET") {
        listCalls.push(port)
        return json({ data: credentials })
      }
      if (url.pathname === "/api/credential" && request.method === "POST") {
        const payload = await request.json() as CredentialPayload
        created.push(payload)
        credentials.push({ ...payload, active: true })
        return json({ data: { ...payload, active: true } })
      }
      return json({ error: "not found" }, 404)
    },
  })
}

function installTransport(instance: unknown, transport: (port: number) => { fetch(input: Request | string | URL): Promise<Response> }) {
  runtimeCache(instance).invalidate()
  const internals = instance as { transport: typeof transport }
  internals.transport = transport
}

async function setConnectedAt(value: number): Promise<void> {
  await env.SETTINGS.getByName("global").fetch("https://settings/onboarding", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ opencodeConnectedAt: value }),
  })
}

async function openModels(stub: typeof env.CONVERSATION extends { getByName(name: string): infer T } ? T : never, key: string) {
  return stub.fetch("https://conversation/onboarding/models", {
    headers: { "x-conversation-key": key },
  })
}

afterEach(async () => setConnectedAt(0))

describe("legacy provider credential synchronization", () => {
  it("copies active static keys but skips OAuth credentials", async () => {
    await setConnectedAt(Date.now())
    const source = env.CONVERSATION.getByName("onboarding")
    const target = env.CONVERSATION.getByName("provider-sync-copy")
    const sourceCredentials: CredentialEntry[] = [
      { id: "cred_source", integrationID: "openai", label: "API key", active: true, value: { type: "key", key: "synthetic-source-marker" } },
      { id: "cred_inactive", integrationID: "anthropic", label: "Old key", active: false, value: { type: "key", key: "inactive-marker" } },
      { id: "cred_oauth", integrationID: "github", label: "OAuth", active: true, value: {
        type: "oauth", methodID: "oauth", refresh: "synthetic-refresh-marker", access: "synthetic-access-marker", expires: 123,
      } },
    ]
    const sourceListCalls: number[] = []
    const created: CredentialPayload[] = []
    await runInDurableObject(source, async (instance) => installTransport(instance, fakeContainer({ credentials: sourceCredentials, listCalls: sourceListCalls })))
    await runInDurableObject(target, async (instance) => installTransport(instance, fakeContainer({ created })))

    const sourceResponse = await source.fetch("https://conversation/provider-credentials", {
      headers: { "x-conversation-key": "onboarding" },
    })
    expect(await sourceResponse.json()).toEqual([sourceCredentials[0]])

    const response = await openModels(target, "provider-sync-copy")
    expect(response.status).toBe(200)
    expect(sourceListCalls).toHaveLength(2)
    expect(created).toEqual([{
      id: "cred_source", integrationID: "openai", label: "API key",
      value: { type: "key", key: "synthetic-source-marker" }, activate: true,
    }])
  })

  it("never overwrites an already active local credential for the same provider", async () => {
    await setConnectedAt(Date.now())
    const source = env.CONVERSATION.getByName("onboarding")
    const target = env.CONVERSATION.getByName("provider-sync-local-wins")
    const created: CredentialPayload[] = []
    await runInDurableObject(source, async (instance) => {
      installTransport(instance, fakeContainer({ credentials: [
        { id: "source_id", integrationID: "openai", label: "Source", active: true, value: { type: "key", key: "source-marker" } },
      ] }))
    })
    await runInDurableObject(target, async (instance) => {
      installTransport(instance, fakeContainer({ credentials: [
        { id: "local_id", integrationID: "openai", label: "Local", active: true, value: { type: "key", key: "local-marker" } },
      ], created }))
    })

    const response = await openModels(target, "provider-sync-local-wins")
    expect(response.status).toBe(200)
    expect(created).toEqual([])
  })

  it("syncs again when the same DO starts a new runtime generation", async () => {
    await setConnectedAt(Date.now())
    const source = env.CONVERSATION.getByName("onboarding")
    const target = env.CONVERSATION.getByName("provider-sync-new-generation")
    const targetCredentials: CredentialEntry[] = []
    const created: CredentialPayload[] = []
    const sourceListCalls: number[] = []
    await runInDurableObject(source, async (instance) => {
      installTransport(instance, fakeContainer({
        credentials: [{ id: "source_id", integrationID: "openai", label: "Source", active: true, value: { type: "key", key: "source-marker" } }],
        listCalls: sourceListCalls,
      }))
    })
    await runInDurableObject(target, async (instance) => {
      installTransport(instance, fakeContainer({ credentials: targetCredentials, created, generation: "runtime-one" }))
    })

    expect((await openModels(target, "provider-sync-new-generation")).status).toBe(200)
    expect(created).toHaveLength(1)

    // Model a restore from an older credential-free archive in a new runtime.
    targetCredentials.splice(0)
    await runInDurableObject(target, async (instance) => {
      runtimeCache(instance).invalidate()
      instance.transport = fakeContainer({ credentials: targetCredentials, created, generation: "runtime-two" })
    })
    expect((await openModels(target, "provider-sync-new-generation")).status).toBe(200)
    expect(created).toHaveLength(2)
    expect(sourceListCalls).toHaveLength(2)
  })

  it("exposes credentials only from the onboarding key", async () => {
    const stub = env.CONVERSATION.getByName("provider-sync-guard")
    const response = await stub.fetch("https://conversation/provider-credentials", {
      headers: { "x-conversation-key": "provider-sync-guard" },
    })
    expect(response.status).toBe(403)
  })

  it("does not sync global onboarding credentials into namespaced agent conversations", async () => {
    await setConnectedAt(Date.now())
    const source = env.CONVERSATION.getByName("onboarding")
    const targetKey = "tenant:tenant1:agent:agent1:C1:10.0"
    const target = env.CONVERSATION.getByName(targetKey)
    const sourceListCalls: number[] = []
    const created: CredentialPayload[] = []
    await runInDurableObject(source, async (instance) => {
      installTransport(instance, fakeContainer({
        credentials: [{ id: "cred_source", integrationID: "openai", label: "API key", active: true, value: { type: "key", key: "synthetic-marker" } }],
        listCalls: sourceListCalls,
      }))
    })
    await runInDurableObject(target, async (instance) => installTransport(instance, fakeContainer({ created })))

    const response = await openModels(target, targetKey)
    expect(response.status).toBe(200)
    expect(sourceListCalls).toEqual([])
    expect(created).toEqual([])
  })
})
