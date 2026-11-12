/** Durable conversation-side lease intent. Kept pure for recovery classification. */
export interface ConversationLeaseRecord {
  version: 1
  desired: "held" | "released"
  status: "pending" | "acknowledged"
  requestStartedAt: number
  acknowledgedUntil?: number
  errorCode?: "capacity" | "authority_unavailable" | "stopped_unconfirmed"
}

export function isConversationLeaseRecord(value: unknown): value is ConversationLeaseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const validError = record.errorCode === undefined || record.errorCode === "capacity" ||
    record.errorCode === "authority_unavailable" || record.errorCode === "stopped_unconfirmed"
  const validUntil = record.acknowledgedUntil === undefined ||
    (typeof record.acknowledgedUntil === "number" && Number.isFinite(record.acknowledgedUntil) &&
      typeof record.requestStartedAt === "number" && record.acknowledgedUntil >= record.requestStartedAt)
  return record.version === 1 && (record.desired === "held" || record.desired === "released") &&
    (record.status === "pending" || record.status === "acknowledged") &&
    typeof record.requestStartedAt === "number" && Number.isFinite(record.requestStartedAt) &&
    record.requestStartedAt >= 0 && validError && validUntil &&
    !(record.desired === "held" && record.status === "acknowledged" &&
      (typeof record.acknowledgedUntil !== "number" || !Number.isFinite(record.acknowledgedUntil)))
}
