import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { conversationKey } from "../src/tenancy"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"

/**
 * A namespaced conversation must seed from its own agent's account state, never
 * from the legacy global snapshot. Otherwise binding a channel would hand the
 * new agent another tenant's provider credentials.
 */

const LEGACY = "account/state.tar.gz"
const agent = { tenantID: "tenant-1", agentID: "agent-1" }
const key = conversationKey(agent, "C1:1")

function fakeContainer(seed: { body: string }) {
  const transport = (port: number) => ({
    async fetch(input: Request | string | URL): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input)
      const url = new URL(request.url)
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        })

      if (port === 4001) {
        if (url.pathname === "/status") return json({ initialized: false })
        if (url.pathname === "/seed-state" && request.method === "POST") {
          seed.body = await request.text()
          return json({ ok: true })
        }
        if (url.pathname === "/configure") return json({ ok: true })

        if (url.pathname === "/start") return json(accountingPolicyStart)
        if (url.pathname === "/checkpoint") return new Response(null, { status: 204 })
        if (url.pathname === "/restore") return json({ error: "unexpected restore" }, 500)
        return json({ error: "not found" }, 404)
      }
      if (url.pathname === "/api/config") return json(accountingPolicyConfig)
      if (url.pathname === "/api/info") return json({ data: {} })
      return json({ error: "not found" }, 404)
    },
  })
  return { transport }
}

describe("tenancy account seeds", () => {
  it("seeds a namespaced conversation from its agent key, not the legacy snapshot", async () => {
    await env.CHECKPOINTS.put(LEGACY, "legacy-credentials")
    await env.CHECKPOINTS.put(
      `tenants/${agent.tenantID}/agents/${agent.agentID}/account/state.tar.gz`,
      "agent-credentials",
    )

    const stub = env.CONVERSATION.getByName(key)
    const seen = { body: "" }
    await runInDurableObject(stub, async (instance) => {
      instance.transport = fakeContainer(seen).transport
      // A cold alarm/runtime preparation has the named DO identity even
      // before the first Worker-forwarded request arrives.
      await (instance as unknown as { ensureReady(): Promise<unknown> }).ensureReady()
    })

    expect(seen.body).toBe("agent-credentials")
  })

  it("does not let a forwarded key replace the canonical DO tenant", async () => {
    const isolatedAgent = { tenantID: "tenant-identity", agentID: "agent-identity" }
    const canonical = conversationKey(isolatedAgent, "C9:1")
    await env.CHECKPOINTS.put(LEGACY, "legacy-credentials")
    await env.CHECKPOINTS.put(
      `tenants/${isolatedAgent.tenantID}/agents/${isolatedAgent.agentID}/account/state.tar.gz`,
      "canonical-credentials",
    )
    const stub = env.CONVERSATION.getByName(canonical)
    const seen = { body: "" }
    const result = await runInDurableObject(stub, async (instance) => {
      instance.transport = fakeContainer(seen).transport
      const mismatch = await instance.fetch(new Request("https://conversation/state", {
        headers: { "x-conversation-key": "another-tenant" },
      }))
      await (instance as unknown as { ensureReady(): Promise<unknown> }).ensureReady()
      return { status: mismatch.status }
    })
    expect(result.status).toBe(400)
    expect(seen.body).toBe("canonical-credentials")
  })

  it("recognizes onboarding by DO name without a forwarded request header", async () => {
    const stub = env.CONVERSATION.getByName("onboarding")
    const exempt = await runInDurableObject(stub, async (instance) => {
      const context = (instance as unknown as { ctx: object }).ctx
      Object.defineProperty(context, "container", {
        configurable: true,
        value: { running: true },
      })
      return (instance as unknown as { nativeLeaseEnabled(): boolean }).nativeLeaseEnabled()
    })
    expect(exempt).toBe(false)
  })

  it("blocks runtime preparation when the DO has no named or forwarded identity", async () => {
    const stub = env.CONVERSATION.get(env.CONVERSATION.newUniqueId())
    const seen = { body: "" }
    const error = await runInDurableObject(stub, async (instance) => {
      instance.transport = fakeContainer(seen).transport
      try {
        await (instance as unknown as { ensureReady(): Promise<unknown> }).ensureReady()
        return undefined
      } catch (caught) {
        return caught instanceof Error ? caught.message : String(caught)
      }
    })
    expect(error).toBe("conversation identity unavailable; runtime preparation is blocked")
    expect(seen.body).toBe("")
  })
})
