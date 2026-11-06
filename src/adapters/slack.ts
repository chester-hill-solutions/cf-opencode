/**
 * Slack transport helpers for the Workers implementation.
 *
 * These mirror the local bot's behaviour so the two can share tests and
 * eventually a package. Kept dependency-free so they run in workerd.
 */

export interface SlackEventEnvelope {
  type: "event_callback" | "url_verification"
  challenge?: string
  event_id?: string
  event?: {
    type?: string
    channel?: string
    channel_type?: string
    ts?: string
    thread_ts?: string
    text?: string
    user?: string
    bot_id?: string
    subtype?: string
  }
}

export interface SlackInteractionPayload {
  type: "block_actions"
  user?: { id?: string }
  channel?: { id?: string }
  message?: { ts?: string }
  actions?: Array<{ action_id?: string; value?: string }>
}

export interface Incoming {
  channel: string
  ts: string
  threadTs?: string
  isDm: boolean
  engageChannel?: boolean
}

/** Verify Slack's `X-Slack-Signature` over the raw request body. */
export async function verifySlackSignature(options: {
  signingSecret: string
  timestamp: string | null
  signature: string | null
  body: string
  now?: number
}): Promise<boolean> {
  const { signingSecret, timestamp, signature, body } = options
  if (!signingSecret || !timestamp || !signature) return false
  const seconds = Number(timestamp)
  if (!Number.isFinite(seconds)) return false
  const now = options.now ?? Date.now()
  if (Math.abs(now / 1000 - seconds) > 300) return false

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`v0:${timestamp}:${body}`))
  const hex = Array.from(new Uint8Array(mac))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
  return timingSafeEqual(`v0=${hex}`, signature)
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Which conversation a message belongs to. Thread sessions win over channel
 * sessions; a mention in a new thread prefers that thread.
 */
export function conversationKey(
  input: Incoming,
  lookup: (key: string) => boolean,
): { key: string; replyTs?: string } {
  if (input.isDm) return { key: `${input.channel}:dm` }

  const threadKey = input.threadTs ? `${input.channel}:${input.threadTs}` : undefined
  if (threadKey && (input.engageChannel || lookup(threadKey))) {
    return { key: threadKey, replyTs: input.threadTs }
  }

  const channelKey = `${input.channel}:channel`
  if (lookup(channelKey)) return { key: channelKey }

  if (threadKey) return { key: threadKey, replyTs: input.threadTs }
  // A top-level mention roots a thread at its own timestamp.
  if (input.engageChannel) return { key: `${input.channel}:${input.ts}`, replyTs: input.ts }
  return { key: channelKey, replyTs: input.ts }
}

export function parseInteractionBody(body: string): SlackInteractionPayload | undefined {
  const params = new URLSearchParams(body)
  const raw = params.get("payload")
  if (!raw) return undefined
  try {
    return JSON.parse(raw) as SlackInteractionPayload
  } catch {
    return undefined
  }
}

export function chunkText(text: string, limit = 3900): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit)
    if (cut < limit / 2) cut = remaining.lastIndexOf(" ", limit)
    if (cut < limit / 2) cut = limit
    chunks.push(remaining.slice(0, cut))
    remaining = remaining.slice(cut).trimStart()
  }
  if (remaining.length > 0) chunks.push(remaining)
  return chunks
}

export function mrkdwnEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export function formatCheckin(steps: number, elapsedMs: number, tool?: string): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000))
  const elapsed =
    seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`
  const parts = [`⏳ OpenCode working — ${steps} step${steps === 1 ? "" : "s"}`, elapsed]
  if (tool) parts.push(`last tool: \`${tool}\``)
  return parts.join(" · ")
}

export interface SlackContextMessage {
  user?: string
  text?: string
  bot_id?: string
  ts?: string
  subtype?: string
}

export function formatSlackContext(
  messages: SlackContextMessage[],
  options: { botUserId: string; excludeTs?: string; maxChars?: number },
): string {
  const maxChars = options.maxChars ?? 3000
  const lines: string[] = []
  for (const message of messages) {
    if (!message.text) continue
    if (message.bot_id || message.subtype) continue
    if (message.user === options.botUserId) continue
    if (options.excludeTs && message.ts === options.excludeTs) continue
    const text = message.text.replace(/\s+/g, " ").trim().slice(0, 500)
    if (!text) continue
    lines.push(`${message.user ? `<@${message.user}>` : "someone"}: ${text}`)
  }
  const kept: string[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (used + line.length + 1 > maxChars) break
    kept.unshift(line)
    used += line.length + 1
  }
  return kept.join("\n")
}
