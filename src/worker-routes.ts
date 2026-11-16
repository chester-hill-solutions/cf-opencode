/**
 * Route helpers shared by the Worker entry point. They are deliberately
 * dependency-free apart from the forwarded DO handle, so `index.ts` keeps the
 * route table and nothing else.
 */

import { bearerAuthorized } from "./control-auth"
import type { Env } from "./env"

/** Tenant-namespaced conversation keys, including Slack channel:thread pairs. */
export const KEY_PATTERN = /^[A-Za-z0-9:.\\_-]{1,256}$/

export type SettingsFetch = (path: string, body?: unknown, method?: string) => Promise<Response>

/** Settings DO is global and owns the conversation registry. */
export async function settingsDo(env: Pick<Env, "SETTINGS">, path: string, body?: unknown, method?: string): Promise<Response> {
  return env.SETTINGS.getByName("global").fetch(`https://settings${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** The slice of a conversation DO handle a forwarder needs. */
export interface ConversationHandle {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

/** Decode a path segment without letting a malformed escape reach the router. */
export function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

/** `GET /turns/:id` reads the DO's own turn records; it never starts container work. */
export function turnStatusRoute(
  conversation: ConversationHandle,
  rawID: string | undefined,
  recordConversation: () => void,
): Promise<Response> | Response {
  const turnID = safeDecode(rawID ?? "")
  if (!turnID) return Response.json({ error: "invalid turn id" }, { status: 400 })
  recordConversation()
  return conversation.fetch(`https://conversation/turns/${encodeURIComponent(turnID)}`)
}

/** Alert history: the reads and the explicit clear both belong to Settings. */
export function alertsRoute(
  settings: SettingsFetch,
  url: URL,
  parts: string[],
  request: Request,
): Promise<Response> | undefined {
  if (parts[1] !== "alerts") return undefined
  if (request.method === "GET") return settings("/alerts")
  if (request.method === "DELETE") return settings(`/alerts${url.search}`, undefined, "DELETE")
  return undefined
}

/** Shared bearer policy for the API routes served before the main table. */
function authorizeToken(request: Request, env: Pick<Env, "API_TOKEN">): Response | undefined {
  if (!env.API_TOKEN) return Response.json({ error: "API_TOKEN is not configured" }, { status: 503 })
  if (!bearerAuthorized(request.headers.get("authorization") ?? "", env.API_TOKEN)) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }
  return undefined
}

/** The DO handle every Worker route forwards to, stamped with its own key. */
export function conversationStub(env: Pick<Env, "CONVERSATION">, key: string) {
  const stub = env.CONVERSATION.getByName(key)
  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      headers.set("x-conversation-key", key)
      return stub.fetch(input, { ...init, headers })
    },
  }
}

/**
 * `GET /api/conversations/:key/questions`. A read of pending questions; it
 * authenticates like the rest of the API and never starts lifecycle work.
 */
function isQuestionsRead(parts: string[]): boolean {
  return parts.length === 5 && parts[1] === "api" && parts[2] === "conversations" && parts[4] === "questions"
}

export async function questionsRoute(
  request: Request,
  env: Pick<Env, "API_TOKEN" | "CONVERSATION">,
  parts: string[],
  record: () => void,
): Promise<Response | undefined> {
  if (!isQuestionsRead(parts)) return undefined
  const denied = authorizeToken(request, env)
  if (denied) return denied
  const key = safeDecode(parts[3] ?? "")
  if (!key || !KEY_PATTERN.test(key)) return Response.json({ error: "invalid conversation key" }, { status: 400 })
  record()
  return conversationStub(env, key).fetch("https://conversation/questions")
}

interface PostTarget { kind: "answer" | "cancel"; key: string; id: string }

function answerTarget(parts: string[]): PostTarget | undefined {
  if (parts.length !== 6 || parts[1] !== "api" || parts[2] !== "conversations" || parts[4] !== "questions") {
    return undefined
  }
  const key = safeDecode(parts[3] ?? "")
  const id = safeDecode(parts[5] ?? "")
  return key && id ? { kind: "answer", key, id } : undefined
}

function cancelTarget(parts: string[]): PostTarget | undefined {
  if (parts.length !== 7 || parts[1] !== "api" || parts[2] !== "conversations" ||
    parts[4] !== "turns" || parts[6] !== "cancel") return undefined
  const key = safeDecode(parts[3] ?? "")
  const id = safeDecode(parts[5] ?? "")
  return key && id ? { kind: "cancel", key, id } : undefined
}

function postTarget(parts: string[]): PostTarget | undefined {
  return answerTarget(parts) ?? cancelTarget(parts)
}

/**
 * `POST /api/conversations/:key/questions/:id` answers one pending permission
 * or form question. The conversation decides first-answer-wins; this only
 * forwards with the same authentication as the rest of the API.
 */
export async function postRoute(
  request: Request,
  env: Pick<Env, "API_TOKEN" | "CONVERSATION">,
  parts: string[],
  record: () => void,
): Promise<Response | undefined> {
  const target = postTarget(parts)
  if (!target) return undefined
  const denied = authorizeToken(request, env)
  if (denied) return denied
  if (!KEY_PATTERN.test(target.key)) return Response.json({ error: "invalid conversation key" }, { status: 400 })
  record()
  const path = target.kind === "answer"
    ? `/questions/${encodeURIComponent(target.id)}`
    : `/turns/${encodeURIComponent(target.id)}/cancel`
  return conversationStub(env, target.key).fetch(`https://conversation${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: await request.text(),
  })
}
