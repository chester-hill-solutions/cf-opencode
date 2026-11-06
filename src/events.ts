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

/** One SSE frame: an `event:` name plus the JSON payload. */
export function formatSse(event: ConversationEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}
