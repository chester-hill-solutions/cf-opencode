import { logEvent } from "../log"

export type ConversationTelemetryEventName =
  | "admission.started"
  | "admission.settled"
  | "turn.started"
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
  | "recovery.settled"
  | "recovery.blocked"
  | "lease.renewed"
  | "lease.failed"
  | "lease.released"
  | "permission.requested"
  | "permission.resolved"
  | "container.started"
  | "container.stopped"

export type ConversationTelemetryResult =
  | "started"
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
  "turn.started": "turns",
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
  "recovery.settled": "recovery",
  "recovery.blocked": "recovery",
  "lease.renewed": "leases",
  "lease.failed": "leases",
  "lease.released": "leases",
  "permission.requested": "permissions",
  "permission.resolved": "permissions",
  "container.started": "runtime",
  "container.stopped": "runtime",
}

const RESULTS = new Set<ConversationTelemetryResult>([
  "started", "settled", "succeeded", "failed", "blocked", "skipped",
  "renewed", "released", "requested", "approved", "denied", "stopped",
])

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
    ? value
    : undefined
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
    const runtimeGeneration = typeof input.runtimeGeneration === "number"
      ? (Number.isSafeInteger(input.runtimeGeneration) && input.runtimeGeneration >= 0 ? input.runtimeGeneration : undefined)
      : safeIdentifier(input.runtimeGeneration)
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
