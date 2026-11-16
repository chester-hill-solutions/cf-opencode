import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { api } from "../web/shared/api"
import { loadOverview, parseConversations, parseUsage } from "../web/workspace/data"

const usage = { date: "2026-11-15", costUSD: 1.25, reservedUSD: 0.2, admittedUSD: 1.45, budgetUSD: 5 }
afterEach(() => { fetchMock?.mockRestore(); fetchMock = undefined })
let fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined

describe("workspace API boundary", () => {
  test("missing or invalid money is unavailable rather than displayed as zero", () => {
    expect(parseUsage(usage)).toEqual(usage)
    for (const invalid of [null, {}, { ...usage, costUSD: null }, { ...usage, reservedUSD: -1 }, { ...usage, admittedUSD: Infinity }]) {
      expect(() => parseUsage(invalid)).toThrow("Usage totals could not be read")
    }
  })

  test("empty registries are valid and known conversations are sorted without changing the response", () => {
    expect(parseConversations({ conversations: [] })).toEqual([])
    const rows = [{ key: "older", lastSeenAt: 1 }, { key: "newer", lastSeenAt: 2 }]
    expect(parseConversations({ conversations: rows }).map((item) => item.key)).toEqual(["newer", "older"])
    expect(rows[0]?.key).toBe("older")
    expect(() => parseConversations({ conversations: [{ key: "bad" }] })).toThrow()
  })

  test("partial failures keep successful sections and authenticated read requests", async () => {
    const calls: Array<{ path: string; init: RequestInit | undefined }> = []
    fetchMock = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push({ path: String(input), init })
      return String(input) === "/api/usage" ? Response.json(usage) : Response.json({ error: "Registry unavailable" }, { status: 503 })
    }, { preconnect: () => {} }))
    const result = await loadOverview("synthetic-test-token", new AbortController().signal)
    expect(result.usage).toEqual({ kind: "ready", data: usage })
    expect(result.conversations).toEqual({ kind: "error", message: "Registry unavailable" })
    expect(calls.map((call) => call.path).sort()).toEqual(["/api/conversations", "/api/usage"])
    for (const call of calls) {
      expect(call.init?.method).toBe("GET")
      expect(new Headers(call.init?.headers).get("authorization")).toBe("Bearer synthetic-test-token")
      expect(call.init?.cache).toBe("no-store")
    }
  })

  test("rejected tokens have an actionable message", async () => {
    fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }))
    await expect(api("invalid", "/api/onboarding/status")).rejects.toThrow("token was rejected")
  })

  test("network errors and unreadable successful responses cannot become successful UI state", async () => {
    fetchMock = spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"))
    await expect(api("test", "/api/usage")).rejects.toThrow("Check your connection")
    fetchMock.mockResolvedValue(new Response("not-json"))
    await expect(api("test", "/api/usage")).rejects.toThrow("unreadable response")
  })
})
