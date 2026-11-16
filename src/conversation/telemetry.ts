import { logEvent } from "../log"

export type ConversationTelemetryEventName =
  | "admission.started"
  | "admission.settled"
  | "queue.enqueued"
  | "queue.capacity"
  | "queue.failed"
  | "queue.dispatch_ambiguous"
  | "queue.drained"
  | "turn.started"
  | "turn.start.failed"
  | "turn.settled"
  | "checkpoint.started"
  | "checkpoint.saved"
  | "checkpoint.skipped"
  | "checkpoint.failed"
  | "checkpoint.retry"
  | "checkpoint.recovered"
  | "checkpoint.abandoned"
  | "checkpoint.pruned"
  | "checkpoint.missing"
  | "checkpoint.manifest.missing"
  | "recovery.started"
  | "recovery.scheduled"
  | "recovery.settled"
  | "recovery.blocked"
  | "lease.renewed"
  | "lease.failed"
  | "lease.released"
  | "permission.requested"
  | "permission.resolved"
  | "permission.reply.blocked"
  | "permission.reply.failed"
  | "container.started"
  | "container.start.failed"
  | "container.stopped"
  | "container.stop.failed"

export type ConversationTelemetryResult =
  | "started"
  | "scheduled"
  | "settled"
  | "succeeded"
  | "failed"
  | "blocked"
  | "skipped"
  | "renewed"
  | "released"
  | "requested"
  | "approved"
  | "denied"
  | "stopped"

export interface ConversationTelemetryInput {
  event: ConversationTelemetryEventName
  conversationID?: string
  sessionID?: string
  turnID?: string
  jobID?: string
  runtimeGeneration?: string | number
  attempt?: number
  result?: ConversationTelemetryResult
  durationMs?: number
  bytes?: number
  count?: number
  reasonCode?: string
}

export interface ConversationTelemetryEnvelope {
  schemaVersion: 1
  at: string
  event: ConversationTelemetryEventName
  component: "admission" | "turns" | "checkpoints" | "recovery" | "leases" | "permissions" | "runtime"
  conversationID?: string
  sessionID?: string
  turnID?: string
  jobID?: string
  runtimeGeneration?: string | number
  attempt?: number
  result?: ConversationTelemetryResult
  durationMs?: number
  bytes?: number
  count?: number
  reasonCode?: string
  traceId?: string
}

export type ConversationTelemetrySink = (envelope: ConversationTelemetryEnvelope) => void
export type ConversationTelemetryTraceId = () => string | undefined

const COMPONENT_BY_EVENT: Record<ConversationTelemetryEventName, ConversationTelemetryEnvelope["component"]> = {
  "admission.started": "admission",
  "admission.settled": "admission",
  "queue.enqueued": "admission",
  "queue.capacity": "admission",
  "queue.failed": "admission",
  "queue.dispatch_ambiguous": "admission",
  "queue.drained": "admission",
  "turn.started": "turns",
  "turn.start.failed": "turns",
  "turn.settled": "turns",
  "checkpoint.started": "checkpoints",
  "checkpoint.saved": "checkpoints",
  "checkpoint.skipped": "checkpoints",
  "checkpoint.failed": "checkpoints",
  "checkpoint.retry": "checkpoints",
  "checkpoint.recovered": "checkpoints",
  "checkpoint.abandoned": "checkpoints",
  "checkpoint.pruned": "checkpoints",
  "checkpoint.missing": "checkpoints",
  "checkpoint.manifest.missing": "checkpoints",
  "recovery.started": "recovery",
  "recovery.scheduled": "recovery",
  "recovery.settled": "recovery",
  "recovery.blocked": "recovery",
  "lease.renewed": "leases",
  "lease.failed": "leases",
  "lease.released": "leases",
  "permission.requested": "permissions",
  "permission.resolved": "permissions",
  "permission.reply.blocked": "permissions",
  "permission.reply.failed": "permissions",
  "container.started": "runtime",
  "container.start.failed": "runtime",
  "container.stopped": "runtime",
  "container.stop.failed": "runtime",
}

const RESULTS = new Set<ConversationTelemetryResult>([
  "started", "scheduled", "settled", "succeeded", "failed", "blocked", "skipped",
  "renewed", "released", "requested", "approved", "denied", "stopped",
])

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
    ? value
    : undefined
}

/** Native runtime generations are URL-safe random IDs and may start with - or _. */
function safeRuntimeGeneration(value: unknown): string | number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : undefined
  return typeof value === "string" && /^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : undefined
}

function safeReasonCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(value)
    ? value
    : undefined
}

function safeTraceId(getTraceId?: ConversationTelemetryTraceId): string | undefined {
  if (!getTraceId) return undefined
  try {
    const value = getTraceId()
    return typeof value === "string" && /^[a-fA-F0-9]{16,64}$/.test(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Emit a versioned, allowlisted lifecycle event. Logging and tracing are
 * observational only: provider/runtime transitions must not depend on them.
 * Supplying a sink replaces console logging, which keeps tests deterministic.
 */
export function emitConversationTelemetry(
  input: ConversationTelemetryInput,
  sink?: ConversationTelemetrySink,
  getTraceId?: ConversationTelemetryTraceId,
): void {
  try {
    if (!Object.hasOwn(COMPONENT_BY_EVENT, input.event)) return
    const envelope: ConversationTelemetryEnvelope = {
      schemaVersion: 1,
      at: new Date().toISOString(),
      event: input.event,
      component: COMPONENT_BY_EVENT[input.event],
    }

    const conversationID = safeIdentifier(input.conversationID)
    const sessionID = safeIdentifier(input.sessionID)
    const turnID = safeIdentifier(input.turnID)
    const jobID = safeIdentifier(input.jobID)
    const runtimeGeneration = safeRuntimeGeneration(input.runtimeGeneration)
    if (conversationID !== undefined) envelope.conversationID = conversationID
    if (sessionID !== undefined) envelope.sessionID = sessionID
    if (turnID !== undefined) envelope.turnID = turnID
    if (jobID !== undefined) envelope.jobID = jobID
    if (runtimeGeneration !== undefined) envelope.runtimeGeneration = runtimeGeneration
    if (Number.isSafeInteger(input.attempt) && input.attempt! >= 0) envelope.attempt = input.attempt
    if (input.result && RESULTS.has(input.result)) envelope.result = input.result
    if (typeof input.durationMs === "number" && Number.isFinite(input.durationMs) && input.durationMs >= 0) {
      envelope.durationMs = input.durationMs
    }
    if (Number.isSafeInteger(input.bytes) && input.bytes! >= 0) envelope.bytes = input.bytes
    if (Number.isSafeInteger(input.count) && input.count! >= 0) envelope.count = input.count
    const reasonCode = safeReasonCode(input.reasonCode)
    if (reasonCode !== undefined) envelope.reasonCode = reasonCode

    const currentTraceId = safeTraceId(getTraceId)
    if (currentTraceId !== undefined) envelope.traceId = currentTraceId

    if (sink) sink(envelope)
    else logEvent(envelope.event, { ...envelope })
  } catch {
    // Telemetry must never change the result of the transition being observed.
  }
}
