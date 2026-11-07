import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"

/**
 * A failed turn must be visible in the thread. Error events used to go to SSE
 * only, so Slack users saw a hanging conversation.
 */

function fakeContainer() {
  let prompted = false
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
        if (url.pathname === "/status") return json({ initialized: true })
        if (url.pathname === "/configure" || url.pathname === "/start") return json({ ok: true })
        if (url.pathname === "/checkpoint") {
          const part = url.searchParams.get("part")
          if (part === "state") {
            return new Response(new Uint8Array([4]), {
              headers: {
                "content-type": "application/gzip",
                "content-length": "1",
                "x-state-fingerprint": "state-fp",
              },
            })
          }
          return new Response(new Uint8Array([1, 2, 3]), {
            headers: {
              "content-type": "application/gzip",
              "content-length": "3",
              "x-workspace-fingerprint": "workspace-fp",
              "x-aboiteau-checkpoint": "split",
            },
          })
        }
        return json({ error: "not found" }, 404)
      }

      if (url.pathname === "/api/session") return json({ data: { id: "ses_1" } })
      if (url.pathname === "/api/session/ses_1") return json({ data: { id: "ses_1" } })
      if (url.pathname === "/api/session/ses_1/model") return new Response(null, { status: 204 })
      if (url.pathname === "/api/session/ses_1/prompt") {
        prompted = true
        return json({ data: {} })
      }
      if (url.pathname === "/api/session/ses_1/context") {
        return json({
          data: prompted
            ? [
                { id: "u1", type: "user", content: [{ type: "text", text: "hello" }] },
                {
                  id: "a1",
                  type: "assistant",
                  time: { created: Date.now(), completed: Date.now() },
                  finish: "error",
                  error: { message: "provider unavailable" },
                  content: [],
                },
              ]
            : [],
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

describe("Slack failure delivery", () => {
  it("posts a turn error to the Slack thread", async () => {
    const stub = env.CONVERSATION.getByName("C1:slack-error")
    const result = await runInDurableObject(stub, async (instance) => {
      instance.transport = fakeContainer()
      const posts: Array<{ method: string; body: Record<string, unknown> }> = []
      ;(instance as unknown as { slack: unknown }).slack = async (
        method: string,
        body: Record<string, unknown>,
      ) => {
        posts.push({ method, body })
        return { ok: true }
      }

      const response = await instance.fetch(
        new Request("https://conversation/slack", {
          method: "POST",
          body: JSON.stringify({
            eventID: "evt_error",
            replyTs: "1",
            event: { type: "app_mention", channel: "C1", ts: "1", text: "<@UBOT> hello" },
          }),
        }),
      )
      await response.text()
      await instance.alarm()
      return posts
    })

    expect(result.some((post) => post.method === "chat.postMessage")).toBe(true)
    expect(
      result.some((post) => String(post.body.text ?? "").includes("provider unavailable")),
    ).toBe(true)
  })
})
