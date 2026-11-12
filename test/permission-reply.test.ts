import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"

/** The approval path must reach OpenCode and only then clear the request. */

function fakeContainer(replies: Array<Record<string, unknown>>) {
  return (port: number) => ({
    async fetch(input: Request | string | URL): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input)
      const url = new URL(request.url)
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

      if (port === 4001) {
        if (url.pathname === "/status") return json({ initialized: true })
        if (url.pathname === "/configure") return json({ ok: true })

        if (url.pathname === "/start") return json(accountingPolicyStart)
        return json({ error: "not found" }, 404)
      }

      if (url.pathname === "/api/config") return json(accountingPolicyConfig)

      if (url.pathname === "/api/session") return json({ data: { id: "ses_1" } })
      if (url.pathname === "/api/session/ses_1/model") return new Response(null, { status: 204 })
      if (url.pathname === "/api/session/ses_1/prompt") return json({ data: {} })
      if (url.pathname === "/api/session/ses_1/context") {
        return json({ data: [{ id: "u1", type: "user", content: [{ type: "text", text: "hello" }] }] })
      }
      if (url.pathname === "/api/session/ses_1/permission" && request.method !== "POST") {
        return json({ data: [{ id: "req_1", action: "shell", resources: ["rm -rf /"] }] })
      }
      if (url.pathname === "/api/session/ses_1/permission/req_1/reply") {
        const body = (await request.json()) as Record<string, unknown>
        replies.push(body)
        return new Response(null, { status: 204 })
      }
      if (url.pathname === "/api/event") return new Response("", { status: 200 })
      return json({ error: "not found" }, 404)
    },
  })
}

describe("permission decisions", () => {
  it("forwards the decision to opencode, then clears the pending request", async () => {
    const stub = env.CONVERSATION.getByName("C1:approval")
    await runInDurableObject(stub, async (instance) => {
      const replies: Array<Record<string, unknown>> = []
      instance.transport = fakeContainer(replies)

      const sent = await instance.fetch(
        new Request("https://conversation/message", {
          method: "POST",
          body: JSON.stringify({ text: "hello" }),
        }),
      )
      expect(sent.status).toBe(200)
      // The pump records the pending request and emits it.
      await instance.alarm()

      const pending = (await (await instance.fetch(new Request("https://conversation/state"))).json()) as {
        pending: Record<string, string>
      }
      expect(pending.pending).toMatchObject({ req_1: "ses_1" })

      const decision = await instance.fetch(
        new Request("https://conversation/permission", {
          method: "POST",
          body: JSON.stringify({ requestID: "req_1", decision: "once" }),
        }),
      )
      expect(decision.status).toBe(200)
      expect(replies).toEqual([{ decision: "once" }])

      const cleared = (await (await instance.fetch(new Request("https://conversation/state"))).json()) as {
        pending: Record<string, string>
      }
      expect(cleared.pending).toEqual({})

      // A duplicate click is a no-op, not a second reply.
      const again = await instance.fetch(
        new Request("https://conversation/permission", {
          method: "POST",
          body: JSON.stringify({ requestID: "req_1", decision: "once" }),
        }),
      )
      expect(again.status).toBe(404)
      expect(replies).toHaveLength(1)
    })
  })
})
