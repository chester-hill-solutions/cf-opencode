import { describe, expect, test } from "bun:test"
import { clientKey, enforceRateLimit } from "../src/rate-limit"

function request(headers: Record<string, string>): Request {
  return new Request("https://harness.test/api/conversations/demo/messages", { headers })
}

describe("clientKey", () => {
  test("prefers Cloudflare's authoritative client IP", () => {
    expect(
      clientKey(
        request({
          "cf-connecting-ip": "203.0.113.9",
          "x-real-ip": "198.51.100.4",
          "x-forwarded-for": "10.0.0.1, 10.0.0.2",
        }),
      ),
    ).toBe("203.0.113.9")
  })

  test("falls back to x-real-ip and the first forwarded address", () => {
    expect(clientKey(request({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4")
    expect(clientKey(request({ "x-forwarded-for": "10.0.0.1, 10.0.0.2" }))).toBe("10.0.0.1")
    expect(clientKey(request({}))).toBe("unknown")
  })
})

describe("enforceRateLimit", () => {
  test("fails open when no binding is configured", async () => {
    expect(await enforceRateLimit(undefined, request({}), "messages")).toBeUndefined()
  })

  test("keys the limiter by scope and client", async () => {
    const keys: string[] = []
    const binding = {
      async limit(options: { key: string }) {
        keys.push(options.key)
        return { success: true }
      },
    }

    expect(
      await enforceRateLimit(binding, request({ "cf-connecting-ip": "203.0.113.9" }), "messages"),
    ).toBeUndefined()
    expect(keys).toEqual(["messages:203.0.113.9"])
  })

  test("returns the CHS rate-limit contract when the limit is exhausted", async () => {
    const binding = {
      async limit() {
        return { success: false }
      },
    }

    const response = await enforceRateLimit(
      binding,
      request({ "cf-connecting-ip": "203.0.113.9" }),
      "messages",
    )

    expect(response?.status).toBe(429)
    expect(response?.headers.get("ratelimit-limit")).toBe("60")
    expect(response?.headers.get("ratelimit-remaining")).toBe("0")
    expect(response?.headers.get("retry-after")).toBe("60")
    expect(await response?.json()).toEqual({
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests, please try again later.",
      },
    })
  })
})
