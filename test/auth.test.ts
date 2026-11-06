import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { basicAuth } from "../src/opencode"

/**
 * OpenCode v2 requires HTTP Basic auth. The control server returns the
 * per-start password from /start; every client request must carry it.
 */

describe("opencode auth", () => {
  it("uses the password returned by /start on container requests", async () => {
    const stub = env.CONVERSATION.getByName("C1:auth")
    await runInDurableObject(stub, async (instance) => {
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
            if (url.pathname === "/start") return json({ ok: true, password: "test-pass" })
            return json({ error: "not found" }, 404)
          }

          seen.push(request.headers.get("authorization"))
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
      for (const header of seen) expect(header).toBe(basicAuth("test-pass"))
    })
  })
})
