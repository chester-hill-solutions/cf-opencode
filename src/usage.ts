/** Validation and conversion for OpenCode's durable usage events. */

export interface DurableUsageReport {
  sourceID: string
  sessionID: string
  date: string
  costUSD: number
  input: number
  output: number
  seq: number
  assistantMessageID?: string
}

const USAGE_EVENT_TYPES = new Set([
  "session.step.ended",
  "session.step.failed",
  "session.usage.recorded",
])

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

/** Returns undefined for durable events that do not carry billable usage. */
export function durableUsageEvent(raw: unknown, expectedSessionID: string): DurableUsageReport | undefined {
  if (!raw || typeof raw !== "object") throw new Error("durable usage event is unreadable")
  const event = raw as Record<string, unknown>
  if (typeof event.type !== "string" || !USAGE_EVENT_TYPES.has(event.type)) return undefined
  const durable = event.durable as Record<string, unknown> | undefined
  const data = event.data as Record<string, unknown> | undefined
  const tokens = data?.tokens as Record<string, unknown> | undefined
  const seq = durable?.seq
  const eventSessionID = data?.sessionID
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
    throw new Error("durable event sequence is unreadable")
  }
  if (typeof eventSessionID !== "string" || eventSessionID !== expectedSessionID) {
    throw new Error("durable event session does not match")
  }
  if (typeof event.id !== "string" || !event.id) throw new Error("durable usage event id is unreadable")
  if (typeof event.created !== "number" || !Number.isFinite(event.created) || event.created <= 0) {
    throw new Error("durable usage event date is unreadable")
  }
  const date = new Date(event.created < 1e12 ? event.created * 1000 : event.created)
  if (!Number.isFinite(date.getTime())) throw new Error("durable usage event date is unreadable")
  const costUSD = data?.cost
  const input = tokens?.input
  const output = tokens?.output
  if (!finiteNonnegative(costUSD) || !finiteNonnegative(input) || !finiteNonnegative(output)) {
    throw new Error("durable usage event totals are unreadable")
  }
  if (data?.assistantMessageID !== undefined &&
    (typeof data.assistantMessageID !== "string" || data.assistantMessageID.length === 0)) {
    throw new Error("durable assistant message id is unreadable")
  }
  return {
    sourceID: event.id,
    sessionID: expectedSessionID,
    date: date.toISOString().slice(0, 10),
    costUSD,
    input,
    output,
    seq,
    ...(typeof data?.assistantMessageID === "string"
      ? { assistantMessageID: data.assistantMessageID }
      : {}),
  }
}
