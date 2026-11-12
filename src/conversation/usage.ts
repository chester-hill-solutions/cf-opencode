import type { makeClient } from "../opencode"
import { ConversationStore, type ConversationState } from "../state"
import { durableUsageEvent } from "../usage"
import { turnMessages, type MessageInfo } from "../messages"
import type { RecoveryHold, RecoveryRetirement } from "../recovery"

type UnknownRecord = Record<string, unknown>
type OpenCodeClient = ReturnType<typeof makeClient>

export interface UsageCutoverReceipt {
  cutoverID: string
  sessionID: string
  throughSeq: number
  expectedSnapshotID: string
  openingBalances: unknown
  createdAt: number
  historicalUsageUnreconciled: true
}

export interface UsageCutoverLedger {
  conversationID: string
  rows: UnknownRecord[]
  legacyRows: UnknownRecord[]
  holds: RecoveryHold[]
  blockers: unknown[]
  receipt?: UsageCutoverReceipt
  snapshotID: string
  retirement?: RecoveryRetirement & { operatorReceiptID?: string }
}

export interface UsageSettingsPort {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>
}

export interface ConversationUsageOptions {
  conversationID: string
  store: ConversationStore
  settings: UsageSettingsPort
  withClient<T>(fn: (client: OpenCodeClient) => Promise<T>, recoverOnRejection?: boolean): Promise<T>
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Serializes all durable log reads/reports/cursor updates for one conversation. */
export class ConversationUsage {
  private usageTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: ConversationUsageOptions) {}

  serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.usageTail.then(task, task)
    this.usageTail = run.then(() => undefined, () => undefined)
    return run
  }

  async ledger(reservationID?: string): Promise<UsageCutoverLedger> {
    const query = new URLSearchParams({ conversationID: this.options.conversationID })
    if (reservationID) query.set("reservationID", reservationID)
    const response = await this.options.settings.fetch(`https://settings/usage/cutover?${query.toString()}`)
    if (!response.ok) throw new Error(`usage cutover status was rejected: ${response.status}`)
    const value: unknown = await response.json()
    if (!isRecord(value) || value.conversationID !== this.options.conversationID ||
      typeof value.snapshotID !== "string" || !/^[a-f0-9]{64}$/.test(value.snapshotID) || !Array.isArray(value.rows) ||
      !Array.isArray(value.legacyRows) || !Array.isArray(value.holds) || !Array.isArray(value.blockers) ||
      !value.rows.every(isRecord) || !value.legacyRows.every(isRecord)) {
      throw new Error("usage cutover status is unreadable")
    }
    const holds: RecoveryHold[] = value.holds.map((hold): RecoveryHold => {
      if (!isRecord(hold) || typeof hold.key !== "string" ||
        (hold.kind !== "reservation" && hold.kind !== "legacy-reservation") ||
        !(typeof hold.conversationID === "string" || hold.conversationID === null) ||
        !(typeof hold.reservationID === "string" || hold.reservationID === null) ||
        !(typeof hold.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(hold.date) || hold.date === null) ||
        !(typeof hold.costUSD === "number" && Number.isFinite(hold.costUSD) && hold.costUSD >= 0 || hold.costUSD === null) ||
        (hold.updatedAt !== undefined &&
          !(typeof hold.updatedAt === "number" && Number.isFinite(hold.updatedAt) || hold.updatedAt === null)) ||
        (hold.invalidFields !== undefined && (!Array.isArray(hold.invalidFields) ||
          !hold.invalidFields.every((field) => typeof field === "string"))) ||
        (hold.kind === "legacy-reservation" && typeof hold.reserved !== "boolean")) {
        throw new Error("usage cutover hold inventory is unreadable")
      }
      const invalidFields = Array.isArray(hold.invalidFields) ? [...hold.invalidFields as string[]] : []
      if (hold.kind === "reservation") {
        if (typeof hold.conversationID !== "string") invalidFields.push("conversationID")
        if (typeof hold.reservationID !== "string") invalidFields.push("reservationID")
        if (typeof hold.date !== "string") invalidFields.push("date")
        if (typeof hold.costUSD !== "number") invalidFields.push("costUSD")
      }
      return {
        kind: hold.kind,
        ...(typeof hold.conversationID === "string" ? { conversationID: hold.conversationID } : {}),
        ...(typeof hold.reservationID === "string" ? { reservationID: hold.reservationID } : {}),
        ...(typeof hold.date === "string" ? { date: hold.date } : {}),
        ...(typeof hold.costUSD === "number" ? { costUSD: hold.costUSD } : {}),
        ...(invalidFields.length ? { invalidFields } : {}),
      }
    })
    let retirement: (RecoveryRetirement & { operatorReceiptID?: string }) | undefined
    if (value.retirement !== undefined) {
      const raw = value.retirement
      if (!isRecord(raw) || typeof raw.conversationID !== "string" ||
        typeof raw.reservationID !== "string" ||
        (raw.date !== undefined && (typeof raw.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date))) ||
        (raw.reason !== "released" && raw.reason !== "cancelled_before_dispatch") ||
        typeof raw.retiredAt !== "number" || !Number.isFinite(raw.retiredAt) ||
        (raw.released !== undefined && typeof raw.released !== "boolean")) {
        throw new Error("usage reservation retirement is unreadable")
      }
      retirement = {
        conversationID: raw.conversationID,
        reservationID: raw.reservationID,
        ...(typeof raw.date === "string" ? { date: raw.date } : {}),
        reason: raw.reason,
        retiredAt: raw.retiredAt,
        ...(typeof raw.released === "boolean" ? { released: raw.released } : {}),
        ...(typeof raw.operatorReceiptID === "string" ? { operatorReceiptID: raw.operatorReceiptID } : {}),
      }
    }
    let receipt: UsageCutoverReceipt | undefined
    if (value.receipt !== undefined) {
      const raw = value.receipt
      if (!isRecord(raw) || typeof raw.cutoverID !== "string" || typeof raw.sessionID !== "string" ||
        !Number.isSafeInteger(raw.throughSeq) || (raw.throughSeq as number) < 0 ||
        typeof raw.expectedSnapshotID !== "string" || typeof raw.createdAt !== "number" ||
        raw.historicalUsageUnreconciled !== true) {
        throw new Error("usage cutover receipt is unreadable")
      }
      receipt = raw as unknown as UsageCutoverReceipt
    }
    return {
      conversationID: value.conversationID,
      rows: value.rows,
      legacyRows: value.legacyRows,
      holds,
      blockers: value.blockers,
      ...(receipt ? { receipt } : {}),
      snapshotID: value.snapshotID,
      ...(retirement ? { retirement } : {}),
    }
  }

  recordContext(messages: MessageInfo[]): Promise<void> {
    return this.serialize(async () => {
      try {
        if (!Array.isArray(messages)) throw new Error("terminal usage context is unreadable")
        const state = await this.options.store.get()
        const terminal = turnMessages(messages, state.turnBaseline)
          .filter((message) => message.type === "assistant")
          .at(-1)
        if (!state.sessionID || !terminal?.id) throw new Error("terminal assistant id is unavailable")
        await this.replayLogLocked(state.sessionID, terminal.id)
      } catch (error) {
        await this.options.store.patch({ usageError: errorMessage(error) }).catch(() => {})
        throw error
      }
    })
  }

  /** Warm events and admission drains late auxiliary rows through the same cursor. */
  refresh(sessionID: string): Promise<void> {
    return this.serialize(async () => {
      try {
        const state = await this.options.store.get()
        if (state.sessionID !== sessionID) return
        await this.replayLogLocked(sessionID)
      } catch (error) {
        await this.options.store.patch({ usageError: errorMessage(error) }).catch(() => {})
        throw error
      }
    })
  }

  /** Call only from a serialized `recordContext`/`refresh` task. */
  async replayLogLocked(sessionID: string, terminalMessageID?: string): Promise<void> {
    const state = await this.options.store.get()
    const ledger = await this.ledger()
    const receipt = ledger.receipt
    const sessionReceipt = receipt?.sessionID === sessionID ? receipt : undefined
    const previousCursor = state.usageCursor?.sessionID === sessionID ? state.usageCursor.seq : 0
    const storedExecution = state.usageExecution?.sessionID === sessionID ? state.usageExecution : undefined
    const receiptBaseline = sessionReceipt && (!storedExecution || sessionReceipt.throughSeq > previousCursor)
      ? sessionReceipt.throughSeq
      : 0
    const reconstructing = storedExecution === undefined || receiptBaseline > 0
    const replayAfter = storedExecution
      ? Math.max(previousCursor, sessionReceipt?.throughSeq ?? 0)
      : receiptBaseline
    const requiredWatermark = Math.max(previousCursor, sessionReceipt?.throughSeq ?? 0)
    const execution = receiptBaseline > 0
      ? { sessionID, startedSeq: 0, terminalSeq: receiptBaseline, latestStepSeq: 0 }
      : storedExecution
        ? { ...storedExecution }
        : { sessionID, startedSeq: 0, terminalSeq: 0, latestStepSeq: 0 }
    let reconstructedTerminal: ConversationState["usageTerminal"]
    let synced = false
    let logWatermark = replayAfter
    // Retain the runtime borrow through iterator consumption and final proof.
    // Invalid ledger evidence must not trigger transport recycling.
    await this.options.withClient(async (client) => {
      const log = await client.experimental.session.log({ sessionID, after: replayAfter, follow: false })
      let latestSeq = replayAfter
      for await (const item of log) {
        if (!item || typeof item !== "object") throw new Error("durable session log is unreadable")
        if ((item as { type?: string }).type === "log.synced") {
          const marker = item as { aggregateID?: string; seq?: number }
          if (synced || marker.aggregateID !== sessionID ||
            (marker.seq === undefined
              ? latestSeq > 0 || requiredWatermark > 0
              : typeof marker.seq !== "number" || !Number.isSafeInteger(marker.seq) ||
                marker.seq < latestSeq || marker.seq < requiredWatermark)) {
            throw new Error("durable session log sync marker is invalid")
          }
          if (marker.seq !== undefined) logWatermark = marker.seq
          synced = true
          continue
        }
        if (synced) throw new Error("durable session log has rows after log.synced")
        const raw = item as Record<string, unknown>
        const durable = raw.durable as Record<string, unknown> | undefined
        const data = raw.data as Record<string, unknown> | undefined
        const seq = durable?.seq
        if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
          throw new Error("durable event sequence is unreadable")
        }
        if (durable?.aggregateID !== sessionID ||
          (data?.sessionID !== undefined && data.sessionID !== sessionID)) {
          throw new Error("durable event session does not match")
        }
        if ((raw.type === "session.execution.started" || raw.type === "session.execution.succeeded" ||
          raw.type === "session.execution.failed" || raw.type === "session.execution.interrupted") &&
          (typeof raw.id !== "string" || raw.id.length === 0 || data?.sessionID !== sessionID)) {
          throw new Error("durable execution fence is unreadable")
        }
        if (seq <= latestSeq) throw new Error("durable event sequence is out of order")

        const usage = durableUsageEvent(raw, sessionID)
        if (raw.type === "session.execution.started") execution.startedSeq = seq
        if (raw.type === "session.execution.succeeded" || raw.type === "session.execution.failed" ||
          raw.type === "session.execution.interrupted") execution.terminalSeq = seq
        if (usage) {
          const today = new Date().toISOString().slice(0, 10)
          const usageDate = Date.parse(`${usage.date}T00:00:00.000Z`)
          const todayStart = Date.parse(`${today}T00:00:00.000Z`)
          if (usageDate > todayStart) throw new Error("durable usage event is in the future")
          const expired = usageDate < todayStart - 30 * 24 * 60 * 60 * 1000
          if (expired && terminalMessageID !== undefined && usage.assistantMessageID === terminalMessageID) {
            throw new Error("terminal assistant usage is outside the accounting window")
          }
          if (!expired) await this.report(usage, receipt?.cutoverID)
          if (raw.type === "session.step.ended" || raw.type === "session.step.failed") {
            if (!usage.assistantMessageID) throw new Error("durable step has no assistant message id")
            execution.latestStepSeq = seq
            if (reconstructing) reconstructedTerminal = { sessionID, assistantMessageID: usage.assistantMessageID, seq }
          }
        }
        if (!reconstructing) {
          await this.options.store.patch({
            usageCursor: { sessionID, seq: Math.max(previousCursor, seq, sessionReceipt?.throughSeq ?? 0) },
            usageExecution: execution,
            ...(usage?.assistantMessageID && (raw.type === "session.step.ended" || raw.type === "session.step.failed")
              ? { usageTerminal: { sessionID, assistantMessageID: usage.assistantMessageID, seq } }
              : {}),
            usageError: undefined,
          })
        }
        latestSeq = seq
      }
      if (!synced) throw new Error("durable session log ended without log.synced")
      if (logWatermark < requiredWatermark) throw new Error("durable log watermark fell behind the acknowledged cursor")
      const acknowledgedCursor = Math.max(logWatermark, latestSeq, previousCursor, sessionReceipt?.throughSeq ?? 0)
      const currentState = await this.options.store.get()
      if (reconstructing || acknowledgedCursor > (currentState.usageCursor?.sessionID === sessionID
        ? currentState.usageCursor.seq
        : 0)) {
        await this.options.store.patch({
          usageCursor: { sessionID, seq: acknowledgedCursor },
          usageExecution: execution,
          ...(reconstructing ? { usageTerminal: reconstructedTerminal } : {}),
          usageError: undefined,
        })
      }
      if (!terminalMessageID) return
      const latest = await this.options.store.get()
      const terminal = latest.usageTerminal
      const fences = latest.usageExecution
      if (terminal?.sessionID !== sessionID || terminal.assistantMessageID !== terminalMessageID ||
        terminal.seq !== fences?.latestStepSeq || fences.sessionID !== sessionID ||
        fences.terminalSeq <= terminal.seq || fences.startedSeq > fences.terminalSeq) {
        throw new Error("terminal assistant usage is not acknowledged in the durable log")
      }
    }, false)
  }

  private async report(usage: NonNullable<ReturnType<typeof durableUsageEvent>>, cutoverID?: string): Promise<void> {
    const response = await this.options.settings.fetch("https://settings/usage", {
      method: "POST",
      body: JSON.stringify({ conversationID: this.options.conversationID, ...usage, ...(cutoverID ? { cutoverID } : {}) }),
    })
    if (!response.ok) {
      const detail = await response.json().catch(() => undefined) as { error?: unknown } | undefined
      const reason = typeof detail?.error === "string" ? ` (${detail.error.slice(0, 160)})` : ""
      throw new Error(`usage report was rejected: ${response.status}${reason}`)
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
