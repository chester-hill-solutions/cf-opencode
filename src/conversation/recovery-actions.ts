import { ConversationStore, type ConversationState } from "../state"
import type { ConversationUsage } from "./usage"
import { classifyRecovery, recoverySnapshotID, type RecoveryAuthority, type RecoverySchedulerEvidence } from "../recovery"
import { traceId } from "../telemetry"
import { emitConversationTelemetry } from "./telemetry"

type UnknownRecord = Record<string, unknown>

export interface RecoverySettingsPort {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>
}

export interface RecoveryJobsPort {
  epoch(): Promise<number>
  evidence(): Promise<RecoverySchedulerEvidence>
  resumeSealedIdle(evidence: RecoverySchedulerEvidence, state: ConversationState): Promise<void>
  scheduleRecovery(at: number, payload: {
    reservationID: string
    reservationDate?: string
    sessionID?: string
    reason: string
  }, allowSealed: boolean): Promise<void>
}

export interface RecoveryActionsOptions {
  storage: DurableObjectStorage
  store: ConversationStore
  usage: ConversationUsage
  settings: RecoverySettingsPort
  conversationID: string
  withAdmissionLock<T>(task: () => Promise<T>): Promise<T>
  live(): { admitting: boolean; pumping: boolean; activeJobs: number }
  jobs: RecoveryJobsPort
}

export class RecoveryActionBusyError extends Error {
  constructor() {
    super("conversation has a live local operation")
    this.name = "RecoveryActionBusyError"
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** Recovery status and operator actions for one conversation. */
export class ConversationRecoveryActions {
  private recoveryAction = false

  constructor(private readonly options: RecoveryActionsOptions) {}

  get active(): boolean {
    return this.recoveryAction
  }

  async status(): Promise<UnknownRecord> {
    const state = await this.options.store.get()
    const localReservation = isRecord(state.budgetReservation) &&
      typeof state.budgetReservation.reservationID === "string"
      ? state.budgetReservation.reservationID
      : undefined
    let ledger: Awaited<ReturnType<ConversationUsage["ledger"]>> | undefined
    let authority: RecoveryAuthority | undefined
    let authorityError: string | undefined
    try {
      ledger = await this.options.usage.ledger(localReservation)
      authority = {
        conversationID: ledger.conversationID,
        snapshotID: ledger.snapshotID,
        holds: ledger.holds,
        legacyRows: ledger.legacyRows,
        blockers: ledger.blockers,
        ...(ledger.retirement ? { retirement: ledger.retirement } : {}),
      }
    } catch (error) {
      authorityError = errorMessage(error)
    }
    const currentLive = this.options.live()
    const live = { admitting: currentLive.admitting, pumping: currentLive.pumping }
    const evidence = await this.options.jobs.evidence()
    const scheduler = evidence.sealed && state.budgetReservation === undefined ? evidence : undefined
    const classification = classifyRecovery({
      conversationID: this.options.conversationID, state, authority, live, ...(scheduler ? { scheduler } : {}),
    })
    const snapshotID = await recoverySnapshotID({
      conversationID: this.options.conversationID, state, authority, live, ...(scheduler ? { scheduler } : {}),
    })
    return {
      conversationID: this.options.conversationID,
      snapshotID,
      kind: classification.kind,
      ...(scheduler ? { scheduler } : {}),
      blockers: classification.blockers,
      actions: classification.actions,
      local: {
        sessionID: state.sessionID ?? null,
        phase: state.phase ?? "idle",
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
        cachedEvidence: "last_observed_not_fresh_provider_proof",
        usageError: state.usageError ?? null,
        settlementError: state.settlementError ?? null,
        lastTurnError: state.lastTurnError ?? null,
        operatorReconciliation: state.operatorReconciliation ?? null,
        historicalUsageUnreconciled: state.operatorReconciliation?.kind === "acknowledged_unknown",
      },
      live,
      authority: ledger ? {
        conversationID: ledger.conversationID,
        snapshotID: ledger.snapshotID,
        holds: ledger.holds,
        legacyRows: ledger.legacyRows,
        blockers: ledger.blockers,
        retirement: ledger.retirement ?? null,
      } : null,
      ...(authorityError ? { authorityError } : {}),
    }
  }

  async inspect(): Promise<Response> {
    try {
      return Response.json(await this.status())
    } catch (error) {
      return Response.json({ error: errorMessage(error), retryable: true }, { status: 503 })
    }
  }

  async act(action: "retry" | "cancel_before_dispatch", expectedSnapshotID: string): Promise<Response> {
    const startedAt = Date.now()
    this.emitActionTelemetry("recovery.started", action, "started")
    try {
      const response = await this.options.withAdmissionLock(() => this.actOwned(action, expectedSnapshotID))
      const durationMs = Date.now() - startedAt
      if (response.status === 409) {
        this.emitActionTelemetry("recovery.blocked", action, "blocked", durationMs)
      } else if (response.status === 202) {
        this.emitActionTelemetry("recovery.scheduled", action, "scheduled", durationMs)
      } else {
        this.emitActionTelemetry(
          "recovery.settled",
          action,
          response.status < 400 ? "succeeded" : "failed",
          durationMs,
        )
      }
      return response
    } catch (error) {
      this.emitActionTelemetry("recovery.settled", action, "failed", Date.now() - startedAt)
      throw error
    }
  }

  private emitActionTelemetry(
    event: "recovery.started" | "recovery.scheduled" | "recovery.settled" | "recovery.blocked",
    action: "retry" | "cancel_before_dispatch",
    result: "started" | "scheduled" | "succeeded" | "failed" | "blocked",
    durationMs?: number,
  ): void {
    emitConversationTelemetry({
      event,
      conversationID: this.options.conversationID,
      result,
      reasonCode: action,
      ...(durationMs === undefined ? {} : { durationMs }),
    }, undefined, traceId)
  }

  private actOwned(action: "retry" | "cancel_before_dispatch", expectedSnapshotID: string): Promise<Response> {
    const perform = async (): Promise<Response> => {
      const live = this.options.live()
      if (live.admitting || live.pumping || this.recoveryAction || live.activeJobs > 0) {
        return Response.json({ error: "conversation has a live local operation" }, { status: 409 })
      }
      const status = await this.status()
      if (status.snapshotID !== expectedSnapshotID) {
        return Response.json({ error: "recovery snapshot changed", recovery: status }, { status: 409 })
      }
      if (!Array.isArray(status.actions) || !status.actions.includes(action)) {
        return Response.json({ error: "recovery action is blocked", recovery: status }, { status: 409 })
      }
      const current = await this.options.store.get()
      if (action === "retry" && status.kind === "sealed_idle") {
        return this.options.usage.serialize(async () => {
          try {
            this.recoveryAction = true
            const refreshed = await this.status()
            if (refreshed.snapshotID !== expectedSnapshotID || refreshed.kind !== "sealed_idle") {
              return Response.json({ error: "recovery snapshot changed", recovery: refreshed }, { status: 409 })
            }
            const evidence = refreshed.scheduler as RecoverySchedulerEvidence
            await this.options.jobs.resumeSealedIdle(evidence, current)
            return Response.json({ ok: true, scheduled: true }, { status: 202 })
          } catch {
            return Response.json({ error: "sealed recovery evidence changed or jobs could not be restored", retryable: true }, { status: 503 })
          } finally {
            this.recoveryAction = false
          }
        })
      }
      const reservation = current.budgetReservation
      if (!reservation) return Response.json({ error: "local reservation is unavailable" }, { status: 409 })
      if (action === "retry") {
        if (reservation.dispatched !== true) {
          return Response.json({ error: "retry requires a dispatched reservation" }, { status: 409 })
        }
        try {
          this.recoveryAction = true
          const refreshed = await this.status()
          const refreshedState = await this.options.store.get()
          const refreshedReservation = refreshedState.budgetReservation
          if (refreshed.snapshotID !== expectedSnapshotID ||
            !Array.isArray(refreshed.actions) || !refreshed.actions.includes("retry") ||
            refreshedState.sessionID !== current.sessionID || !refreshedReservation?.dispatched ||
            refreshedReservation.reservationID !== reservation.reservationID ||
            refreshedReservation.date !== reservation.date) {
            return Response.json({ error: "recovery snapshot changed or retry owner is no longer current", recovery: refreshed }, { status: 409 })
          }
          const epoch = await this.options.jobs.epoch()
          await this.options.storage.transaction(async (txn) => {
            if (await txn.get<number>("conversationJobEpoch") !== epoch) throw new Error("recovery epoch changed")
            const liveState = await txn.get<ConversationState>("state")
            const liveReservation = liveState?.budgetReservation
            if (!liveReservation?.dispatched || liveReservation.reservationID !== reservation.reservationID ||
              liveReservation.date !== reservation.date || liveState?.sessionID !== current.sessionID) {
              throw new Error("recovery owner changed")
            }
            await txn.delete("lifecycleJobsSealed")
            if (liveState?.lifecycleJobsSealed) await txn.put("state", { ...liveState, lifecycleJobsSealed: false })
            await this.options.jobs.scheduleRecovery(Date.now(), {
              reservationID: reservation.reservationID,
              reservationDate: reservation.date,
              sessionID: current.sessionID,
              reason: "operator-recovery-retry",
            }, true)
          })
          return Response.json({ ok: true, scheduled: true }, { status: 202 })
        } catch (error) {
          return Response.json({ error: errorMessage(error), retryable: true }, { status: 503 })
        } finally {
          this.recoveryAction = false
        }
      }

      if (this.options.live().admitting || this.options.live().pumping || this.recoveryAction) {
        return Response.json({ error: "conversation has a live local operation" }, { status: 409 })
      }
      this.recoveryAction = true
      try {
        const refreshed = await this.status()
        if (refreshed.snapshotID !== expectedSnapshotID ||
          !Array.isArray(refreshed.actions) || !refreshed.actions.includes(action)) {
          return Response.json({ error: "recovery snapshot changed or action is blocked", recovery: refreshed }, { status: 409 })
        }
        const captured = current.budgetReservation
        if (!captured || captured.dispatched !== false) {
          return Response.json({ error: "cancellation requires a strictly undispatched proposal" }, { status: 409 })
        }
        const refreshedAuthority = isRecord(refreshed.authority) ? refreshed.authority : undefined
        if (!refreshedAuthority || typeof refreshedAuthority.snapshotID !== "string" ||
          !/^[a-f0-9]{64}$/.test(refreshedAuthority.snapshotID)) {
          return Response.json({ error: "Settings authority snapshot is unavailable" }, { status: 503 })
        }
        const retirement = isRecord(refreshedAuthority.retirement) ? refreshedAuthority.retirement : undefined
        if (retirement?.conversationID === this.options.conversationID &&
          retirement.reservationID === captured.reservationID &&
          (retirement.reason === "cancelled_before_dispatch" || retirement.reason === "released")) {
          const cleared = await this.options.store.clearUndispatchedBudgetProposal(captured)
          return cleared
            ? Response.json({ ok: true, cancelled: true, retirement })
            : Response.json({ error: "local proposal changed after cancellation was recorded" }, { status: 409 })
        }
        const response = await this.options.settings.fetch("https://settings/usage/cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationID: this.options.conversationID,
            reservationID: captured.reservationID,
            expectedSnapshotID: refreshedAuthority.snapshotID,
          }),
        })
        const result: unknown = await response.json().catch(() => undefined)
        if (!response.ok) {
          return Response.json(isRecord(result) ? result : { error: `Settings cancellation rejected: ${response.status}` }, {
            status: response.status,
          })
        }
        if (!isRecord(result) || result.ok !== true || typeof result.released !== "boolean" ||
          !isRecord(result.retirement) ||
          result.retirement.conversationID !== this.options.conversationID ||
          result.retirement.reservationID !== captured.reservationID ||
          (result.retirement.reason !== "cancelled_before_dispatch" && result.retirement.reason !== "released") ||
          typeof result.retirement.retiredAt !== "number" || !Number.isFinite(result.retirement.retiredAt) ||
          (result.retirement.date !== undefined && (typeof result.retirement.date !== "string" ||
            !/^\d{4}-\d{2}-\d{2}$/.test(result.retirement.date))) ||
          (captured.date !== undefined && typeof result.retirement.date === "string" &&
            result.retirement.date !== captured.date)) {
          return Response.json({ error: "Settings returned an invalid cancellation receipt" }, { status: 502 })
        }
        const cleared = await this.options.store.clearUndispatchedBudgetProposal(captured)
        if (!cleared) return Response.json({ error: "local proposal changed after cancellation was recorded" }, { status: 409 })
        return Response.json({ ok: true, cancelled: true, retirement: result.retirement })
      } catch (error) {
        return Response.json({ error: errorMessage(error), retryable: true }, { status: 503 })
      } finally {
        this.recoveryAction = false
      }
    }
    return action === "cancel_before_dispatch" ? this.options.usage.serialize(perform) : perform()
  }

  async runAction<T>(operation: () => Promise<T>): Promise<T> {
    if (this.recoveryAction) throw new RecoveryActionBusyError()
    this.recoveryAction = true
    try {
      return await operation()
    } finally {
      this.recoveryAction = false
    }
  }
}
