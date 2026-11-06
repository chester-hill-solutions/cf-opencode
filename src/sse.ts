/** Minimal SSE frame parser (works for OpenCode's event stream). */

export interface SseMessage {
  event?: string
  data?: string
  id?: string
}

export function createSseParser(onMessage: (message: SseMessage) => void): (chunk: string) => void {
  let buffer = ""
  return (chunk: string) => {
    buffer += chunk
    let index: number
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const message: SseMessage = {}
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue
        const colon = line.indexOf(":")
        if (colon < 0) continue
        const field = line.slice(0, colon)
        const value = line.slice(colon + 1).replace(/^ /, "")
        if (field === "event") message.event = value
        else if (field === "data") message.data = value
        else if (field === "id") message.id = value
      }
      if (message.event || message.data) onMessage(message)
    }
  }
}
