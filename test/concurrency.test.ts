import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"

/**
 * Concurrency regression: two deliveries of the same Slack event reach the same
 * Durable Object at once. The claim must admit exactly one prompt.
 *
 * The container is replaced with an injected transport inside the DO; no
 * network and no global fetch stubbing (the DO runs in its own isolate).
 */

function fakeContainer(prompts: { count: number }) {
  return (port: number) => ({
    async fetch(input: Request | string | URL): Promise<Response> {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

      if (port === 4001) {
        if (url.pathname === "/status") return json({ initialized: true })
        if (url.pathname === "/configure" || url.pathname === "/start") return json({ ok: true })
        return json({ error: "not found" }, 404)
      }

      if (url.pathname === "/api/session") return json({ data: { id: "ses_1" } })
      if (url.pathname === "/api/session/ses_1/model") return new Response(null, { status: 204 })
      if (url.pathname === "/api/session/ses_1/prompt") {
        prompts.count++
        return json({ data: {} })
      }
      if (url.pathname === "/api/session/ses_1/context") return json({ data: [] })
      if (url.pathname === "/api/session/ses_1/permission") return json({ data: [] })
      if (url.pathname === "/api/event") {
        return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } })
      }
      return json({ error: "not found" }, 404)
    },
  })
}

describe("conversation concurrency", () => {
  it("admits a duplicate Slack event exactly once", async () => {
    const stub = env.CONVERSATION.getByName("C1:dup")
    const result = await runInDurableObject(stub, async (instance) => {
      const prompts = { count: 0 }
      instance.transport = fakeContainer(prompts)

      const body = JSON.stringify({
        eventID: "evt_dup",
        replyTs: "1",
        event: { type: "app_mention", channel: "C1", ts: "1", text: "<@UBOT> hello" },
      })

      const [first, second] = await Promise.all([
        instance.fetch(new Request("https://conversation/slack", { method: "POST", body })),
        instance.fetch(new Request("https://conversation/slack", { method: "POST", body })),
      ])

      const bodies = await Promise.all([first.text(), second.text()])
      return { statuses: [first.status, second.status], bodies, prompts: prompts.count }
    })

    expect(result.statuses).toEqual([200, 200])
    expect(result.prompts).toBe(1)
  })
})
