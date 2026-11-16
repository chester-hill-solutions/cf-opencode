/**
 * Route helpers shared by the Worker entry point. They are deliberately
 * dependency-free apart from the forwarded DO handle, so `index.ts` keeps the
 * route table and nothing else.
 */

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
