import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"

/**
 * Two messages arriving together must admit exactly one turn and queue the
 * other. The queue drains after the first turn settles.
 */

function fakeContainer() {
  let prompted = false
  let answered = false
  const counters = { prompts: 0 }

  const transport = (port: number) => ({
    async fetch(input: Request | string | URL): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input)
      const url = new URL(request.url)
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

      if (port === 4001) {
        if (url.pathname === "/status") return json({ initialized: true })
        if (url.pathname === "/configure" || url.pathname === "/start") return json({ ok: true })
        if (url.pathname === "/checkpoint") return new Response(null, { status: 204 })
        return json({ error: "not found" }, 404)
      }

      if (url.pathname === "/api/session") return json({ data: { id: "ses_1" } })
      if (url.pathname === "/api/session/ses_1/model") return new Response(null, { status: 204 })
      if (url.pathname === "/api/session/ses_1/prompt") {
        prompted = true
        counters.prompts++
        return json({ data: {} })
      }
      if (url.pathname === "/api/session/ses_1/context") {
        return json({
          data: prompted
            ? [
                { id: "u1", type: "user", content: [{ type: "text", text: "hello" }] },
                ...(answered
                  ? [
                      {
                        id: "a1",
                        type: "assistant",
                        time: { created: 1, completed: 2 },
                        finish: "stop",
                        content: [{ type: "text", text: "done" }],
                      },
                    ]
                  : []),
              ]
            : [],
        })
      }
      if (url.pathname === "/api/session/ses_1/permission") return json({ data: [] })
      if (url.pathname === "/api/event") return new Response("", { status: 200 })
      return json({ error: "not found" }, 404)
    },
  })

  return { transport, counters, answer: () => (answered = true) }
}

async function send(instance: { fetch(request: Request): Promise<Response> }, text: string) {
  const response = await instance.fetch(
    new Request("https://conversation/message", { method: "POST", body: JSON.stringify({ text }) }),
  )
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function state(instance: { fetch(request: Request): Promise<Response> }) {
  const response = await instance.fetch(new Request("https://conversation/state"))
  return (await response.json()) as { phase?: string; queued?: unknown }
}

describe("simultaneous admissions", () => {
  it("admits one message, queues the other, and drains after the turn", async () => {
    const stub = env.CONVERSATION.getByName("C1:simultaneous")
    await runInDurableObject(stub, async (instance) => {
      const fake = fakeContainer()
      instance.transport = fake.transport

      const [first, second] = await Promise.all([send(instance, "one"), send(instance, "two")])
      expect([first.status, second.status].sort()).toEqual([200, 202])
      expect(fake.counters.prompts).toBe(1)
      expect((await state(instance)).queued).toBeTruthy()

      // The first turn completes and settles.
      fake.answer()
      await instance.alarm()
      expect((await state(instance)).phase).toBe("idle")

      // The queued message starts on the next alarm.
      await instance.alarm()
      expect(fake.counters.prompts).toBe(2)
      expect((await state(instance)).queued).toBeUndefined()
    })
  })
})
