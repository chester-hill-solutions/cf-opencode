import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"

/**
 * The container control server refuses unauthenticated calls. The DO must send
 * the persisted token on every control request and pass the same token to the
 * container at start.
 */

function fakeContainer(seen: Array<string | null>) {
  return (port: number) => ({
    async fetch(input: Request | string | URL): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input)
      const url = new URL(request.url)
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        })

      if (port === 4001) {
        seen.push(request.headers.get("authorization"))
        if (url.pathname === "/status") return json({ initialized: true })
        if (url.pathname === "/configure") return json({ ok: true })
        if (url.pathname === "/start") return json(accountingPolicyStart)
        if (url.pathname === "/checkpoint") return new Response(null, { status: 204 })
        return json({ ok: true })
      }

      if (url.pathname === "/api/config") return json(accountingPolicyConfig)

      if (url.pathname === "/api/session/ses_1") return json({ data: { id: "ses_1" } })
      if (url.pathname === "/api/session" && request.method === "POST") {
        return json({ data: { id: "ses_1" } })
      }
      if (url.pathname === "/api/session/ses_1/model") return new Response(null, { status: 204 })
      if (url.pathname === "/api/session/ses_1/prompt") return json({ data: {} })
      if (url.pathname === "/api/session/ses_1/context") return json({ data: [] })
      if (url.pathname === "/api/session/ses_1/permission") return json({ data: [] })
      if (url.pathname === "/api/event") {
        return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } })
      }
      return json({ error: "not found" }, 404)
    },
  })
}

describe("control-plane token", () => {
  it("persists a token, sends it on control calls, and passes it at start", async () => {
    const stub = env.CONVERSATION.getByName("C1:control-token")
    const result = await runInDurableObject(stub, async (instance, state) => {
      const seen: Array<string | null> = []
      instance.transport = fakeContainer(seen)

      const response = await instance.fetch(
        new Request("https://conversation/message", {
          method: "POST",
          body: JSON.stringify({ text: "hello" }),
        }),
      )
      await response.text()

      // This transport-only fixture does not bind a real Container instance;
      // provide the base image needed to inspect its startup options.
      Object.defineProperty((instance as unknown as { ctx: object }).ctx, "container", {
        configurable: true,
        value: { images: { base: "registry.cloudflare.com/test/conversation-base@sha256:base" } },
      })

      const token = await state.storage.get<string>("controlToken")
      const options = (
        instance as unknown as {
          startOptions(): { env?: Record<string, string> }
        }
      ).startOptions()
      return { status: response.status, seen, token, options }
    })

    expect(result.status).toBe(200)
    expect(result.token).toMatch(/^[0-9a-f]{64}$/)
    expect(result.options.env?.CONTROL_TOKEN).toBe(result.token)
    expect(result.seen.length).toBeGreaterThan(0)
    for (const header of result.seen) expect(header).toBe(`Bearer ${result.token}`)
  })
})
