import type { makeClient, ContainerPort } from "../opencode"
import { ConversationStore } from "../state"
import type { ConversationUsage, UsageCutoverLedger } from "./usage"
import type { ConversationRuntime } from "./runtime"
import { ACCOUNTING_POLICY_ID, assertAccountingPolicy } from "../accounting-policy"

type UnknownRecord = Record<string, unknown>

export interface AccountingCutoverSettingsPort {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>
}

export interface ConversationAccountingCutoverOptions {
  storage: DurableObjectStorage
  store: ConversationStore
  usage: ConversationUsage
  runtime: Pick<ConversationRuntime, "port" | "recordProof">
  conversationID: string
  dynamicSettings: AccountingCutoverSettingsPort
  withAdmissionLock<T>(task: () => Promise<T>): Promise<T>
  withClient<T>(fn: (client: ReturnType<typeof makeClient>) => Promise<T>, recoverOnRejection?: boolean): Promise<T>
  ensureReady(): Promise<ContainerPort>
}

const CONTROL_PORT = 4001

/** Read-only plan and explicit apply for the legacy ledger cutover. */
export class ConversationAccountingCutover {
  constructor(private readonly options: ConversationAccountingCutoverOptions) {}

  async previewData(): Promise<UnknownRecord> {
    const state = await this.options.store.get()
    const blockers: string[] = []
    const sessionID = state.sessionID
    if (!sessionID) blockers.push("current_session_missing")
    if ((state.phase ?? "idle") !== "idle") blockers.push("conversation_not_idle")
    if (state.queued) blockers.push("queued_message_present")
    if (state.budgetReservation) blockers.push("budget_reservation_present")

    let ledger: UsageCutoverLedger | undefined
    try {
      ledger = await this.options.usage.ledger()
    } catch {
      blockers.push("settings_ledger_unavailable")
    }
    if (ledger?.holds.length) blockers.push("budget_holds_present")
    if (ledger?.blockers.length) blockers.push("settings_ledger_invalid")
    if (ledger?.receipt) blockers.push("cutover_already_applied")

    let runtimeGeneration: string | undefined
    let watermark: number | undefined
    let runtimeStatus: UnknownRecord | undefined
    let logState: UnknownRecord | undefined
    if (sessionID) {
      try {
        await this.options.ensureReady()
        const control = await this.options.runtime.port(CONTROL_PORT)
        const proofResponse = await control.fetch("http://container/start", {
          method: "POST",
          signal: AbortSignal.timeout(120_000),
        })
        if (!proofResponse.ok) throw new Error("runtime proof could not be refreshed")
        const proof = await proofResponse.json().catch(() => undefined) as {
          ok?: unknown
          accountingPolicy?: unknown
          opencodeGeneration?: unknown
          eventPersistence?: unknown
        } | undefined
        if (proof?.ok !== true || proof.accountingPolicy !== ACCOUNTING_POLICY_ID ||
          typeof proof.opencodeGeneration !== "string" || !proof.opencodeGeneration) {
          throw new Error("runtime generation proof is unavailable")
        }
        runtimeGeneration = proof.opencodeGeneration
        this.options.runtime.recordProof(runtimeGeneration, proof.eventPersistence === true)

        const inspected = await this.options.withClient(async (client) => {
          assertAccountingPolicy(await client.config.get())
          const session = await client.session.get({ sessionID })
          let latestSeq = 0
          let latestStartedSeq = 0
          let latestExecutionTerminalSeq = 0
          let latestStepSeq = 0
          let synced = false
          let markerSeq: number | undefined
          const log = await client.experimental.session.log({ sessionID, after: 0, follow: false })
          for await (const item of log) {
            if (!item || typeof item !== "object") throw new Error("durable session log is unreadable")
            const raw = item as unknown as UnknownRecord
            if (raw.type === "log.synced") {
              if (synced || raw.aggregateID !== sessionID) throw new Error("durable log sync marker is invalid")
              if (raw.seq !== undefined && (typeof raw.seq !== "number" ||
                !Number.isSafeInteger(raw.seq) || raw.seq < latestSeq)) {
                throw new Error("durable log watermark is invalid")
              }
              if (raw.seq === undefined && latestSeq !== 0) throw new Error("durable log watermark is missing")
              markerSeq = raw.seq as number | undefined
              synced = true
              continue
            }
            if (synced) throw new Error("durable session log has rows after log.synced")
            const durable = isRecord(raw.durable) ? raw.durable : undefined
            const data = isRecord(raw.data) ? raw.data : undefined
            const seq = durable?.seq
            if (typeof raw.id !== "string" || raw.id.length === 0 ||
              typeof raw.created !== "number" || !Number.isFinite(raw.created) || raw.created <= 0 ||
              typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= latestSeq ||
              durable?.aggregateID !== sessionID ||
              (data?.sessionID !== undefined && data.sessionID !== sessionID)) {
              throw new Error("durable session log row is invalid")
            }
            if ((raw.type === "session.execution.started" || raw.type === "session.execution.succeeded" ||
              raw.type === "session.execution.failed" || raw.type === "session.execution.interrupted") &&
              data?.sessionID !== sessionID) {
              throw new Error("durable execution fence has no matching session id")
            }
            if (raw.type === "session.execution.started") latestStartedSeq = seq
            if (raw.type === "session.execution.succeeded" || raw.type === "session.execution.failed" ||
              raw.type === "session.execution.interrupted") latestExecutionTerminalSeq = seq
            if (raw.type === "session.step.ended" || raw.type === "session.step.failed") latestStepSeq = seq
            latestSeq = seq
          }
          if (!synced) throw new Error("durable session log ended without log.synced")
          const busyTime = session.time.busy
          const idleTime = session.time.idle
          const timingBusy = busyTime !== undefined &&
            (typeof idleTime !== "number" || busyTime > idleTime)
          const executionBusy = latestStartedSeq > latestExecutionTerminalSeq
          const missingStepTerminal = latestStepSeq > latestExecutionTerminalSeq
          return {
            sessionExists: true,
            timingBusy,
            executionBusy,
            missingStepTerminal,
            throughSeq: markerSeq ?? latestSeq,
            latestStartedSeq,
            latestExecutionTerminalSeq,
            latestStepSeq,
          }
        })
        runtimeStatus = {
          accountingPolicy: ACCOUNTING_POLICY_ID,
          generation: runtimeGeneration,
          sessionExists: inspected.sessionExists,
          timeBusy: inspected.timingBusy,
        }
        logState = {
          latestStartedSeq: inspected.latestStartedSeq,
          latestExecutionTerminalSeq: inspected.latestExecutionTerminalSeq,
          latestStepSeq: inspected.latestStepSeq,
        }
        watermark = inspected.throughSeq
        if (state.usageCursor?.sessionID === sessionID && state.usageCursor.seq > inspected.throughSeq) {
          blockers.push("provider_log_behind_local_cursor")
        }
        if (inspected.timingBusy || inspected.executionBusy) blockers.push("provider_session_busy")
        if (inspected.missingStepTerminal) blockers.push("terminal_execution_missing_after_last_step")
      } catch {
        blockers.push("foreground_runtime_or_log_unavailable")
      }
    }

    const sortRows = (rows: UnknownRecord[] | undefined) => (rows ?? [])
      .map((row) => ({
        date: row.date,
        costUSD: row.costUSD,
        input: row.input,
        output: row.output,
        sourced: row.sourced,
        legacyOpening: row.legacyOpening,
        cutoverID: row.cutoverID,
      }))
      .sort((left, right) => String(left.date).localeCompare(String(right.date)))
    const snapshot: UnknownRecord = {
      conversationID: this.options.conversationID,
      local: {
        sessionID: sessionID ?? null,
        phase: state.phase ?? "idle",
        hasQueue: Boolean(state.queued),
        reservation: state.budgetReservation
          ? { reservationID: state.budgetReservation.reservationID, date: state.budgetReservation.date, dispatched: state.budgetReservation.dispatched }
          : null,
        usageCursor: state.usageCursor ?? null,
        usageTerminal: state.usageTerminal ?? null,
        usageExecution: state.usageExecution ?? null,
      },
      runtime: { policy: ACCOUNTING_POLICY_ID, generation: runtimeGeneration ?? null, status: runtimeStatus ?? null },
      log: { throughSeq: watermark ?? null, execution: logState ?? null },
      ledger: ledger ? {
        snapshotID: ledger.snapshotID,
        rows: sortRows(ledger.rows),
        legacyRows: sortRows(ledger.legacyRows),
        holds: ledger.holds,
        receipt: ledger.receipt ?? null,
      } : null,
    }
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot))
    const digest = await crypto.subtle.digest("SHA-256", bytes)
    const planID = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
    return {
      planID,
      canApply: blockers.length === 0,
      blockers: [...new Set(blockers)],
      conversationID: this.options.conversationID,
      sessionID: sessionID ?? null,
      accountingPolicy: ACCOUNTING_POLICY_ID,
      opencodeGeneration: runtimeGeneration ?? null,
      throughSeq: watermark ?? null,
      ledger: ledger ?? null,
      historicalUsageUnreconciled: true,
      snapshot,
    }
  }

  async preview(): Promise<Response> {
    try {
      return Response.json(await this.previewData())
    } catch (error) {
      return Response.json({ error: errorMessage(error) }, { status: 503 })
    }
  }

  async apply(expectedPlanID: string): Promise<Response> {
    return this.options.withAdmissionLock(async () => this.options.usage.serialize(async () => {
      try {
        const ledger = await this.options.usage.ledger()
        if (ledger.receipt?.cutoverID === expectedPlanID) {
          return Response.json({ ok: true, recovered: true, receipt: ledger.receipt })
        }
        if (ledger.receipt) {
          return Response.json({ error: "a different usage cutover has already been applied", receipt: ledger.receipt }, { status: 409 })
        }
        const plan = await this.previewData()
        if (plan.canApply !== true) return Response.json({ error: "usage cutover is blocked", plan }, { status: 409 })
        if (plan.planID !== expectedPlanID) return Response.json({ error: "usage cutover plan changed", plan }, { status: 409 })
        const response = await this.options.dynamicSettings.fetch("https://settings/usage/cutover", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            conversationID: this.options.conversationID,
            cutoverID: expectedPlanID,
            expectedSnapshotID: ledger.snapshotID,
            sessionID: plan.sessionID,
            throughSeq: plan.throughSeq,
          }),
        })
        const body = await response.json().catch(() => ({})) as UnknownRecord
        return Response.json(body, { status: response.status })
      } catch (error) {
        return Response.json({ error: errorMessage(error) }, { status: 503 })
      }
    }))
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
