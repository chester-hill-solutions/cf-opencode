/**
 * Pure formatters for the `!model` and `!sessions` commands.
 *
 * Kept out of the entrypoint so the output shape and the index-or-id
 * resolution can be unit-tested without booting Slack or OpenCode.
 */

import { mrkdwnEscape } from "./adapters/slack"

export interface ModelSummary {
  providerID: string
  id: string
  name?: string
  status?: string
  enabled?: boolean
  type?: string
}

export interface SessionSummary {
  id: string
  title?: string
  time?: { updated?: number }
  model?: { providerID: string; id: string; variant?: string }
}

/** `provider/model`, optionally with `#variant`. */
export function modelRef(model: { providerID: string; id: string; variant?: string }): string {
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
}

/**
 * Strip the quoting people paste around ids and refs — the bot prints them as
 * `` `ses_…` ``, so they come back with backticks, and mobile keyboards add
 * quotes or a trailing period.
 */
export function cleanArg(raw: string): string {
  return raw
    .trim()
    .replace(/^[`'"<([]+/, "")
    .replace(/[`'">)\].,;:!?]+$/, "")
    .trim()
}

/**
 * Close matches for a model ref that does not exist, so `!model` can say
 * "did you mean" instead of surfacing a provider 404.
 */
export function modelSuggestions(models: ModelSummary[], ref: string, limit = 3): string[] {
  const cleaned = cleanArg(ref)
  const slash = cleaned.indexOf("/")
  const modelPart = (slash >= 0 ? cleaned.slice(slash + 1) : cleaned).toLowerCase()
  if (!modelPart) return []
  const scored: Array<{ full: string; score: number }> = []
  for (const model of models) {
    if (model.enabled === false) continue
    const full = `${model.providerID}/${model.id}`
    const id = model.id.toLowerCase()
    const score =
      id === modelPart ? 4 : id.startsWith(modelPart) ? 3 : id.includes(modelPart) ? 2 : modelPart.includes(id) ? 1 : 0
    if (score > 0) scored.push({ full, score })
  }
  scored.sort((left, right) => right.score - left.score)
  return [...new Set(scored.map((entry) => entry.full))].slice(0, limit)
}

/** "just now", "5m ago", "3h ago", "2d ago", or "" when the time is unknown. */
export function relativeTime(timestamp: number | undefined, now: number): string {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return ""
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 45) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

/**
 * Render the model switcher.
 *
 * Lists enabled models only, with the current one marked, and says how many
 * were left out rather than dumping a hundred lines into a thread.
 */
export function formatModelList(
  models: ModelSummary[],
  options: { current?: string; limit?: number } = {},
): string {
  const limit = options.limit ?? 25
  const hasTypes = models.some((model) => model.type !== undefined)
  const usable = models.filter(
    (model) => model.enabled !== false && model.status !== "deprecated" && model.status !== "unavailable" &&
      (!hasTypes || model.type === "chat"),
  )
  const shown = usable.slice(0, limit)
  const lines = [
    "*Models* — switch with `!model provider/model` (add `#variant` for a variant):",
    ...shown.map((model) => {
      const ref = `${model.providerID}/${model.id}`
      const name = model.name && model.name !== model.id ? ` — ${mrkdwnEscape(model.name)}` : ""
      const current = options.current?.split("#", 1)[0] === ref ? "  ← current" : ""
      return `• \`${ref}\`${name}${current}`
    }),
  ]
  if (usable.length > shown.length) {
    lines.push(`_…and ${usable.length - shown.length} more_`)
  }
  if (usable.length === 0) lines.push("_No enabled models reported by this OpenCode server._")
  return lines.join("\n")
}

export interface SlackCommand {
  name: string
  args: string
}

/** Parse a leading bang command; unknown names are retained for safe rejection. */
export function parseSlackCommand(text: string): SlackCommand | undefined {
  const match = text.trim().match(/^!([\w.-]+)(?:\s+([\s\S]*))?$/)
  if (!match) return undefined
  let name = (match[1] ?? "").toLowerCase()
  if (name === "help.") name = "help"
  return { name, args: (match[2] ?? "").trim() }
}

/** Render the session switcher. Numbering matches what {@link resolveSessionChoice} accepts. */
export function formatSessionList(
  sessions: SessionSummary[],
  options: { now?: number; limit?: number; current?: string } = {},
): string {
  const now = options.now ?? Date.now()
  const limit = options.limit ?? 10
  const shown = sessions.slice(0, limit)
  if (shown.length === 0) return "_No sessions in this directory yet — send a message to start one._"
  const lines = [
    "*Recent sessions* — switch this conversation with `!sessions <number>` (or an id):",
    ...shown.map((session, index) => {
      const title = session.title ? mrkdwnEscape(session.title) : "_untitled_"
      const when = relativeTime(session.time?.updated, now)
      const model = session.model ? modelRef(session.model) : "default model"
      const current = options.current === session.id ? "  ← current" : ""
      const parts = [`\`${session.id}\``, when, `\`${model}\``].filter(Boolean).join(" · ")
      return `${index + 1}. *${title}* — ${parts}${current}`
    }),
  ]
  if (sessions.length > shown.length) lines.push(`_…and ${sessions.length - shown.length} more_`)
  return lines.join("\n")
}

export type SessionChoice =
  | { kind: "session"; session: SessionSummary }
  | { kind: "error"; message: string }

/** Accept a 1-based number from the rendered list, a full id, or an unambiguous id prefix. */
export function resolveSessionChoice(sessions: SessionSummary[], arg: string): SessionChoice {
  const raw = arg.trim()
  if (!raw) return { kind: "error", message: "Give a session number or id." }

  if (/^\d+$/.test(raw)) {
    const index = Number(raw) - 1
    const session = sessions[index]
    if (!session) {
      return { kind: "error", message: `There is no session ${raw} in the list — run \`!sessions\` again.` }
    }
    return { kind: "session", session }
  }

  const exact = sessions.find((session) => session.id === raw)
  if (exact) return { kind: "session", session: exact }

  const matches = sessions.filter((session) => session.id.startsWith(raw))
  if (matches.length === 1 && matches[0]) return { kind: "session", session: matches[0] }
  if (matches.length > 1) {
    return { kind: "error", message: `\`${raw}\` matches ${matches.length} sessions — use more of the id.` }
  }
  return { kind: "error", message: `No session matches \`${raw}\`.` }
}
