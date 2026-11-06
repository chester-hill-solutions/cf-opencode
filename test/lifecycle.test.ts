import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"

/**
 * Lifecycle regression: the persisted phase must follow admission → running →
 * settling → idle, and a settle must not leave the conversation "running".
 */

function fakeContainer() {
  return (port: number) => ({
    async fetch(input: Request | string | URL): Promise<Response> {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

      if (port === 4001) {
        if (url.pathname === "/status") return json({ initialized: true })
        if (url.pathname === "/configure") return json({ ok: true })
        if (url.pathname === "/start") return json({ ok: true })
        if (url.pathname === "/checkpoint") return new Response(null, { status: 204 })
        return json({ error: "not found" }, 404)
      }

      if (url.pathname === "/health") return json({ ok: true })
      if (url.pathname === "/api/session") return json({ data: { id: "ses_1" } })
      if (url.pathname === "/api/session/ses_1/model") return new Response(null, { status: 204 })
      if (url.pathname === "/api/session/ses_1/prompt") return json({ data: {} })
      if (url.pathname === "/api/session/ses_1/context") {
        return json({
          data: [
            {
              type: "assistant",
              time: { completed: 1 },
              content: [{ type: "text", text: "done" }],
            },
          ],
        })
      }
      if (url.pathname === "/api/session/ses_1/permission") return json({ data: [] })
      if (url.pathname === "/api/event") {
        return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } })
      }
      return json({ error: "not found" }, 404)
    },
  })
}

describe("conversation lifecycle", () => {
  it("moves admitting → running → settling → idle", async () => {
    const stub = env.CONVERSATION.getByName("C1:lifecycle")
    const result = await runInDurableObject(stub, async (instance) => {
      instance.transport = fakeContainer()

      const admitted = await instance.fetch(
        new Request("https://conversation/message", {
          method: "POST",
          body: JSON.stringify({ text: "hello" }),
        }),
      )
      const afterAdmission = (await (await instance.fetch(new Request("https://conversation/state"))).json()) as {
        phase?: string
      }

      await instance.alarm()
      const afterSettle = (await (await instance.fetch(new Request("https://conversation/state"))).json()) as {
        phase?: string
        runStartedAt?: number
      }

      return { status: admitted.status, afterAdmission, afterSettle }
    })

    expect(result.status).toBe(200)
    expect(result.afterAdmission.phase).toBe("running")
    expect(result.afterSettle.phase).toBe("idle")
    expect(result.afterSettle.runStartedAt).toBeGreaterThan(0)
  })
})
