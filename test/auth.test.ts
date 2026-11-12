import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"

/**
 * The Durable Object never receives or stores the OpenCode password. The
 * control server owns it and authenticates `/opencode/*` on loopback, so DO
 * requests carry only the control token and no basic-auth header.
 */

describe("opencode auth boundary", () => {
  it("does not send or store an OpenCode password", async () => {
    const stub = env.CONVERSATION.getByName("C1:auth")
    await runInDurableObject(stub, async (instance, state) => {
      const seen: Array<string | null> = []
      instance.transport = (port: number) => ({
        async fetch(input: Request | string | URL): Promise<Response> {
          const request = input instanceof Request ? input : new Request(input)
          const url = new URL(request.url)
          const json = (body: unknown, status = 200) =>
            new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

          if (port === 4001) {
            if (url.pathname === "/status") return json({ initialized: true })
            if (url.pathname === "/configure") return json({ ok: true })
            // A current control server returns no secret from /start.
            if (url.pathname === "/start") return json(accountingPolicyStart)
            return json({ error: "not found" }, 404)
          }

          seen.push(request.headers.get("authorization"))
          if (url.pathname === "/api/config") return json(accountingPolicyConfig)
          if (url.pathname === "/api/session") return json({ data: { id: "ses_1" } })
          if (url.pathname === "/api/session/ses_1/model") return new Response(null, { status: 204 })
          if (url.pathname === "/api/session/ses_1/prompt") return json({ data: {} })
          if (url.pathname === "/api/session/ses_1/context") return json({ data: [] })
          if (url.pathname === "/api/session/ses_1/permission") return json({ data: [] })
          if (url.pathname === "/api/event") return new Response("", { status: 200 })
          return json({ error: "not found" }, 404)
        },
      })

      const response = await instance.fetch(
        new Request("https://conversation/message", {
          method: "POST",
          body: JSON.stringify({ text: "hello" }),
        }),
      )
      expect(response.status).toBe(200)
      expect(seen.length).toBeGreaterThan(0)
      for (const header of seen) expect(header).toBeNull()
      const stored = await state.storage.get("controlToken")
      expect(typeof stored).toBe("string")
    })
  })
})
