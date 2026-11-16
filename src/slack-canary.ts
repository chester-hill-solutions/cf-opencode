import { agentKeyPrefix, parseConversationKey } from "./tenancy"

export const SLACK_CANARY_CHANNEL = "C0A5YNXLP6C"
export interface SlackCanaryOptions {
  channel?: string
  newThreads?: string
  startTS?: string
  botUserID?: string
  ownership(action: "claim" | "lookup", channel: string, threadTs: string): Promise<boolean>
}
export interface SlackCanaryDecision { route: "canary" | "legacy"; channel: string | null; threadTs: string | null }
const timestamp = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d{8,12}\.\d{6}$/.test(value)
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value))
const reply = (value: SlackCanaryDecision) => Response.json(value, { headers: { "cache-control": "no-store" } })
const legacy = () => reply({ route: "legacy", channel: null, threadTs: null })
const unavailable = () => Response.json({ error: "Canary thread ownership is unavailable." }, { status: 503, headers: { "cache-control": "no-store" } })

interface Candidate { channel: string; threadTs: string; mayClaim: boolean }
function eventCandidate(payload: unknown, botUserID?: string): Candidate | undefined {
  if (!record(payload) || payload.type !== "event_callback" || !record(payload.event)) return undefined
  const event = payload.event
  const fileShare = event.subtype === "file_share" && Array.isArray(event.files) && event.files.length > 0
  if (event.bot_id !== undefined || (event.subtype !== undefined && !fileShare) || (botUserID && event.user === botUserID) || event.channel_type === "im") return undefined
  if (typeof event.channel !== "string" || !/^[CG][A-Z0-9]{1,63}$/.test(event.channel) || !timestamp(event.ts)) return undefined
  if (event.type !== "app_mention" && event.type !== "message") return undefined
  // A root channel message is never adopted. A mention inside an existing
  // thread is lookup-only, even if no owner has been recorded for that thread.
  if (event.thread_ts !== undefined) {
    if (!timestamp(event.thread_ts)) throw new Error("invalid thread")
    return { channel: event.channel, threadTs: event.thread_ts, mayClaim: false }
  }
  if (event.type !== "app_mention" || typeof event.user !== "string" || !/^[UW][A-Z0-9]{1,63}$/.test(event.user)) return undefined
  return { channel: event.channel, threadTs: event.ts, mayClaim: true }
}

function keyThread(value: unknown, channel: string): string | undefined {
  if (typeof value !== "string" || value.length > 256 || !/^[A-Za-z0-9:._-]+$/.test(value)) return undefined
  const agent = parseConversationKey(value)
  const legacyKey = agent ? value.slice(agentKeyPrefix(agent).length) : value
  const parts = legacyKey.split(":")
  return parts.length === 2 && parts[0] === channel && timestamp(parts[1]) ? parts[1] : undefined
}

function interactionCandidate(body: string): Candidate | undefined {
  const values = new URLSearchParams(body).getAll("payload")
  if (values.length !== 1) throw new Error("invalid interaction")
  const payload: unknown = JSON.parse(values[0])
  if (!record(payload) || payload.type !== "block_actions" || !record(payload.channel) ||
    typeof payload.channel.id !== "string" || !/^[CG][A-Z0-9]{1,63}$/.test(payload.channel.id)) return undefined
  const channel = payload.channel.id
  if (!Array.isArray(payload.actions) || payload.actions.length !== 1 || !record(payload.actions[0])) return undefined
  const action = payload.actions[0]
  if (!["oc_perm_once", "oc_perm_always", "oc_perm_reject", "form_answer", "form_cancel"].includes(String(action.action_id)) || typeof action.value !== "string") return undefined
  const embedded: unknown = JSON.parse(action.value)
  if (!record(embedded) || (embedded.channel !== undefined && embedded.channel !== channel)) throw new Error("interaction channel mismatch")
  const fromKey = keyThread(embedded.key, channel)
  if (embedded.key !== undefined && !fromKey) throw new Error("invalid interaction key")
  const fromMessage = record(payload.message) ? payload.message.thread_ts : undefined
  if (fromMessage !== undefined && !timestamp(fromMessage)) throw new Error("invalid interaction thread")
  if (fromKey && fromMessage && fromKey !== fromMessage) throw new Error("interaction thread mismatch")
  const threadTs = fromMessage ?? fromKey
  return timestamp(threadTs) ? { channel, threadTs, mayClaim: false } : undefined
}

/** Called only after the existing Slack HMAC middleware verifies the raw body.
 * This probe neither dispatches conversations nor calls Slack/model services. */
export async function handleSlackCanaryRoute(body: string, kind: string | null, options: SlackCanaryOptions): Promise<Response> {
  if (options.channel !== SLACK_CANARY_CHANNEL || !["true", "false"].includes(options.newThreads ?? "")) return unavailable()
  if (new TextEncoder().encode(body).byteLength > 256 * 1024 || (kind !== "events" && kind !== "interactivity")) return new Response("Invalid canary probe.", { status: 400 })
  let candidate: Candidate | undefined
  try { candidate = kind === "events" ? eventCandidate(JSON.parse(body), options.botUserID) : interactionCandidate(body) }
  catch { return new Response("Invalid canary probe.", { status: 400 }) }
  if (!candidate || candidate.channel !== options.channel) return legacy()
  const selected = candidate
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const decision = (async (): Promise<SlackCanaryDecision> => {
      const owned = await options.ownership("lookup", selected.channel, selected.threadTs)
      if (typeof owned !== "boolean") throw new Error("invalid ownership")
      if (owned) return { route: "canary", channel: selected.channel, threadTs: selected.threadTs }
      if (!selected.mayClaim || options.newThreads !== "true") return { route: "legacy", channel: selected.channel, threadTs: selected.threadTs }
      // A delayed retry of a pre-cutover root mention must not move an existing
      // legacy task. The release operator pins this lower bound once.
      if (!timestamp(options.startTS)) throw new Error("missing cutover timestamp")
      const micros = (ts: string) => { const [seconds, fraction] = ts.split("."); return BigInt(seconds) * 1_000_000n + BigInt(fraction) }
      if (micros(selected.threadTs) < micros(options.startTS)) return { route: "legacy", channel: selected.channel, threadTs: selected.threadTs }
      const claimed = await options.ownership("claim", selected.channel, selected.threadTs)
      if (claimed !== true) throw new Error("claim not acknowledged")
      return { route: "canary", channel: selected.channel, threadTs: selected.threadTs }
    })()
    return reply(await Promise.race([decision, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("ownership deadline")), 1200) })]))
  } catch { return unavailable() }
  finally { if (timer) clearTimeout(timer) }
}
