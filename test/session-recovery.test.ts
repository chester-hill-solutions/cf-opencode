import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"

/**
 * A stored session id is a cache of OpenCode's own database. After a reset or a
 * checkpoint restore without that session, prompts used to fail forever. The
 * harness must verify the session and create a replacement.
 */

function fakeContainer() {
  const prompts = { old: 0, fresh: 0 }
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
        if (url.pathname === "/status") return json({ initialized: true })
        if (url.pathname === "/configure" || url.pathname === "/start") return json({ ok: true })
        if (url.pathname === "/checkpoint") return new Response(null, { status: 204 })
        return json({ error: "not found" }, 404)
      }

      // The old session is gone from this OpenCode database.
      if (url.pathname === "/api/session/ses_old") return json({ error: "not found" }, 404)
      if (url.pathname === "/api/session/ses_old/prompt") {
        prompts.old++
        return json({ error: "not found" }, 404)
      }

      if (url.pathname === "/api/session" && request.method === "POST") {
        return json({ data: { id: "ses_new" } })
      }
      if (url.pathname === "/api/session/ses_new") return json({ data: { id: "ses_new" } })
      if (url.pathname === "/api/session/ses_new/model") return new Response(null, { status: 204 })
      if (url.pathname === "/api/session/ses_new/prompt") {
        prompts.fresh++
        return json({ data: {} })
      }
      if (url.pathname === "/api/session/ses_new/context") return json({ data: [] })
      if (url.pathname === "/api/session/ses_new/permission") return json({ data: [] })
      if (url.pathname === "/api/event") {
        return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } })
      }
      return json({ error: "not found" }, 404)
    },
  })
  return { transport, prompts }
}

describe("session recovery", () => {
  it("replaces a stored session that OpenCode no longer has", async () => {
    const stub = env.CONVERSATION.getByName("C1:session-recovery")
    const result = await runInDurableObject(stub, async (instance, storage) => {
      await storage.storage.put("state", {
        phase: "idle",
        sessionID: "ses_old",
        seen: [],
        pending: { req_old: "ses_old" },
      })
      const fake = fakeContainer()
      instance.transport = fake.transport

      const response = await instance.fetch(
        new Request("https://conversation/message", {
          method: "POST",
          body: JSON.stringify({ text: "hello" }),
        }),
      )
      const body = (await response.json()) as { sessionID?: string }
      const state = (await (
        await instance.fetch(new Request("https://conversation/state"))
      ).json()) as { sessionID?: string; pending?: Record<string, string> }
      return { status: response.status, body, state, prompts: fake.prompts }
    })

    expect(result.status).toBe(200)
    expect(result.body.sessionID).toBe("ses_new")
    expect(result.state.sessionID).toBe("ses_new")
    expect(result.state.pending).toEqual({})
    expect(result.prompts.fresh).toBe(1)
    expect(result.prompts.old).toBe(0)
  })
})
