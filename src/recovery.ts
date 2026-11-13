import { isContainerIdleRecord } from "./conversation/idle-state"
import type { BudgetReservation, ConversationState } from "./state"
import { isConversationLeaseRecord } from "./conversation/lease-state"

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
  blockers?: unknown[]
  retirement?: RecoveryRetirement
}

/** Read-only scheduler/storage evidence for sealed idle recovery. */
export interface RecoverySchedulerEvidence {
  sealed: boolean
  epoch: number
  checkpointPending: boolean
  checkpointRetryAt?: number
  idleIntent?: unknown
  leaseIntent?: unknown
  claims?: unknown
  activeJobs: number
  pendingUpgrade: boolean
}

export interface RecoveryLiveState {
  admitting: boolean
  pumping: boolean
}

export interface RecoveryClassification {
  kind: "none" | "undispatched" | "dispatched" | "sealed_idle" | "blocked"
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

function schedulerEvidenceBlockers(scheduler: RecoverySchedulerEvidence): string[] {
  const blockers: string[] = []
  if (typeof scheduler.sealed !== "boolean") blockers.push("scheduler_seal_malformed")
  if (!Number.isSafeInteger(scheduler.epoch) || scheduler.epoch < 1) blockers.push("scheduler_epoch_malformed")
  if (typeof scheduler.checkpointPending !== "boolean") blockers.push("scheduler_checkpoint_state_malformed")
  if (scheduler.checkpointRetryAt !== undefined &&
    (!Number.isSafeInteger(scheduler.checkpointRetryAt) || scheduler.checkpointRetryAt < 0)) {
    blockers.push("scheduler_checkpoint_deadline_malformed")
  }
  if (typeof scheduler.activeJobs !== "number" || !Number.isSafeInteger(scheduler.activeJobs) || scheduler.activeJobs < 0) {
    blockers.push("scheduler_active_job_count_malformed")
  }
  if (typeof scheduler.pendingUpgrade !== "boolean") blockers.push("runtime_upgrade_state_malformed")
  if (scheduler.leaseIntent !== undefined && !isConversationLeaseRecord(scheduler.leaseIntent)) {
    blockers.push("lease_intent_malformed")
  }

  if (scheduler.idleIntent !== undefined && !isContainerIdleRecord(scheduler.idleIntent)) {
    blockers.push("idle_intent_malformed")
  }

  const claims = scheduler.claims
  if (claims === undefined) return blockers
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) {
    blockers.push("scheduler_claims_malformed")
    return blockers
  }
  for (const [name, value] of Object.entries(claims)) {
    if (!name || !value || typeof value !== "object" || Array.isArray(value)) {
      blockers.push("scheduler_claim_malformed")
      continue
    }
    const claim = value as Record<string, unknown>
    if (Object.keys(claim).some((key) => !["epoch", "claimID", "until"].includes(key)) ||
      !Number.isSafeInteger(claim.epoch) || (claim.epoch as number) < 1 ||
      typeof claim.claimID !== "string" || claim.claimID.length === 0 ||
      !Number.isSafeInteger(claim.until) || (claim.until as number) < 0) {
      blockers.push("scheduler_claim_malformed")
      continue
    }
    if (claim.epoch === scheduler.epoch && (claim.until as number) > Date.now()) {
      blockers.push("scheduler_claim_active")
    }
  }
  return blockers
}

/** Classify only from persisted ownership and explicitly labelled cached fences. */
export function classifyRecovery(input: {
  conversationID: string
  state: ConversationState
  authority?: RecoveryAuthority
  live: RecoveryLiveState
  scheduler?: RecoverySchedulerEvidence
}): RecoveryClassification {
  const { conversationID, state, authority, live, scheduler } = input
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
    if (scheduler) {
      blockers.push(...schedulerEvidenceBlockers(scheduler))
      if (scheduler.sealed) {
        if (!authority) blockers.push("settings_authority_unavailable")
        if (authority && authority.conversationID !== conversationID) blockers.push("settings_conversation_mismatch")
        if (authority?.legacyRows.length) blockers.push("legacy_usage_rows_present")
        if (authority?.blockers?.length) blockers.push("central_authority_blocked")
        if (scheduler.activeJobs !== 0) blockers.push("scheduler_jobs_active")
        if (scheduler.pendingUpgrade) blockers.push("runtime_upgrade_pending")

        if (cachedExecutionMalformed) blockers.push("cached_execution_malformed")
        else if (execution) {
          if (execution.sessionID !== state.sessionID) blockers.push("cached_execution_session_mismatch")
          if (execution.startedSeq > execution.terminalSeq || execution.latestStepSeq > execution.terminalSeq) {
            blockers.push("cached_execution_unfinished")
          }
        }
        if (blockers.length) return { kind: "blocked", blockers, actions: [] }
        return { kind: "sealed_idle", blockers, actions: ["retry"] }
      }
    }
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
  scheduler?: RecoverySchedulerEvidence
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
      blockers: input.authority.blockers,
      retirement: input.authority.retirement ?? null,
    } : null,
    live: input.live,
    ...(input.scheduler !== undefined ? { scheduler: input.scheduler } : {}),
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(snapshot)))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
