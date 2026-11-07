import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { conversationKey } from "../src/tenancy"

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
        if (url.pathname === "/configure" || url.pathname === "/start") return json({ ok: true })
        if (url.pathname === "/checkpoint") return new Response(null, { status: 204 })
        if (url.pathname === "/restore") return json({ error: "unexpected restore" }, 500)
        return json({ error: "not found" }, 404)
      }

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
      // The DO learns its key from the Worker's header.
      await instance.fetch(
        new Request("https://conversation/state", {
          headers: { "x-conversation-key": key },
        }),
      )
      await (instance as unknown as { ensureReady(): Promise<unknown> }).ensureReady()
    })

    expect(seen.body).toBe("agent-credentials")
  })
})
