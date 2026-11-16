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
export async function questionsRoute(
  request: Request,
  env: Pick<Env, "API_TOKEN" | "CONVERSATION">,
  rawKey: string,
  record: () => void,
): Promise<Response> {
  if (!env.API_TOKEN) return Response.json({ error: "API_TOKEN is not configured" }, { status: 503 })
  if (!bearerAuthorized(request.headers.get("authorization") ?? "", env.API_TOKEN)) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }
  const key = safeDecode(rawKey)
  if (!key || !KEY_PATTERN.test(key)) return Response.json({ error: "invalid conversation key" }, { status: 400 })
  record()
  return conversationStub(env, key).fetch("https://conversation/questions")
}
