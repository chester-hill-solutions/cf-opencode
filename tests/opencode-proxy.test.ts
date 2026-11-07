import { describe, expect, test } from "bun:test"
import type { ContainerPort } from "../src/opencode"
import { opencodeViaControl } from "../src/opencode-proxy"

function fakeControl() {
  const seen: Array<{ url: string; method: string; authorization: string | null }> = []
  const port: ContainerPort = {
    async fetch(input, init) {
      const request = input instanceof Request ? input : new Request(input as any, init)
      seen.push({
        url: request.url,
        method: request.method,
        authorization: request.headers.get("authorization"),
      })
      return new Response("ok")
    },
  }
  return { port, seen }
}

describe("OpenCode control proxy", () => {
  test("namespaces every path under /opencode and keeps the query", async () => {
    const { port, seen } = fakeControl()
    await opencodeViaControl(port).fetch(
      new Request("http://container/api/session/ses_1/context?limit=20", {
        headers: { authorization: "Bearer control-token" },
      }),
    )
    expect(seen).toEqual([
      {
        url: "http://container/opencode/api/session/ses_1/context?limit=20",
        method: "GET",
        authorization: "Bearer control-token",
      },
    ])
  })

  test("preserves the method and body for writes", async () => {
    const { port, seen } = fakeControl()
    await opencodeViaControl(port).fetch("http://container/api/session/ses_1/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    })
    expect(seen[0]).toMatchObject({
      url: "http://container/opencode/api/session/ses_1/prompt",
      method: "POST",
    })
  })
})
