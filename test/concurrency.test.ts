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

describe("admission queue", () => {
  it("queues when the container cannot start, then drains on the alarm", async () => {
    const stub = env.CONVERSATION.getByName("C1:queue")
    const result = await runInDurableObject(stub, async (instance) => {
      let starts = 2
      let prompts = 0
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

      instance.transport = (port) => ({
        async fetch(input: Request | string | URL): Promise<Response> {
          const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
          if (port === 4001) {
            if (url.pathname === "/status") return json({ initialized: true })
            if (url.pathname === "/configure") return json({ ok: true })
            if (url.pathname === "/start") {
              if (starts > 0) {
                starts--
                return json({ error: "capacity" }, 500)
              }
              return json({ ok: true })
            }
            return json({ error: "not found" }, 404)
          }
          if (url.pathname === "/api/session") return json({ data: { id: "ses_1" } })
          if (url.pathname === "/api/session/ses_1/model") return new Response(null, { status: 204 })
          if (url.pathname === "/api/session/ses_1/prompt") {
            prompts++
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

      const response = await instance.fetch(
        new Request("https://conversation/message", { method: "POST", body: JSON.stringify({ text: "hello" }) }),
      )
      const status = response.status
      const body = await response.text()
      for (let attempt = 0; attempt < 4; attempt++) await instance.alarm()
      return { status, body, prompts, starts }
    })

    expect(result.status).toBe(202)
    expect(result.body).toContain("queued")
    expect(result.prompts).toBe(1)
    expect(result.starts).toBe(0)
  })
})

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
