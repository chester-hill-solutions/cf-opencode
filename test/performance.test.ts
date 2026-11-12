import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { usageLogResponse } from "./helpers/usage-log"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"

/**
 * Hot-path regression: the readiness handshake (status → configure → start →
 * health) must happen once per container, not once per container call. Every
 * `withClient` used to repeat it, which is three round trips per prompt and six
 * per poll.
 */

interface Counters {
  status: number
  configure: number
  start: number
  prompt: number
  health: number
}

function fakeContainer(counters: Counters) {
  let prompted = false
  return (port: number) => ({
    async fetch(input: Request | string | URL): Promise<Response> {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

      if (port === 4001) {
        if (url.pathname === "/status") {
          counters.status++
          // Cold container: the workspace is not restored yet.
          return json({ initialized: false })
        }
        if (url.pathname === "/configure") {
          counters.configure++
          return json({ ok: true })
        }
        if (url.pathname === "/start") {
          counters.start++
          return json(accountingPolicyStart)
        }
        if (url.pathname === "/checkpoint") return new Response(null, { status: 204 })
        return json({ error: "not found" }, 404)
      }

      if (url.pathname === "/health") {
        counters.health++
        return json({ ok: true })
      }
      if (url.pathname === "/api/config") return json(accountingPolicyConfig)
      if (url.pathname === "/api/session") return json({ data: { id: "ses_1" } })
      if (url.pathname === "/api/session/ses_1/model") return new Response(null, { status: 204 })
      if (url.pathname === "/api/session/ses_1/prompt") {
        counters.prompt++
        prompted = true
        return json({ data: {} })
      }
      if (url.pathname === "/api/session/ses_1/context") {
        const now = Date.now()
        return json({
          data: prompted
            ? [
                { id: "u1", type: "user", content: [{ type: "text", text: "hello" }] },
                {
                  id: "a1",
                  type: "assistant",
                  time: { created: now - 1, completed: now },
                  finish: "stop",
                  cost: 0,
                  content: [{ type: "text", text: "done" }],
                },
              ]
            : [],
        })
      }
      if (url.pathname === "/api/experimental/session/ses_1/log") {
        const now = Date.now()
        return usageLogResponse(input, "ses_1", prompted
          ? [{ id: "a1", type: "assistant", cost: 0, time: { created: now - 1, completed: now } }]
          : [])
      }
      if (url.pathname === "/api/session/ses_1/permission") return json({ data: [] })
      if (url.pathname === "/api/event") {
        return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } })
      }
      return json({ error: "not found" }, 404)
    },
  })
}

describe("container readiness", () => {
  it("handshakes once, not once per container call", async () => {
    const stub = env.CONVERSATION.getByName("C1:perf")
    const result = await runInDurableObject(stub, async (instance) => {
      const counters: Counters = { status: 0, configure: 0, start: 0, prompt: 0, health: 0 }
      instance.transport = fakeContainer(counters)

      const body = JSON.stringify({ text: "hello" })
      const first = await instance.fetch(
        new Request("https://conversation/message", { method: "POST", body }),
      )
      // Let the first turn settle so the second message is admitted, not queued.
      await instance.alarm()
      const second = await instance.fetch(
        new Request("https://conversation/message", { method: "POST", body }),
      )

      return { statuses: [first.status, second.status], counters }
    })

    expect(result.statuses).toEqual([200, 200])
    expect(result.counters.prompt).toBe(2)
    // One handshake for the container's lifetime, not one per call.
    expect(result.counters.status).toBe(1)
    expect(result.counters.configure).toBe(1)
    expect(result.counters.start).toBe(1)
  })
})
