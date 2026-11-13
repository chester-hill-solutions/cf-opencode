import { makeClient, portFetch } from "../opencode"
import type { ConversationStore, ConversationState } from "../state"
import type { ConversationRuntime } from "./runtime"
import type { ConversationUsage, UsageCutoverLedger } from "./usage"
import type { ConversationRecoveryActions } from "./recovery-actions"
import type { MessageInfo } from "../messages"
import { isSettled, turnMessages, toMillis } from "../messages"
import { classifyRecovery, recoverySnapshotID, type RecoveryAuthority, type RecoveryRetirement } from "../recovery"
import { ACCOUNTING_POLICY_ID, assertAccountingPolicy } from "../accounting-policy"
import { proveRuntimeQuiescence } from "../runtime-quiescence"
import {
  hashOperatorQuiescence,
  operatorReconciliationDigest,
  type OperatorReconciliationKind,
  type OperatorReconciliationProposal,
  type OperatorReconciliationReceipt,
} from "../operator-reconciliation"

type UnknownRecord = Record<string, unknown>
type OperatorReconciliationDraft = Omit<OperatorReconciliationProposal, "operator" | "approvalReference" | "acceptUnknownRisk">
type OperatorReconciliationPreviewResult =
  | { ok: true; draft: OperatorReconciliationDraft; body: UnknownRecord }
  | { ok: false; status: number; error: string; blockers?: string[] }

const CONTROL_PORT = 4001

export interface ReconciliationSettingsPort {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>
}

export interface ConversationReconciliationOptions {
  storage: DurableObjectStorage
  store: ConversationStore
  usage: ConversationUsage
  recoveryActions: ConversationRecoveryActions
  runtime: ConversationRuntime
  conversationID: string
  settings(): ReconciliationSettingsPort
  withAdmissionLock<T>(task: () => Promise<T>): Promise<T>
  live(): { admitting: boolean; pumping: boolean }
  withClient<T>(fn: (client: ReturnType<typeof makeClient>) => Promise<T>, recoverOnRejection?: boolean): Promise<T>
  ensureReady(): Promise<unknown>
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validDateString(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(value + "T00:00:00.000Z")
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function sameOperatorReview(draft: OperatorReconciliationDraft, proposal: OperatorReconciliationProposal): boolean {
  const fields: Array<keyof OperatorReconciliationDraft> = [
    "receiptID", "conversationID", "sessionID", "reservationID", "originDate", "usageDate",
    "expectedLedgerSnapshotID", "expectedLocalSnapshotID", "quiescence", "quiescenceDigest",
    "kind", "actualCostUSD", "input", "output", "assistantMessageID", "evidenceReference", "evidenceSHA256",
  ]
  return JSON.stringify(fields.map((field) => [field, draft[field] ?? null])) ===
    JSON.stringify(fields.map((field) => [field, proposal[field] ?? null]))
}

/** Operator-reviewed reconciliation preview and receipt application for one conversation. */
export class ConversationReconciliation {
  constructor(private readonly options: ConversationReconciliationOptions) {}

  async preview(kind: OperatorReconciliationKind): Promise<Response> {
    return this.options.withAdmissionLock(async () => {
      const live = this.options.live()
      if (live.admitting || live.pumping || this.options.recoveryActions.active) {
        return Response.json({ error: "conversation has a live local operation" }, { status: 409 })
      }
      try {
        return await this.options.recoveryActions.runAction(() => this.options.usage.serialize(async () => {
          const result = await this.buildDraft(kind)
          if (!result.ok) {
            return Response.json({ error: result.error, ...(result.blockers ? { blockers: result.blockers } : {}) }, { status: result.status })
          }
          return Response.json(result.body)
        }))
      } catch {
        return Response.json({ error: "reconciliation preview could not be verified", retryable: true }, { status: 503 })
      }
    })
  }

  private async buildDraft(kind: OperatorReconciliationKind): Promise<OperatorReconciliationPreviewResult> {
    const conversationID = this.options.conversationID
    const state = await this.options.store.get()
    const live = this.options.live()
    if (live.admitting || live.pumping || !this.options.recoveryActions.active || state.queued) {
      return { ok: false, status: 409, error: "conversation has live or queued work" }
    }
    const reservation = state.budgetReservation
    const sessionID = state.sessionID
    if (!reservation || reservation.dispatched !== true || !validDateString(reservation.date) || !sessionID) {
      return { ok: false, status: 409, error: "a dispatched dated reservation and current session are required" }
    }

    let authorityLedger: UsageCutoverLedger
    let central: UnknownRecord
    try {
      authorityLedger = await this.options.usage.ledger(reservation.reservationID)
      central = await this.operatorReconciliationSnapshot(conversationID, sessionID, reservation.reservationID)
    } catch {
      return { ok: false, status: 503, error: "reconciliation authority is unavailable" }
    }
    const matchingHolds = authorityLedger.holds.filter((hold) =>
      hold.kind === "reservation" && hold.conversationID === conversationID &&
      hold.reservationID === reservation.reservationID && hold.date === reservation.date,
    )
    if (authorityLedger.conversationID !== conversationID || authorityLedger.blockers.length ||
      authorityLedger.legacyRows.length || authorityLedger.receipt || authorityLedger.holds.length !== 1 ||
      matchingHolds.length !== 1 || authorityLedger.retirement) {
      return { ok: false, status: 409, error: "central hold ownership or accounting history is ambiguous", blockers: ["central_authority_blocked"] }
    }
    if (central.conversationID !== conversationID || central.sessionID !== sessionID ||
      central.reservationID !== reservation.reservationID || central.originDate !== reservation.date ||
      typeof central.snapshotID !== "string" || !/^[a-f0-9]{64}$/.test(central.snapshotID) ||
      !Array.isArray(central.blockers) || central.blockers.length !== 0 ||
      !isRecord(central.hold) || central.hold.conversationID !== conversationID ||
      central.hold.reservationID !== reservation.reservationID || central.hold.date !== reservation.date ||
      typeof central.hold.costUSD !== "number" || !Number.isFinite(central.hold.costUSD) || central.hold.costUSD < 0 ||
      !isRecord(central.projectedDayBasis) || !Array.isArray(central.observedActualBlockers)) {
      return { ok: false, status: 409, error: "central reconciliation snapshot is blocked", blockers: ["central_snapshot_invalid"] }
    }
    const projectedBasis = central.projectedDayBasis
    if (projectedBasis.basis !== "historical_origin_date_attribution" || projectedBasis.date !== reservation.date ||
      ![projectedBasis.actualUSD, projectedBasis.reservedUSD, projectedBasis.attributedUSD]
        .every((amount) => typeof amount === "number" && Number.isFinite(amount) && amount >= 0) ||
      !isRecord(central.currentBudgetBasis) ||
      !central.observedActualBlockers.every((blocker) => typeof blocker === "string")) {
      return { ok: false, status: 409, error: "central projected accounting basis is malformed", blockers: ["central_basis_invalid"] }
    }
    const budgetBasis = central.currentBudgetBasis
    if (!validDateString(budgetBasis.date) ||
      ![budgetBasis.actualUSD, budgetBasis.reservedUSD, budgetBasis.budgetUSD, budgetBasis.admittedUSD]
        .every((amount) => typeof amount === "number" && Number.isFinite(amount) && amount >= 0) ||
      !(budgetBasis.remainingUSD === null || typeof budgetBasis.remainingUSD === "number" &&
        Number.isFinite(budgetBasis.remainingUSD) && budgetBasis.remainingUSD >= 0) ||
      !Array.isArray(budgetBasis.blockers) || budgetBasis.blockers.length) {
      return { ok: false, status: 409, error: "current budget basis is malformed", blockers: ["current_budget_basis_invalid"] }
    }
    if (kind === "observed_actual" && central.observedActualBlockers.length) {
      return { ok: false, status: 409, error: "existing usage has ambiguous session ownership", blockers: central.observedActualBlockers as string[] }
    }
    if (central.existingReceipt) {
      return { ok: false, status: 409, error: "this reservation already has a reconciliation receipt" }
    }

    const authority: RecoveryAuthority = {
      conversationID,
      snapshotID: authorityLedger.snapshotID,
      holds: authorityLedger.holds,
      legacyRows: authorityLedger.legacyRows,
      ...(authorityLedger.retirement ? { retirement: authorityLedger.retirement } : {}),
    }
    const classification = classifyRecovery({ conversationID, state, authority, live: { admitting: false, pumping: false } })
    if (classification.kind !== "dispatched" || classification.blockers.length) {
      return { ok: false, status: 409, error: "local reservation ownership is not safe to reconcile", blockers: classification.blockers }
    }

    let evidence: Awaited<ReturnType<typeof proveRuntimeQuiescence>>
    try {
      evidence = await this.options.withClient((client) => proveRuntimeQuiescence({
        client,
        sessionID,
        getRuntimeGeneration: async (signal) => {
          const control = await this.options.runtime.port(CONTROL_PORT)
          const response = await control.fetch("http://container/start", { method: "POST", signal })
          if (!response.ok) throw new Error("runtime proof unavailable")
          const proof = await response.json() as UnknownRecord
          if (proof.ok !== true || proof.accountingPolicy !== ACCOUNTING_POLICY_ID ||
            typeof proof.opencodeGeneration !== "string" || !proof.opencodeGeneration) {
            throw new Error("runtime generation proof invalid")
          }
          this.options.runtime.recordGeneration(proof.opencodeGeneration)
          return proof.opencodeGeneration
        },
      }), false)
    } catch {
      return { ok: false, status: 409, error: "native session quiescence could not be proved", blockers: ["quiescence_unverified"] }
    }

    const reviewState = await this.options.store.get()
    const reviewLedger = await this.options.usage.ledger(reservation.reservationID).catch(() => undefined)
    const reviewCentral = await this.operatorReconciliationSnapshot(conversationID, sessionID, reservation.reservationID).catch(() => undefined)
    if (!reviewLedger || !reviewCentral || reviewState.sessionID !== sessionID || reviewState.queued ||
      reviewState.budgetReservation?.reservationID !== reservation.reservationID ||
      reviewState.budgetReservation?.date !== reservation.date || reviewState.budgetReservation?.dispatched !== true ||
      reviewCentral.snapshotID !== central.snapshotID || reviewLedger.snapshotID !== authorityLedger.snapshotID) {
      return { ok: false, status: 409, error: "reconciliation evidence changed while quiescence was checked", blockers: ["snapshot_changed"] }
    }
    const reviewAuthority: RecoveryAuthority = {
      conversationID,
      snapshotID: reviewLedger.snapshotID,
      holds: reviewLedger.holds,
      legacyRows: reviewLedger.legacyRows,
      ...(reviewLedger.retirement ? { retirement: reviewLedger.retirement } : {}),
    }
    const reviewClassification = classifyRecovery({
      conversationID, state: reviewState, authority: reviewAuthority,
      live: { admitting: false, pumping: false },
    })
    if (reviewClassification.kind !== "dispatched" || reviewClassification.blockers.length) {
      return { ok: false, status: 409, error: "local reservation ownership changed during quiescence", blockers: reviewClassification.blockers }
    }

    let usageDate: string | null = null
    let actualCostUSD: number | null = null
    let input: number | null = null
    let output: number | null = null
    let assistantMessageID: string | undefined
    let evidenceReference = "opencode://session/" + encodeURIComponent(sessionID) + "/quiescent-context"
    if (kind === "observed_actual") {
      const messages = evidence.context as MessageInfo[]
      const baseline = reviewState.turnBaseline
      const runStartedAt = reviewState.runStartedAt
      if (!Array.isArray(messages) ||
        (baseline !== undefined && (typeof baseline !== "string" || !baseline || !messages.some((message) => message.id === baseline))) ||
        typeof runStartedAt !== "number" || !Number.isFinite(runStartedAt) || runStartedAt <= 0 ||
        !isSettled(messages, baseline)) {
        return { ok: false, status: 409, error: "a settled current-turn assistant with exact usage is unavailable", blockers: ["settled_assistant_usage_missing"] }
      }
      const currentTurn = baseline ? turnMessages(messages, baseline) : messages
      const users = currentTurn.filter((message) => message.type === "user")
      const assistants = currentTurn.filter((message) => message.type === "assistant")
      // This first reconciliation slice only imports a single assistant step.
      // Tool-call continuations and auxiliary assistant entries can each carry
      // billable usage, so summing or selecting only the final step is unsafe.
      const terminal = assistants.length === 1 ? assistants[0] : undefined
      const userCreated = users[0]?.time?.created
      const assistantCreated = terminal?.time?.created
      const completed = terminal?.time?.completed
      const tokens = terminal?.tokens
      const incomplete: string[] = []
      if (currentTurn.some((message) => !["user", "assistant", "idle", "model-switched"].includes(message.type ?? ""))) {
        incomplete.push("current_turn_contains_unpriced_or_auxiliary_entries")
      }
      if (users.length !== 1) incomplete.push("current_turn_user_boundary_ambiguous")
      if (assistants.length !== 1) incomplete.push("current_turn_assistant_steps_ambiguous")
      if (typeof userCreated !== "number" || !Number.isFinite(userCreated) || userCreated <= 0 ||
        toMillis(userCreated) < runStartedAt) incomplete.push("current_turn_user_time_unverified")
      if (typeof assistantCreated !== "number" || !Number.isFinite(assistantCreated) || assistantCreated <= 0 ||
        toMillis(assistantCreated) < runStartedAt ||
        typeof userCreated === "number" && toMillis(assistantCreated) < toMillis(userCreated)) {
        incomplete.push("assistant_creation_time_unverified")
      }
      if (!terminal?.id) incomplete.push("assistant_id_missing")
      if (typeof completed !== "number" || !Number.isFinite(completed) || completed <= 0 ||
        toMillis(completed) < runStartedAt ||
        typeof assistantCreated === "number" && toMillis(completed) < toMillis(assistantCreated)) incomplete.push("completed_time_missing_or_unordered")
      if (typeof terminal?.cost !== "number" || !Number.isFinite(terminal.cost) || terminal.cost < 0) incomplete.push("assistant_cost_missing")
      if (typeof tokens?.input !== "number" || !Number.isFinite(tokens.input) || tokens.input < 0) incomplete.push("input_tokens_missing")
      if (typeof tokens?.output !== "number" || !Number.isFinite(tokens.output) || tokens.output < 0) incomplete.push("output_tokens_missing")
      if (incomplete.length) return { ok: false, status: 409, error: "terminal assistant usage fields are incomplete", blockers: incomplete }
      usageDate = new Date(toMillis(completed as number)).toISOString().slice(0, 10)
      if (usageDate !== reservation.date) {
        return { ok: false, status: 409, error: "cross-midnight observed usage requires a separate reviewed projection", blockers: ["usage_date_differs_from_reservation_date"] }
      }
      actualCostUSD = terminal!.cost as number
      input = tokens!.input as number
      output = tokens!.output as number
      assistantMessageID = terminal!.id
      const source = baseline ? "settled-current-turn" : "first-turn-context-and-timing"
      evidenceReference = "opencode://session/" + encodeURIComponent(sessionID) + "/assistant/" +
        encodeURIComponent(assistantMessageID as string) + "?source=" + source
    }

    const localSnapshot = await recoverySnapshotID({
      conversationID,
      state: reviewState,
      authority: reviewAuthority,
      live: { admitting: false, pumping: false },
    })
    const draftBase = {
      conversationID,
      sessionID,
      reservationID: reservation.reservationID,
      originDate: reservation.date,
      usageDate,
      expectedLedgerSnapshotID: central.snapshotID as string,
      expectedLocalSnapshotID: localSnapshot,
      quiescence: evidence.proof,
      quiescenceDigest: evidence.digest,
      kind,
      actualCostUSD,
      input,
      output,
      ...(assistantMessageID ? { assistantMessageID } : {}),
      evidenceReference,
      evidenceSHA256: evidence.proof.contextDigest,
    } satisfies Omit<OperatorReconciliationDraft, "receiptID">
    const receiptID = "operator-" + (await sha256Hex(JSON.stringify(draftBase))).slice(0, 40)
    const draft: OperatorReconciliationDraft = { receiptID, ...draftBase }

    const basis = central.projectedDayBasis as Record<string, unknown>
    const holdUSD = central.hold.costUSD as number
    const actualUSD = kind === "observed_actual" ? actualCostUSD as number : 0
    const historicalAfter = Math.max(0, (basis.attributedUSD as number) - holdUSD + actualUSD)
    const currentBefore = budgetBasis as Record<string, unknown>
    const currentActualAfter = (currentBefore.actualUSD as number) +
      (kind === "observed_actual" && usageDate === currentBefore.date ? actualUSD : 0)
    const currentReservedAfter = Math.max(0, (currentBefore.reservedUSD as number) - holdUSD)
    const currentAdmittedAfter = currentActualAfter + currentReservedAfter
    const currentBudgetUSD = currentBefore.budgetUSD as number
    const currentRemainingAfter = currentBudgetUSD > 0 ? Math.max(0, currentBudgetUSD - currentAdmittedAfter) : null
    const amount = kind === "observed_actual"
      ? "Measured actual: $" + actualUSD.toFixed(7) + "; " + input + " input / " + output + " output tokens."
      : "Actual amount: unknown (null, not $0). Releasing the $" + holdUSD.toFixed(4) + " reservation does not establish that no historical charge occurred."
    const body: UnknownRecord = {
      ok: true,
      canApply: true,
      kind,
      proposal: draft,
      evidence: kind === "observed_actual"
        ? {
            source: reviewState.turnBaseline ? "settled_current_turn_assistant" : "first_turn_context_and_timing",
            assistantMessageID,
            usageDate,
            ...(reviewState.turnBaseline ? {} : {
              attributionLimit: "Uses the sole timestamped user/assistant turn after runStartedAt; no prompt ID proves exclusivity, so this requires operator review of an isolated run with no other writer.",
            }),
          }
        : { source: "quiescent_session_context", usageDate: null },
      accounting: {
        originDate: reservation.date,
        usageDate,
        reservationUSD: holdUSD,
        historicalOriginDateAttribution: {
          date: basis.date,
          beforeUSD: basis.attributedUSD,
          afterUSD: historicalAfter,
        },
        currentBudget: {
          date: currentBefore.date,
          reportedSpendBeforeUSD: currentBefore.actualUSD,
          reportedSpendAfterUSD: currentActualAfter,
          reservedBeforeUSD: currentBefore.reservedUSD,
          reservedAfterUSD: currentReservedAfter,
          admittedBeforeUSD: currentBefore.admittedUSD,
          admittedAfterUSD: currentAdmittedAfter,
          budgetUSD: currentBudgetUSD,
          remainingBeforeUSD: currentBefore.remainingUSD,
          remainingAfterUSD: currentRemainingAfter,
        },
        uncertainty: kind === "acknowledged_unknown"
          ? "Reported spend and available headroom exclude any possible historical charge represented by this unknown amount."
          : "Measured from the settled assistant usage fields; provider billing may differ.",
        summary: amount,
      },
      localSnapshotID: localSnapshot,
      centralSnapshotID: central.snapshotID,
    }
    return { ok: true, draft, body }
  }

  private async operatorReconciliationSnapshot(
    conversationID: string,
    sessionID: string,
    reservationID: string,
  ): Promise<UnknownRecord> {
    const query = new URLSearchParams({ conversationID, sessionID, reservationID })
    const response = await this.options.settings().fetch("https://settings/usage/reconciliation?" + query)
    if (!response.ok) throw new Error("operator reconciliation snapshot unavailable")
    const value: unknown = await response.json()
    if (!isRecord(value)) throw new Error("operator reconciliation snapshot malformed")
    return value
  }

  async apply(proposal: OperatorReconciliationProposal): Promise<Response> {
    if (proposal.conversationID !== this.options.conversationID) {
      return Response.json({ error: "conversation owner does not match this route" }, { status: 409 })
    }
    if (await hashOperatorQuiescence(proposal.quiescence) !== proposal.quiescenceDigest) {
      return Response.json({ error: "quiescence proof digest does not match" }, { status: 400 })
    }

    return this.options.withAdmissionLock(async () => {
      const live = this.options.live()
      if (live.admitting || live.pumping || this.options.recoveryActions.active) {
        return Response.json({ error: "conversation has a live local operation" }, { status: 409 })
      }
      try {
        return await this.options.recoveryActions.runAction(() => this.options.usage.serialize(async () => {
          const digest = await operatorReconciliationDigest(proposal)
          const central = await this.operatorReconciliationSnapshot(
            proposal.conversationID, proposal.sessionID, proposal.reservationID,
          ).catch(() => undefined)
          if (!central) return Response.json({ error: "reconciliation authority is unavailable" }, { status: 503 })
          const existingReceipt = isRecord(central.existingReceipt)
            ? central.existingReceipt as unknown as OperatorReconciliationReceipt
            : undefined
          const completeRetirement = async (): Promise<RecoveryRetirement & { operatorReceiptID?: string } | undefined> => {
            const ledger = await this.options.usage.ledger(proposal.reservationID).catch(() => undefined)
            const retirement = ledger?.retirement
            return retirement?.conversationID === proposal.conversationID &&
              retirement.reservationID === proposal.reservationID && retirement.date === proposal.originDate &&
              retirement.reason === "released" && retirement.released === true &&
              retirement.operatorReceiptID === proposal.receiptID
              ? retirement
              : undefined
          }
          if (existingReceipt) {
            if (existingReceipt.requestDigest !== digest || existingReceipt.receiptID !== proposal.receiptID ||
              existingReceipt.conversationID !== proposal.conversationID || existingReceipt.sessionID !== proposal.sessionID ||
              existingReceipt.reservationID !== proposal.reservationID) {
              return Response.json({ error: "a conflicting reconciliation receipt already exists" }, { status: 409 })
            }
            const retirement = await completeRetirement()
            if (!retirement) return Response.json({ error: "central receipt retirement is not confirmed" }, { status: 503 })
            return this.clearAcknowledgedOperatorReservation(proposal, existingReceipt, retirement, true)
          }

          const preview = await this.buildDraft(proposal.kind)
          if (!preview.ok) {
            return Response.json({ error: preview.error, ...(preview.blockers ? { blockers: preview.blockers } : {}) }, { status: preview.status })
          }
          if (!sameOperatorReview(preview.draft, proposal)) {
            return Response.json({ error: "proposal no longer matches the reviewed preview" }, { status: 409 })
          }
          const response = await this.options.settings().fetch("https://settings/usage/reconciliation", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(proposal),
          })
          const result: unknown = await response.json().catch(() => undefined)
          if (!response.ok) {
            return Response.json(isRecord(result) ? result : { error: "central reconciliation rejected" }, { status: response.status })
          }
          if (!isRecord(result) || result.ok !== true || !isRecord(result.receipt) || !isRecord(result.retirement)) {
            return Response.json({ error: "central reconciliation acknowledgement is unreadable" }, { status: 502 })
          }
          const receipt = result.receipt as unknown as OperatorReconciliationReceipt
          const retirement = result.retirement as unknown as RecoveryRetirement & { operatorReceiptID?: string }
          if (receipt.requestDigest !== digest || receipt.receiptID !== proposal.receiptID ||
            receipt.conversationID !== proposal.conversationID || receipt.sessionID !== proposal.sessionID ||
            receipt.reservationID !== proposal.reservationID || retirement.conversationID !== proposal.conversationID ||
            retirement.reservationID !== proposal.reservationID || retirement.date !== proposal.originDate ||
            retirement.reason !== "released" || retirement.released !== true || retirement.operatorReceiptID !== proposal.receiptID ||
            typeof receipt.createdAt !== "number" || !Number.isFinite(receipt.createdAt) || receipt.createdAt <= 0) {
            return Response.json({ error: "central reconciliation receipt did not match the reviewed owner" }, { status: 502 })
          }
          return this.clearAcknowledgedOperatorReservation(proposal, receipt, retirement, Boolean(result.replayed))
        }))
      } catch {
        return Response.json({ error: "operator reconciliation could not be completed", retryable: true }, { status: 503 })
      }
    })
  }

  private async clearAcknowledgedOperatorReservation(
    proposal: OperatorReconciliationProposal,
    receipt: OperatorReconciliationReceipt,
    retirement: RecoveryRetirement & { operatorReceiptID?: string },
    replayed: boolean,
  ): Promise<Response> {
    const state = await this.options.store.get()
    const marker = {
      receiptID: receipt.receiptID,
      reservationID: receipt.reservationID,
      kind: receipt.kind,
      createdAt: receipt.createdAt,
      usageDate: receipt.usageDate,
      actualCostUSD: receipt.actualCostUSD,
    } as const
    if (!state.budgetReservation) {
      if (state.operatorReconciliation?.receiptID === receipt.receiptID && state.sessionID === proposal.sessionID) {
        return Response.json({ ok: true, replayed: true, localCleared: false, receipt: marker, retirement })
      }
      return Response.json({ error: "central receipt exists, but the local reservation owner has changed" }, { status: 409 })
    }
    const cleared = await this.options.store.clearOperatorReconciledReservation({
      sessionID: proposal.sessionID,
      reservationID: proposal.reservationID,
      date: proposal.originDate,
      marker,
    })
    if (!cleared) return Response.json({ error: "central receipt exists, but the local owner or work changed" }, { status: 409 })
    return Response.json({ ok: true, replayed, localCleared: true, receipt: marker, retirement })
  }
}
