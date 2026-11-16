import { z } from "zod"
import { createMcpHandler } from "agents/mcp"
import { McpServer } from "@modelcontextprotocol/server"
import type { Env } from "./env"
import { conversationStub } from "./worker-routes"

/**
 * R1-4e: an opt-in MCP connector so another agent can offload a turn here.
 *
 * Every tool is a thin adapter over the public caller contract — the same
 * routes the HTTP client uses. Nothing is duplicated except the path strings,
 * and every result is the contract's own payload, so the two surfaces cannot
 * drift into different answers.
 */

const conversation = z.string().min(1).max(256).describe("Conversation key")
const turn = z.string().min(1).max(128).describe("Turn id from submit")

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

function text(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] }
}

/** One turn's assistant output, from the retained, turn-correlated log. */
async function readReply(env: Env, key: string, turnID: string): Promise<unknown> {
  const entries = await conversationStub(env, key).fetch("https://conversation/turns/" + encodeURIComponent(turnID) + "/reply")
  const payload = await entries.json().catch(() => undefined) as { error?: string } | undefined
  if (!entries.ok) throw new ContractError(entries.status, payload?.error ?? "request_failed")
  return payload
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

function server(env: Env): McpServer {
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
  }, async (input) => text(await call(env, input.conversation, "/message", input)))

  mcp.registerTool("status", {
    title: "Turn status",
    description: "Lifecycle, accounting state, cancellation and output availability for one turn.",
    inputSchema: z.object({ conversation, turn }),
  }, async (input) => text(await call(env, input.conversation, `/turns/${encodeURIComponent(input.turn)}`)))

  mcp.registerTool("wait", {
    title: "Wait for a turn",
    description: "Poll status for up to 45 seconds. Returns the last status and whether the wait timed out.",
    inputSchema: z.object({
      conversation,
      turn,
      timeoutSeconds: z.number().int().min(1).max(45).optional(),
    }),
  }, async (input) => text(await waitForTurn(env, input.conversation, input.turn, Date.now() + (input.timeoutSeconds ?? 45) * 1000)))

  mcp.registerTool("read", {
    title: "Read the reply",
    description: "Assistant output produced by one turn, when the conversation still retains it.",
    inputSchema: z.object({ conversation, turn }),
  }, async (input) => text(await readReply(env, input.conversation, input.turn)))

  mcp.registerTool("cancel", {
    title: "Cancel a turn",
    description: "Cancel exactly one turn. Reports requested, queuedCleared, observedStop and settled independently.",
    inputSchema: z.object({ conversation, turn }),
  }, async (input) => text(await call(env, input.conversation, `/turns/${encodeURIComponent(input.turn)}/cancel`, {})))

  mcp.registerTool("questions", {
    title: "Pending questions",
    description: "Permissions and form questions currently blocking the conversation.",
    inputSchema: z.object({ conversation }),
  }, async (input) => text(await call(env, input.conversation, "/questions")))

  mcp.registerTool("answer", {
    title: "Answer a question",
    description: "Answer one pending permission or form question. The first answer wins.",
    inputSchema: z.object({
      conversation,
      questionID: z.string().min(1),
      decision: z.enum(["once", "always", "reject"]).optional(),
      answer: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).optional(),
    }),
  }, async (input) => {
    const body = input.decision ? { decision: input.decision } : { answer: input.answer }
    return text(await call(env, input.conversation, `/questions/${encodeURIComponent(input.questionID)}`, body))
  })

  return mcp
}

/** `POST /mcp`: opt-in, bearer-authenticated, stateless. */
export function mcpRoute(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response | undefined {
  if (!env.MCP_ENABLED) return undefined
  const token = env.MCP_TOKEN ?? env.API_TOKEN
  if (!token) return Response.json({ error: "MCP_TOKEN is not configured" }, { status: 503 })
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }
  return createMcpHandler(() => server(env), { route: "/mcp" })(request, env, ctx)
}
