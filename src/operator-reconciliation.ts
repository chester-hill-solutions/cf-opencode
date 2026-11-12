/** Closed contract for the internal, operator-reviewed usage reconciliation path. */

export type OperatorReconciliationKind = "observed_actual" | "acknowledged_unknown"

export interface OperatorQuiescenceProof {
  sessionID: string
  runtimeGeneration: string
  contextDigest: string
  waited: true
  inboxEmpty: true
  permissionsEmpty: true
  formsEmpty: true
}

export interface OperatorReconciliationProposal {
  receiptID: string
  conversationID: string
  sessionID: string
  reservationID: string
  originDate: string
  usageDate: string | null
  expectedLedgerSnapshotID: string
  expectedLocalSnapshotID: string
  quiescence: OperatorQuiescenceProof
  quiescenceDigest: string
  kind: OperatorReconciliationKind
  actualCostUSD: number | null
  input: number | null
  output: number | null
  assistantMessageID?: string
  evidenceReference: string
  evidenceSHA256: string
  operator: string
  approvalReference: string
  acceptUnknownRisk?: true
}

export interface OperatorReconciliationReceipt extends OperatorReconciliationProposal {
  requestDigest: string
  createdAt: number
}

export interface OperatorReconciliationSource {
  sourceID: string
  date: string
  costUSD: number
  input: number
  output: number
  assistantMessageID?: string
  sourceKind?: "native" | "operator_observed"
  operatorReceiptID?: string
}

const PROPOSAL_FIELDS = [
  "receiptID",
  "conversationID",
  "sessionID",
  "reservationID",
  "originDate",
  "usageDate",
  "expectedLedgerSnapshotID",
  "expectedLocalSnapshotID",
  "quiescence",
  "quiescenceDigest",
  "kind",
  "actualCostUSD",
  "input",
  "output",
  "assistantMessageID",
  "evidenceReference",
  "evidenceSHA256",
  "operator",
  "approvalReference",
  "acceptUnknownRisk",
] as const

export type ParseProposalResult =
  | { ok: true; value: OperatorReconciliationProposal }
  | { ok: false; error: string }

function boundedText(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max
}

function validAmountOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0)
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}

function parseQuiescenceProof(value: unknown, sessionID: string): OperatorQuiescenceProof | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const proof = value as Record<string, unknown>
  const keys = ["sessionID", "runtimeGeneration", "contextDigest", "waited", "inboxEmpty", "permissionsEmpty", "formsEmpty"]
  if (Object.keys(proof).length !== keys.length || Object.keys(proof).some((key) => !keys.includes(key)) ||
    proof.sessionID !== sessionID || !boundedText(proof.runtimeGeneration) || !isSha256(proof.contextDigest) ||
    proof.waited !== true || proof.inboxEmpty !== true || proof.permissionsEmpty !== true || proof.formsEmpty !== true) {
    return undefined
  }
  return {
    sessionID: proof.sessionID as string,
    runtimeGeneration: proof.runtimeGeneration as string,
    contextDigest: proof.contextDigest,
    waited: true,
    inboxEmpty: true,
    permissionsEmpty: true,
    formsEmpty: true,
  }
}

export function canonicalOperatorQuiescenceProof(proof: OperatorQuiescenceProof): string {
  return JSON.stringify([
    ["sessionID", proof.sessionID],
    ["runtimeGeneration", proof.runtimeGeneration],
    ["contextDigest", proof.contextDigest],
    ["waited", proof.waited],
    ["inboxEmpty", proof.inboxEmpty],
    ["permissionsEmpty", proof.permissionsEmpty],
    ["formsEmpty", proof.formsEmpty],
  ])
}

export async function hashOperatorQuiescence(proof: OperatorQuiescenceProof): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalOperatorQuiescenceProof(proof))
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

export const operatorQuiescenceDigest = hashOperatorQuiescence

export function parseOperatorReconciliationProposal(value: unknown): ParseProposalResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "reconciliation proposal must be an object" }
  }
  const body = value as Record<string, unknown>
  if (Object.keys(body).some((key) => !(PROPOSAL_FIELDS as readonly string[]).includes(key))) {
    return { ok: false, error: "reconciliation proposal contains unknown fields" }
  }
  if (![body.receiptID, body.conversationID, body.sessionID, body.reservationID].every((id) => boundedText(id))) {
    return { ok: false, error: "receiptID, conversationID, sessionID, and reservationID are required" }
  }
  if (!validDate(body.originDate)) return { ok: false, error: "originDate must be a valid UTC date" }
  if (body.usageDate !== null && !validDate(body.usageDate)) {
    return { ok: false, error: "usageDate must be a valid UTC date or null" }
  }
  if (!isSha256(body.expectedLedgerSnapshotID) || !isSha256(body.expectedLocalSnapshotID)) {
    return { ok: false, error: "both expected snapshots must be SHA-256 digests" }
  }
  if (!isSha256(body.quiescenceDigest)) return { ok: false, error: "quiescenceDigest must be a SHA-256 digest" }
  const quiescence = parseQuiescenceProof(body.quiescence, body.sessionID as string)
  if (!quiescence) return { ok: false, error: "quiescence proof must match the session and prove all four empty/wait checks" }
  if (body.kind !== "observed_actual" && body.kind !== "acknowledged_unknown") {
    return { ok: false, error: "kind must be observed_actual or acknowledged_unknown" }
  }
  if (![body.actualCostUSD, body.input, body.output].every(validAmountOrNull)) {
    return { ok: false, error: "amount and token fields must be finite nonnegative values or null" }
  }
  if (!boundedText(body.evidenceReference, 1024) || !isSha256(body.evidenceSHA256) ||
    !boundedText(body.operator, 256) || !boundedText(body.approvalReference, 1024)) {
    return { ok: false, error: "evidence, operator, approval reference, and evidence digest are required" }
  }

  if (body.kind === "observed_actual") {
    if (body.usageDate === null || body.actualCostUSD === null || body.input === null || body.output === null ||
      !boundedText(body.assistantMessageID)) {
      return { ok: false, error: "observed_actual requires measured amounts and assistantMessageID" }
    }
    if (body.acceptUnknownRisk !== undefined) {
      return { ok: false, error: "acceptUnknownRisk is only valid for acknowledged_unknown" }
    }
  } else {
    if (body.usageDate !== null || body.actualCostUSD !== null || body.input !== null || body.output !== null ||
      body.assistantMessageID !== undefined || body.acceptUnknownRisk !== true) {
      return { ok: false, error: "acknowledged_unknown requires null amounts, no assistant id, and acceptUnknownRisk true" }
    }
  }

  return {
    ok: true,
    value: {
      receiptID: body.receiptID as string,
      conversationID: body.conversationID as string,
      sessionID: body.sessionID as string,
      reservationID: body.reservationID as string,
      originDate: body.originDate,
      usageDate: body.usageDate as string | null,
      expectedLedgerSnapshotID: body.expectedLedgerSnapshotID,
      expectedLocalSnapshotID: body.expectedLocalSnapshotID,
      quiescence,
      quiescenceDigest: body.quiescenceDigest,
      kind: body.kind,
      actualCostUSD: body.actualCostUSD as number | null,
      input: body.input as number | null,
      output: body.output as number | null,
      ...(body.assistantMessageID === undefined ? {} : { assistantMessageID: body.assistantMessageID as string }),
      evidenceReference: body.evidenceReference as string,
      evidenceSHA256: body.evidenceSHA256,
      operator: body.operator as string,
      approvalReference: body.approvalReference as string,
      ...(body.acceptUnknownRisk === true ? { acceptUnknownRisk: true } : {}),
    },
  }
}

/** Fixed field order binds exactly the allowed proposal, independent of JSON key order. */
export function canonicalOperatorReconciliationProposal(proposal: OperatorReconciliationProposal): string {
  return JSON.stringify(PROPOSAL_FIELDS.map((field) => [field, proposal[field] ?? null]))
}

export async function operatorReconciliationDigest(proposal: OperatorReconciliationProposal): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalOperatorReconciliationProposal(proposal))
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function operatorReceiptKey(receiptID: string): string {
  return `operator-reconciliation:receipt:${receiptID}`
}

export function operatorOwnerKey(conversationID: string, reservationID: string): string {
  return `operator-reconciliation:owner:${JSON.stringify([conversationID, reservationID])}`
}

export function operatorCoverageKey(conversationID: string, sessionID: string, assistantMessageID: string): string {
  return `operator-reconciliation:coverage:${JSON.stringify([conversationID, sessionID, assistantMessageID])}`
}

export function operatorOverlapWarningKey(conversationID: string, sessionID: string): string {
  return `operator-reconciliation:overlap:${JSON.stringify([conversationID, sessionID])}`
}
