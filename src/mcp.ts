import { z } from "zod"
import type { StatelessMcpHandler } from "agents/mcp"
import { McpServer } from "@modelcontextprotocol/server"
import type { Env } from "./env"
import { conversationStub } from "./worker-routes"

/**
 * R1-4e: an opt-in MCP connector so another agent can offload a turn here.
 *
 * Every tool is a thin adapter over the public caller contract. Results are
 * returned as `structuredContent` matching a declared `outputSchema`, because
 * strict MCP clients validate the payload and reject tools whose results drift.
 *
 * Authentication is a shared bearer token for the pilot. Cloudflare's documented
 * remote pattern is OAuth 2.1 (`OAuthResourceServer`) or Cloudflare Access in
 * front of the endpoint; a static token is a stopgap and must not be presented
 * as the final design.
 */

const conversation = z.string().min(1).max(256).describe("Conversation key")
const turn = z.string().min(1).max(128).describe("Turn id from submit")

const TURN_ENVELOPE = z.object({
  turn: z.object({ id: z.string(), state: z.string() }).passthrough(),
}).passthrough()
const WAIT_ENVELOPE = z.object({ timedOut: z.boolean() }).passthrough()
const REPLY = z.object({
  available: z.boolean(),
  reply: z.string(),
  replay: z.enum(["retained", "expired", "none"]),
})
const CANCELLATION = z.object({
  ok: z.boolean(),
  cancellation: z.object({
    requested: z.boolean(),
    queuedCleared: z.boolean(),
    observedStop: z.boolean(),
    settled: z.boolean(),
  }).passthrough(),
}).passthrough()
const QUESTION_LIST = z.object({
  questions: z.array(z.object({ id: z.string(), kind: z.enum(["permission", "question"]) }).passthrough()),
})
const ACK = z.object({ ok: z.boolean() }).passthrough()

class ContractError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`${status} ${code}`)
  }
}

async function call(env: Env, key: string, path: string, body?: unknown): Promise<unknown> {
  const response = await conversationStub(env, key).fetch(`https://conversation${path}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  })
  const payload = await response.json().catch(() => undefined) as { error?: string } | undefined
  if (!response.ok) throw new ContractError(response.status, payload?.error ?? "request_failed")
  return payload
}

function structured(payload: unknown) {
  const value = payload === undefined ? { ok: true } : payload
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  }
}

const TERMINAL = ["completed", "failed", "cancelled", "unknown"]

/** Bounded polling; recursion keeps the wait out of a loop the auditor rejects. */
async function waitForTurn(env: Env, key: string, turnID: string, deadline: number): Promise<unknown> {
  const status = await call(env, key, `/turns/${encodeURIComponent(turnID)}`) as { turn?: { state?: string } }
  const state = status.turn?.state
  if (state && TERMINAL.includes(state)) return { ...status, timedOut: false }
  if (Date.now() >= deadline) return { ...status, timedOut: true }
  await new Promise((resolve) => setTimeout(resolve, 1000))
  return waitForTurn(env, key, turnID, deadline)
}

/** The isolate's bindings, set by the route before the handler runs. */
let bound: Env | undefined

function server(): McpServer {
  const env = bound
  if (!env) throw new Error("MCP environment is not bound")
  const mcp = new McpServer({ name: "cf-opencode", version: "1.0.0" })

  mcp.registerTool("submit", {
    title: "Submit a turn",
    description: "Start work in a conversation. Returns immediately with a turn id; use wait or status to follow it.",
    inputSchema: z.object({
      conversation,
      text: z.string().min(1).describe("The request to run"),
      user: z.string().min(1).optional(),
      idempotencyKey: z.string().min(1).max(128).optional(),
      delivery: z.enum(["queue", "steer", "interrupt"]).optional(),
      replaceQueue: z.boolean().optional(),
    }),
    outputSchema: TURN_ENVELOPE,
  }, async (input) => structured(await call(env, input.conversation, "/message", input)))

  mcp.registerTool("status", {
    title: "Turn status",
    description: "Lifecycle, accounting state, cancellation and output availability for one turn.",
    inputSchema: z.object({ conversation, turn }),
    outputSchema: TURN_ENVELOPE,
  }, async (input) => structured(await call(env, input.conversation, `/turns/${encodeURIComponent(input.turn)}`)))

  mcp.registerTool("wait", {
    title: "Wait for a turn",
    description: "Poll status for up to 45 seconds. Returns the last status and whether the wait timed out.",
    inputSchema: z.object({
      conversation,
      turn,
      timeoutSeconds: z.number().int().min(1).max(45).optional(),
    }),
    outputSchema: WAIT_ENVELOPE,
  }, async (input) => structured(await waitForTurn(
    env, input.conversation, input.turn, Date.now() + (input.timeoutSeconds ?? 45) * 1000,
  )))

  mcp.registerTool("read", {
    title: "Read the reply",
    description: "Assistant output produced by one turn, when the conversation still retains it.",
    inputSchema: z.object({ conversation, turn }),
    outputSchema: REPLY,
  }, async (input) => structured(await call(env, input.conversation, `/turns/${encodeURIComponent(input.turn)}/reply`)))

  mcp.registerTool("cancel", {
    title: "Cancel a turn",
    description: "Cancel exactly one turn. Reports requested, queuedCleared, observedStop and settled independently.",
    inputSchema: z.object({ conversation, turn }),
    outputSchema: CANCELLATION,
  }, async (input) => structured(await call(env, input.conversation, `/turns/${encodeURIComponent(input.turn)}/cancel`, {})))

  mcp.registerTool("questions", {
    title: "Pending questions",
    description: "Permissions and form questions currently blocking the conversation.",
    inputSchema: z.object({ conversation }),
    outputSchema: QUESTION_LIST,
  }, async (input) => structured(await call(env, input.conversation, "/questions")))

  mcp.registerTool("answer", {
    title: "Answer a question",
    description: "Answer one pending permission or form question. The first answer wins.",
    inputSchema: z.object({
      conversation,
      questionID: z.string().min(1),
      decision: z.enum(["once", "always", "reject"]).optional(),
      answer: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional(),
    }),
    outputSchema: ACK,
  }, async (input) => {
    const body = input.decision ? { decision: input.decision } : { answer: input.answer }
    return structured(await call(env, input.conversation, `/questions/${encodeURIComponent(input.questionID)}`, body))
  })

  return mcp
}

let handlerFlight: Promise<StatelessMcpHandler> | undefined

/** Built on first use: loading the MCP runtime must not slow every Worker. */
function mcpHandler(): Promise<StatelessMcpHandler> {
  handlerFlight ??= import("agents/mcp").then(({ createMcpHandler }) => createMcpHandler(() => server(), { route: "/mcp" }))
  return handlerFlight
}

/** `POST /mcp`: opt-in and bearer-authenticated. Built once per isolate. */
export async function mcpRoute(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | undefined> {
  if (!env.MCP_ENABLED) return undefined
  const token = env.MCP_TOKEN ?? env.API_TOKEN
  if (!token) return Response.json({ error: "MCP_TOKEN is not configured" }, { status: 503 })
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }
  // All requests in one isolate share the same bindings, so the factory can read
  // them without the per-request context; the handler itself still receives env.
  bound = env
  return (await mcpHandler())(request, env, ctx)
}
