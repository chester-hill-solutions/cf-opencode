import { describe, expect, it } from "vitest"
import { env } from "cloudflare:test"
import { mcpRoute } from "../src/mcp"
import type { Env } from "../src/env"

/**
 * R1-4e: the MCP connector is opt-in, bearer-authenticated, and exposes the
 * caller contract as tools. It must not exist at all when disabled.
 */

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext

function runtime(overrides: Partial<Env> = {}): Env {
  return {
    MCP_ENABLED: "1",
    API_TOKEN: "test-token",
    CONVERSATION: env.CONVERSATION,
    SETTINGS: env.SETTINGS,
    ...overrides,
  } as unknown as Env
}

function rpc(body: unknown, token?: string) {
  return new Request("https://harness.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

describe("MCP connector", () => {
  it("does not exist unless enabled", () => {
    expect(mcpRoute(rpc({}), runtime({ MCP_ENABLED: undefined }), ctx)).toBeUndefined()
  })

  it("requires the MCP token", () => {
    const denied = mcpRoute(rpc({}), runtime({ MCP_TOKEN: "mcp-token" }), ctx) as Response
    expect(denied.status).toBe(401)
  })

  it("lists the caller-contract tools", async () => {
    const response = await (mcpRoute(
      rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, "test-token"),
      runtime(),
      ctx,
    ) as Promise<Response>)
    const body = await response.text()
    expect(response.status).toBe(200)
    for (const name of ["submit", "status", "wait", "read", "cancel", "questions", "answer"]) {
      expect(body).toContain(`"${name}"`)
    }
  })
})
