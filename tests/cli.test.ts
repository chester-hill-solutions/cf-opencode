import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { client, CliError } from "../tools/cli/client"
import { run } from "../tools/cli/main"

/**
 * R1-4c: the reference client talks only to the public HTTP surface. These
 * tests pin the request shapes and the error mapping without a Worker.
 */

interface Seen {
  method: string
  path: string
  authorization: string | null
  body?: unknown
}

let server: ReturnType<typeof Bun.serve>
let baseUrl = ""
const seen: Seen[] = []

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined
      seen.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        body,
      })
      if (url.pathname.includes("/conflict/")) {
        return Response.json({ error: "idempotency_conflict", turnID: "turn_1" }, { status: 409 })
      }
      return Response.json({ ok: true, path: url.pathname })
    },
  })
  baseUrl = `http://localhost:${server.port}`
})

afterAll(() => server.stop(true))

const api = () => client({ baseUrl, token: "test-token" })

describe("reference client", () => {
  test("submits to the messages route with the bearer token", async () => {
    await api().submit("conv:1", { text: "work", idempotencyKey: "k1" })
    expect(seen.at(-1)).toEqual({
      method: "POST",
      path: "/api/conversations/conv%3A1/messages",
      authorization: "Bearer test-token",
      body: { text: "work", idempotencyKey: "k1" },
    })
  })

  test("uses the turn and question routes", async () => {
    await api().status("c", "turn_1")
    await api().reply("c", "turn_1")
    await api().cancel("c", "turn_1")
    await api().questions("c")
    await api().answer("c", "q1", { decision: "once" })
    expect(seen.slice(-5).map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      "GET /api/conversations/c/turns/turn_1",
      "GET /api/conversations/c/turns/turn_1/reply",
      "POST /api/conversations/c/turns/turn_1/cancel",
      "GET /api/conversations/c/questions",
      "POST /api/conversations/c/questions/q1",
    ])
  })

  test("maps contract errors to a status and code", async () => {
    const failed = await api().submit("conflict", { text: "x" }).catch((error: unknown) => error) as CliError
    expect(failed).toBeInstanceOf(CliError)
    expect(failed.status).toBe(409)
    expect(failed.code).toBe("idempotency_conflict")
  })

  test("run requires credentials and a conversation", async () => {
    await expect(run(["status"], { env: {} })).rejects.toThrow("CF_OPENCODE_URL and API_TOKEN")
    await expect(run(["status"], { env: { url: baseUrl, token: "t" } })).rejects.toThrow("--conversation")
  })

  test("run dispatches submit through the client", async () => {
    const payload = await run(["submit", "--conversation", "c", "--text", "work"], {
      env: { url: baseUrl, token: "t" },
    })
    expect(payload).toMatchObject({ ok: true, path: "/api/conversations/c/messages" })
  })
})
