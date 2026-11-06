/**
 * Transport-neutral conversation events.
 *
 * The Durable Object emits these; adapters decide how to deliver them. Slack
 * posts messages, HTTP streams them as SSE.
 */

export type ConversationEvent =
  | { type: "assistant"; text: string }
  | { type: "settled" }
  | { type: "permission"; requestID: string; action?: string; resources?: string[] }
  | { type: "error"; message: string }
  | { type: "reset" }

/** One SSE frame: an `event:` name plus the JSON payload. */
export function formatSse(event: ConversationEvent, seq?: number): string {
  const id = seq === undefined ? "" : `id: ${seq}\n`
  return `${id}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

export interface StoredEvent {
  seq: number
  event: ConversationEvent
}
