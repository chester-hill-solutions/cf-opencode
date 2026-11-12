import { describe, expect, test } from "bun:test"
import { measureIdleCloseReopen } from "../bench/measure"

function mockHarness(options: { omitCloseProof?: boolean; mismatchSession?: boolean; noSession?: boolean } = {}) {
  const requests: { method: string; path: string }[] = []
  let contextReads = 0
  let debugReads = 0
  const fetcher = async (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => {
    const url = new URL(input)
    const method = "GET"
    requests.push({ method, path: url.pathname })
    if (url.pathname.endsWith("/context")) {
      contextReads++
      if (options.noSession) return new Response(null, { status: 404 })
      const sessionID = options.mismatchSession && contextReads > 2 ? "different-session" : "existing-session"
      return Response.json({ sessionID, messages: ["must not be printed"] })
    }
    if (url.pathname.endsWith("/debug")) {
      debugReads++
      if (options.omitCloseProof && debugReads > 1) return Response.json({})
      return Response.json({ containerRunning: debugReads % 2 === 1 })
    }
    return new Response("unexpected path", { status: 404 })
  }
  return { base: "https://mock.harness", requests, fetcher }
}

describe("idle close/reopen benchmark", () => {
  test("uses only GET context and passive debug, proving same-session reopen", async () => {
    const harness = mockHarness()
    const result = await measureIdleCloseReopen({
      ...harness,
      key: "synthetic-isolated",
      headers: { authorization: "Bearer test-token" },
      samples: 1,
      closeTimeoutMs: 500,
      pollIntervalMs: 1,
      fetcher: harness.fetcher,
    })

    expect(result.samples).toHaveLength(1)
    expect(result.samples[0]?.warmMs).toBeGreaterThanOrEqual(0)
    expect(result.samples[0]?.coldMs).toBeGreaterThanOrEqual(0)
    expect(harness.requests.map(({ method, path }) => [method, path])).toEqual([
      ["GET", "/api/conversations/synthetic-isolated/context"],
      ["GET", "/api/conversations/synthetic-isolated/debug"],
      ["GET", "/api/conversations/synthetic-isolated/context"],
      ["GET", "/api/conversations/synthetic-isolated/debug"],
      ["GET", "/api/conversations/synthetic-isolated/context"],
      ["GET", "/api/conversations/synthetic-isolated/debug"],
    ])
    expect(harness.requests.some(({ path }) => path.includes("messages"))).toBe(false)
  })

  test("fails when passive debug does not prove a boolean closed state", async () => {
    const harness = mockHarness({ omitCloseProof: true })
    await expect(measureIdleCloseReopen({
      ...harness,
      key: "synthetic-isolated",
      headers: {},
      samples: 1,
      closeTimeoutMs: 500,
      pollIntervalMs: 1,
      fetcher: harness.fetcher,
    })).rejects.toThrow("missing boolean containerRunning")
  })

  test("fails if cold reopen changes the existing session", async () => {
    const harness = mockHarness({ mismatchSession: true })
    await expect(measureIdleCloseReopen({
      ...harness,
      key: "synthetic-isolated",
      headers: {},
      samples: 1,
      closeTimeoutMs: 500,
      pollIntervalMs: 1,
      fetcher: harness.fetcher,
    })).rejects.toThrow("different sessionID")
  })

  test("requires a pre-existing session and reports the context 404", async () => {
    const harness = mockHarness({ noSession: true })
    await expect(measureIdleCloseReopen({
      ...harness,
      key: "synthetic-isolated",
      headers: {},
      samples: 1,
      fetcher: harness.fetcher,
    })).rejects.toThrow("no existing session")
  })
})
