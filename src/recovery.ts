import { isContainerIdleRecord } from "./conversation/idle-state"
import type { BudgetReservation, ConversationState } from "./state"
import { isConversationLeaseRecord } from "./conversation/lease-state"
import { TURN_TIMEOUT_MS } from "./lifecycle"

const RECOVERY_ACTIONS = ["retry", "cancel_before_dispatch", "force_stop", "abandon"] as const

export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number]

/** True for the operator actions this build understands. */
export function isRecoveryAction(value: unknown): value is RecoveryAction {
  return typeof value === "string" && (RECOVERY_ACTIONS as readonly string[]).includes(value)
}

/** Parse one operator recovery request: an action and a SHA-256 snapshot. */
export function recoveryRequest(value: unknown): { action: RecoveryAction; expectedSnapshotID: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => key !== "action" && key !== "expectedSnapshotID")) return undefined
  const { action, expectedSnapshotID } = record
  if (!isRecoveryAction(action) || typeof expectedSnapshotID !== "string" || !/^[a-f0-9]{64}$/.test(expectedSnapshotID)) return undefined
  return { action, expectedSnapshotID }
}

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

/** A dispatched turn past its deadline may be force-stopped by an operator. */
function dispatchedClassification(state: ConversationState, blockers: string[]): RecoveryClassification {
  const overdue = typeof state.runStartedAt === "number" && state.runStartedAt > 0 &&
    Date.now() - state.runStartedAt >= TURN_TIMEOUT_MS
  return { kind: "dispatched", blockers, actions: overdue ? ["retry", "force_stop", "abandon"] : ["retry"] }
}

export interface RecoveryLiveState {
  admitting: boolean
  pumping: boolean
}

export interface RecoveryClassification {
  kind: "none" | "undispatched" | "dispatched" | "sealed_idle" | "blocked" | "orphaned"
  blockers: string[]
  actions: RecoveryAction[]
}

export interface RecoveryQueueSummary {
  depth: number
  head: null | {
    id: string
    source: string
    enqueuedAt: number
    attempts: number
    nextAttemptAt: number | null
    lastError: string | null
  }
}

/** Read-only queue metadata; prompt contents are never part of recovery evidence. */
export function recoveryQueueSummary(state: ConversationState): RecoveryQueueSummary {
  const queue = state.queue ?? []
  const head = queue[0]
  return {
    depth: queue.length,
    head: head ? {
      id: head.id,
      source: head.source,
      enqueuedAt: head.enqueuedAt,
      attempts: head.attempts,
      nextAttemptAt: head.nextAttemptAt ?? null,
      lastError: head.lastError ?? null,
    } : null,
  }
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
    if ((state.phase ?? "idle") !== "idle" || (state.queue?.length ?? 0) > 0) blockers.push("work_without_local_reservation")
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
    return classificationWithoutReservation(state, blockers)
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
    return dispatchedClassification(state, blockers)
  }

  if ((state.queue?.length ?? 0) > 0) blockers.push("queued_work_present")
  if (cachedExecutionMalformed) blockers.push("cached_execution_malformed")
  if (cachedExecutionSessionMismatch) blockers.push("cached_execution_session_mismatch")
  if (cachedExecutionActive) blockers.push("cached_execution_unfinished")
  const phase = state.phase ?? "idle"
  if (phase !== "idle" && phase !== "admitting") blockers.push("phase_not_pre_dispatch")
  if (blockers.length) return { kind: "blocked", blockers, actions: [] }
  return undispatchedClassification(state, blockers)
}

/** With no local reservation, leftover prompts are the only recoverable state. */
function classificationWithoutReservation(state: ConversationState, blockers: string[]): RecoveryClassification {
  if (blockers.length) return { kind: "blocked", blockers, actions: [] }
  if (Object.keys(state.pending ?? {}).length > 0) return { kind: "orphaned", blockers, actions: ["abandon"] }
  return { kind: "none", blockers, actions: [] }
}

/**
 * A turn that ended without clearing its permission prompts leaves residue that
 * blocks cleanup forever, so it is abandonable rather than merely undispatched.
 */
function undispatchedClassification(state: ConversationState, blockers: string[]): RecoveryClassification {
  if (Object.keys(state.pending ?? {}).length > 0) return { kind: "orphaned", blockers, actions: ["abandon"] }
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
      queue: recoveryQueueSummary(state),
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
