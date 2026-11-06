import { describe, expect, test } from "bun:test"
import { portFetch } from "../src/opencode"

describe("portFetch", () => {
  test("rewrites the request to the container host and preserves it", async () => {
    let captured: Request | undefined
    const port = {
      async fetch(input: Request | string | URL): Promise<Response> {
        captured = new Request(input as any)
        return new Response("ok")
      },
    }

    const fetchFn = portFetch(port)
    const response = await fetchFn("http://container/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    })

    expect(await response.text()).toBe("ok")
    expect(captured?.url).toBe("http://container/api/session")
    expect(captured?.method).toBe("POST")
    expect(await captured?.text()).toBe('{"a":1}')
  })

  test("keeps query strings and GET requests", async () => {
    let captured: Request | undefined
    const port = {
      async fetch(input: Request | string | URL): Promise<Response> {
        captured = new Request(input as any)
        return new Response("ok")
      },
    }

    await portFetch(port)("http://container/api/session?limit=5")
    expect(captured?.method).toBe("GET")
    expect(captured?.url).toBe("http://container/api/session?limit=5")
  })
})
