import { describe, expect, it } from "vitest"
import { env, runInDurableObject, SELF } from "cloudflare:test"
import { runtimeCache } from "./helpers/runtime-cache"

const BASE = "https://harness.test"
const API = { authorization: "Bearer test-token" }

function installRuntime(instance: unknown, calls: string[]) {
  const internals = instance as { transport: (port: number) => { fetch(input: Request | string | URL): Promise<Response> } }
  internals.transport = () => ({
    async fetch(input) {
      const request = input instanceof Request ? input : new Request(input)
      const url = new URL(request.url)
      calls.push(`${url.pathname}${url.search}`)
      const json = (body: unknown) => new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      })
      if (url.pathname === "/api/session/ses_diagnostic") {
        return json({ data: {
          id: "ses_diagnostic",
          location: { directory: "/workspace" },
          model: { providerID: "opencode", id: "deepseek-v4.1-flash", variant: "default" },
        } })
      }
      if (url.pathname === "/api/integration") {
        return json({ data: [{
          id: "opencode",
          name: "Console with private label",
          connections: [{ type: "credential", id: "cred_safe_id", label: "private label", method: "key", status: { message: "private status" } }],
        }] })
      }
      if (url.pathname === "/api/provider") {
        return json({ data: [{
          id: "opencode", name: "Console", activation: "enabled", integrationID: "opencode",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { apiKey: "provider-secret-marker" },
          headers: { authorization: "provider-header-secret-marker" },
        }] })
      }
      if (url.pathname === "/api/model") {
        return json({ data: [{
          id: "deepseek-v4.1-flash", modelID: "deepseek-v4.1-flash", providerID: "opencode",
          name: "Private model title", type: "chat", enabled: true,
          settings: { apiKey: "model-secret-marker" },
          headers: { authorization: "model-header-secret-marker" },
          body: { token: "model-body-secret-marker" },
        }] })
      }
      if (url.pathname === "/api/config") return json({ data: {} })
      return json({ error: "not found" })
    },
  })
  const runtime = runtimeCache(instance)
  runtime.markVerified(internals.transport(4173), "diagnostic-test-generation", true)
}

describe("authenticated provider diagnostics", () => {
  it("requires the existing API bearer token", async () => {
    const response = await SELF.fetch(`${BASE}/api/conversations/provider-diagnostics/debug/providers`)
    expect(response.status).toBe(401)
  })

  it("does not start or reconfigure a cold runtime to collect diagnostics", async () => {
    const stub = env.CONVERSATION.getByName("provider-diagnostics-cold")
    let transportCalls = 0
    await runInDurableObject(stub, async (instance, runtime) => {
      await runtime.storage.put("state", {
        sessionID: "ses_diagnostic",
        settingsVersion: -1,
        seen: [],
        pending: {},
      })
      const internals = instance as unknown as {
        transport: (port: number) => { fetch(input: Request | string | URL): Promise<Response> }
      }
      runtimeCache(instance).invalidate()
      internals.transport = () => ({ fetch: async () => {
        transportCalls++
        return new Response("unexpected runtime activity", { status: 500 })
      } })
    })

    const response = await stub.fetch("https://conversation/debug/providers")
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: "provider diagnostics unavailable" })
    expect(transportCalls).toBe(0)
  })

  it("reports sanitized metadata from the current session location only", async () => {
    const stub = env.CONVERSATION.getByName("provider-diagnostics")
    const calls: string[] = []
    const settingsResponse = await env.SETTINGS.getByName("global").fetch("https://settings/get")
    const settings = await settingsResponse.json() as { version: number }
    await runInDurableObject(stub, async (instance, runtime) => {
      await runtime.storage.deleteAll()
      await runtime.storage.put("state", {
        sessionID: "ses_diagnostic",
        phase: "idle",
        settingsVersion: settings.version,
        seen: [],
        pending: {},
      })
      installRuntime(instance, calls)
    })

    const response = await SELF.fetch(`${BASE}/api/conversations/provider-diagnostics/debug/providers`, { headers: API })
    expect(response.status).toBe(200)
    const body = await response.json() as {
      session: { id: string; location: { directory: string }; model: { providerID: string; id: string; variant?: string } }
      integrations: Array<{ id: string; connections: Array<{ type: string; id?: string; method?: string; selected?: boolean }> }>
      providers: Array<{ id: string; activation: string; integrationID?: string }>
      models: Array<{ providerID: string; id: string; enabled: boolean; type: string }>
    }
    expect(body).toEqual({
      session: {
        id: "ses_diagnostic",
        location: { directory: "/workspace" },
        model: { providerID: "opencode", id: "deepseek-v4.1-flash", variant: "default" },
      },
      integrations: [{ id: "opencode", connections: [{ type: "credential", id: "cred_safe_id", method: "key", selected: true }] }],
      providers: [{ id: "opencode", activation: "enabled", integrationID: "opencode" }],
      models: [{ providerID: "opencode", id: "deepseek-v4.1-flash", enabled: true, type: "chat" }],
    })

    const serialized = JSON.stringify(body)
    for (const secret of [
      "provider-secret-marker",
      "provider-header-secret-marker",
      "model-secret-marker",
      "model-header-secret-marker",
      "model-body-secret-marker",
      "private label",
      "private status",
    ]) expect(serialized).not.toContain(secret)

    expect(calls).toContain("/api/session/ses_diagnostic")
    const located = (prefix: string) => calls.some((path) => {
      if (!path.startsWith(`${prefix}?`)) return false
      return new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("location[directory]") === "/workspace"
    })
    expect(located("/api/integration")).toBe(true)
    expect(located("/api/provider")).toBe(true)
    expect(located("/api/model")).toBe(true)
    expect(calls.some((path) => /prompt|generate|credential/i.test(path))).toBe(false)
  })
})
