/** Message-shape helpers shared by the reply pump and its tests. */

export interface MessageInfo {
  type?: string
  content?: Array<{ type?: string; text?: string }>
  time?: { created?: number; completed?: number }
  finish?: string
}

/** All assistant text emitted after the latest user message. */
export function latestAssistantReply(messages: MessageInfo[]): string {
  let lastUser = -1
  for (let i = 0; i < messages.length; i++) if (messages[i]?.type === "user") lastUser = i
  return messages
    .slice(lastUser + 1)
    .filter((m) => m.type === "assistant")
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n\n")
    .trim()
}

/** A run is settled once the latest assistant message has completed. */
export function isSettled(messages: MessageInfo[]): boolean {
  const last = [...messages].reverse().find((m) => m.type === "assistant")
  return Boolean(last?.time?.completed || last?.finish)
}
