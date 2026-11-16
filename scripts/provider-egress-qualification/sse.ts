export interface ParsedChatCompletionSSE {
  valid: boolean
  content: string
  bytes: number
  chunks: number
}

/** Incremental parser for OpenAI chat-completion SSE delta content. */
export class ChatCompletionSSEParser {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
  private buffer = ""
  private data: string[] = []
  private content = ""
  private done = false
  private invalid = false
  private finished = false
  private bytes = 0
  private chunks = 0

  constructor(private readonly maxBytes: number) {}

  push(chunk: Uint8Array): void {
    if (this.finished || this.invalid) {
      this.invalid = true
      return
    }
    this.chunks++
    this.bytes += chunk.byteLength
    if (this.bytes > this.maxBytes) {
      this.invalid = true
      return
    }
    try {
      this.buffer += this.decoder.decode(chunk, { stream: true })
      this.consumeLines(false)
    } catch {
      this.invalid = true
    }
  }

  finish(): ParsedChatCompletionSSE {
    if (this.finished) return this.result()
    this.finished = true
    try {
      this.buffer += this.decoder.decode()
      this.consumeLines(true)
    } catch {
      this.invalid = true
    }
    if (this.buffer.length > 0 || this.data.length > 0 || !this.done) this.invalid = true
    return this.result()
  }

  private consumeLines(final: boolean): void {
    while (!this.invalid) {
      const lf = this.buffer.indexOf("\n")
      const cr = this.buffer.indexOf("\r")
      let end = -1
      if (lf >= 0 && cr >= 0) end = Math.min(lf, cr)
      else end = Math.max(lf, cr)
      if (end < 0) break
      if (this.buffer[end] === "\r" && end === this.buffer.length - 1 && !final) break
      const line = this.buffer.slice(0, end)
      const width = this.buffer[end] === "\r" && this.buffer[end + 1] === "\n" ? 2 : 1
      this.buffer = this.buffer.slice(end + width)
      this.line(line)
    }
    if (final && this.buffer.length > 0 && !this.invalid) {
      this.line(this.buffer)
      this.buffer = ""
    }
  }

  private line(line: string): void {
    if (line === "") {
      this.dispatch()
      return
    }
    if (line.startsWith(":")) return
    const colon = line.indexOf(":")
    const field = colon < 0 ? line : line.slice(0, colon)
    if (field !== "data") return
    let value = colon < 0 ? "" : line.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    this.data.push(value)
  }

  private dispatch(): void {
    if (this.data.length === 0) return
    const data = this.data.join("\n")
    this.data = []
    if (this.done) {
      this.invalid = true
      return
    }
    if (data === "[DONE]") {
      this.done = true
      return
    }
    try {
      const frame = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: unknown } }>
      }
      if (!frame || !Array.isArray(frame.choices)) {
        this.invalid = true
        return
      }
      for (const choice of frame.choices) {
        if (!choice || typeof choice !== "object") {
          this.invalid = true
          return
        }
        const delta = choice.delta
        if (!delta || typeof delta !== "object") continue
        if (typeof delta.content === "string") this.content += delta.content
        else if (delta.content !== undefined) this.invalid = true
      }
    } catch {
      this.invalid = true
    }
  }

  private result(): ParsedChatCompletionSSE {
    return { valid: !this.invalid && this.done, content: this.content, bytes: this.bytes, chunks: this.chunks }
  }
}
