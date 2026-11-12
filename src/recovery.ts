import type { BudgetReservation, ConversationState } from "./state"

export interface RecoveryRetirement {
  conversationID: string
  reservationID: string
  date?: string
  reason: "released" | "cancelled_before_dispatch"
  retiredAt: number
  released?: boolean
}

export interface RecoveryHold {
  conversationID?: string
  reservationID?: string
  date?: string
  kind: "reservation" | "legacy-reservation"
  invalidFields?: string[]
  costUSD?: number | null
}

export interface RecoveryAuthority {
  conversationID: string
  snapshotID: string
  holds: RecoveryHold[]
  legacyRows: unknown[]
  retirement?: RecoveryRetirement
}

export interface RecoveryLiveState {
  admitting: boolean
  pumping: boolean
}

export interface RecoveryClassification {
  kind: "none" | "undispatched" | "dispatched" | "blocked"
  blockers: string[]
  actions: Array<"cancel_before_dispatch" | "retry">
}

function validReservation(value: unknown): value is BudgetReservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const reservation = value as Record<string, unknown>
  return typeof reservation.reservationID === "string" && reservation.reservationID.length > 0 &&
    typeof reservation.dispatched === "boolean" &&
    (reservation.date === undefined || (typeof reservation.date === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(reservation.date)))
}

function validExecution(value: unknown): value is NonNullable<ConversationState["usageExecution"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const execution = value as Record<string, unknown>
  return typeof execution.sessionID === "string" && execution.sessionID.length > 0 &&
    [execution.startedSeq, execution.terminalSeq, execution.latestStepSeq].every((seq) =>
      typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0,
    )
}

/** Classify only from persisted ownership and explicitly labelled cached fences. */
export function classifyRecovery(input: {
  conversationID: string
  state: ConversationState
  authority?: RecoveryAuthority
  live: RecoveryLiveState
}): RecoveryClassification {
  const { conversationID, state, authority, live } = input
  const blockers: string[] = []
  const reservationValue: unknown = state.budgetReservation
  const reservation = validReservation(reservationValue) ? reservationValue : undefined
  if (reservationValue !== undefined && !reservation) blockers.push("local_reservation_malformed")
  if (reservation?.dispatched === true && reservation.date === undefined) {
    blockers.push("dispatched_reservation_origin_date_missing")
  }
  if (!authority) blockers.push("settings_authority_unavailable")
  else if (authority.conversationID !== conversationID) blockers.push("settings_conversation_mismatch")

  if (live.admitting || live.pumping) blockers.push("live_local_operation")
  const executionValue: unknown = state.usageExecution
  const execution = executionValue === undefined || validExecution(executionValue) ? executionValue : undefined
  const cachedExecutionMalformed = executionValue !== undefined && !validExecution(executionValue)
  const cachedExecutionSessionMismatch = execution !== undefined && execution.sessionID !== state.sessionID
  const cachedExecutionActive = execution !== undefined && execution.sessionID === state.sessionID &&
    (execution.startedSeq > execution.terminalSeq || execution.latestStepSeq > execution.terminalSeq)

  if (!reservation) {
    if (authority?.holds.length) blockers.push("central_hold_without_local_owner")
    if ((state.phase ?? "idle") !== "idle" || state.queued) blockers.push("work_without_local_reservation")
    return { kind: blockers.length ? "blocked" : "none", blockers, actions: [] }
  }

  const matching = authority?.holds.filter((hold) =>
    hold.conversationID === conversationID && hold.reservationID === reservation.reservationID,
  ) ?? []
  const otherHolds = authority?.holds.filter((hold) =>
    hold.conversationID !== conversationID || hold.reservationID !== reservation.reservationID,
  ) ?? []
  if (otherHolds.length) blockers.push("central_ownership_mismatch")
  if (matching.length > 1) blockers.push("duplicate_central_owner")
  if (reservation.date !== undefined && matching.some((hold) => hold.date !== reservation.date)) {
    blockers.push("central_origin_date_mismatch")
  }
  if (authority?.holds.some((hold) => hold.kind === "legacy-reservation")) blockers.push("legacy_hold")
  if (authority?.holds.some((hold) => hold.invalidFields?.length || !hold.conversationID || !hold.reservationID)) {
    blockers.push("central_hold_malformed")
  }

  const retirement = authority?.retirement
  if (retirement && (retirement.conversationID !== conversationID ||
    retirement.reservationID !== reservation.reservationID)) {
    blockers.push("retirement_owner_mismatch")
  }
  if (retirement && reservation.date !== undefined && retirement.date !== undefined &&
    retirement.date !== reservation.date) blockers.push("retirement_origin_date_mismatch")
  if (retirement && matching.length) blockers.push("retirement_still_has_central_hold")

  if (reservation.dispatched) {
    if (!state.sessionID) blockers.push("dispatched_session_missing")
    if (retirement?.reason === "cancelled_before_dispatch") blockers.push("dispatched_owner_was_cancelled")
    if (blockers.length) return { kind: "blocked", blockers, actions: [] }
    return { kind: "dispatched", blockers, actions: ["retry"] }
  }

  if (state.queued) blockers.push("queued_work_present")
  if (cachedExecutionMalformed) blockers.push("cached_execution_malformed")
  if (cachedExecutionSessionMismatch) blockers.push("cached_execution_session_mismatch")
  if (cachedExecutionActive) blockers.push("cached_execution_unfinished")
  const phase = state.phase ?? "idle"
  if (phase !== "idle" && phase !== "admitting") blockers.push("phase_not_pre_dispatch")
  if (blockers.length) return { kind: "blocked", blockers, actions: [] }
  return { kind: "undispatched", blockers, actions: ["cancel_before_dispatch"] }
}

/** Hash the exact local/authority/live evidence used for a recovery decision. */
export async function recoverySnapshotID(input: {
  conversationID: string
  state: ConversationState
  authority?: RecoveryAuthority
  live: RecoveryLiveState
}): Promise<string> {
  const state = input.state
  const snapshot = {
    conversationID: input.conversationID,
    local: {
      phase: state.phase ?? "idle",
      sessionID: state.sessionID ?? null,
      reservation: state.budgetReservation ?? null,
      queued: state.queued ? {
        present: true,
        attempts: state.queued.attempts,
        nextAttemptAt: state.queued.nextAttemptAt ?? null,
        lastError: state.queued.lastError ?? null,
      } : null,
      usageCursor: state.usageCursor ?? null,
      usageTerminal: state.usageTerminal ?? null,
      usageExecution: state.usageExecution ?? null,
      usageError: state.usageError ?? null,
      settlementError: state.settlementError ?? null,
      lastTurnError: state.lastTurnError ?? null,
    },
    authority: input.authority ? {
      conversationID: input.authority.conversationID,
      snapshotID: input.authority.snapshotID,
      holds: input.authority.holds,
      legacyRows: input.authority.legacyRows,
      retirement: input.authority.retirement ?? null,
    } : null,
    live: input.live,
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(snapshot)))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
