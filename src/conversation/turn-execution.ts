import { makeClient, type ContainerPort } from "../opencode"
import {
  ConversationStore,
  type BudgetReservation,
  type ConversationState,
} from "../state"
import {
  failureKey,
  isSettled,
  lastTurnPair,
  latestAssistantReply,
  turnMessages,
  turnFailure,
  type MessageInfo,
  type TurnFailure,
} from "../messages"
import { createSseParser } from "../sse"
import type { ConversationEvent } from "../events"
import type { ConversationUsage } from "./usage"
import type { ConversationCheckpoints } from "./checkpoints"
import type { ConversationControlPlane } from "./control-plane"
import type { ConversationJobKind, ConversationJobPayload } from "./jobs"
import type { HarnessSettings } from "../settings"
import { answerHint, describeForm, formButtons, type Form } from "../slack-forms"
import { logEvent } from "../log"
import { traceId, withSpan } from "../telemetry"
import { emitConversationTelemetry, type ConversationTelemetryInput } from "./telemetry"

export interface PermissionSummary {
  id: string
  action: string
  resources: string[]
}

interface StreamOwner {
  token: number
  sessionID: string
  controller: AbortController
  reader?: ReadableStreamDefaultReader<Uint8Array>
  cancelled: boolean
  flight: Promise<void>
}

export interface ConversationTurnExecutionOptions {
  conversationID: string
  storage: DurableObjectStorage
  store: ConversationStore
  usage: Pick<ConversationUsage, "refresh" | "recordContext">
  checkpoints: Pick<ConversationCheckpoints, "capture">
  controlPlane: Pick<ConversationControlPlane, "pendingForms">
  runtime: {
    openStream(open: (port: ContainerPort) => Promise<Response>): Promise<Response>
    withClient<T>(fn: (client: ReturnType<typeof makeClient>) => Promise<T>, recoverOnRejection?: boolean): Promise<T>
  }
  guards: {
    recovering(): boolean
    hasPendingUpgrade(): Promise<boolean>
  }
  delivery: {
    event(event: ConversationEvent, options?: { slack?: boolean }): Promise<void>
    toSlack(event: ConversationEvent): Promise<void>
    slack(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>>
    count(name: string): Promise<void>
    slackBotToken(): string | undefined
  }
  conversationKey(): string | undefined
  jobs: {
    schedule(kind: ConversationJobKind, at: number, payload?: ConversationJobPayload): Promise<void>
  }
  settings(): Promise<HarnessSettings>
  /** Bound on one runtime read; a hung read must not wedge the pump for the instance. */
  observeTimeoutMs?: number
  releaseBudgetReservation(reservation: BudgetReservation): Promise<boolean>
  finalReply?(state: ConversationState, text: string, assistantID?: string): Promise<void>
  waitUntil(promise: Promise<unknown>): void
  /** Post-turn review of the user prompt and reply. It must never affect settlement. */
  memoryReview?(turn: { user: string; assistant: string }): void
  telemetry?(input: ConversationTelemetryInput): void
}

const POLL_MS = 2_000
/** A single observation must answer, or the pump flag wedges the whole instance. */
const OBSERVE_TIMEOUT_MS = 30_000
const STREAM_STOP_WAIT_MS = 10_000
const DELIVERY_RETRY_BASE_MS = 5_000
const DELIVERY_RETRY_MAX_MS = 5 * 60_000
/** A settlement that outlived its turn may need an operator, so poll it slowly. */
const PAUSED_SETTLEMENT_BACKOFF_AFTER_MS = 20 * 60_000
const PAUSED_SETTLEMENT_POLL_MS = 60_000

interface FormRetries {
  sessionID: string
  forms: Record<string, { attempts: number; nextAttemptAt: number }>
}

/** Owns the reply poll and the one native OpenCode event stream for a turn. */
export class ConversationTurnExecution {
  private streaming = false
  private pumping = false
  private seenEvents = new Map<string, number>()
  private streamState = "idle"
  private streamOwner?: StreamOwner
  private nextStreamToken = 0

  constructor(private readonly options: ConversationTurnExecutionOptions) {}

  get isStreaming(): boolean { return this.streaming }
  private get observeTimeout(): number { return this.options.observeTimeoutMs ?? OBSERVE_TIMEOUT_MS }
  get isPumping(): boolean { return this.pumping }
  get currentStreamState(): string { return this.streamState }
  get observedEvents(): ReadonlyMap<string, number> { return new Map(this.seenEvents) }

  async startStream(sessionID: string): Promise<void> {
    if (this.streamOwner) return
    const owner: StreamOwner = {
      token: ++this.nextStreamToken,
      sessionID,
      controller: new AbortController(),
      cancelled: false,
      flight: Promise.resolve(),
    }
    this.streamOwner = owner
    this.streaming = true
    owner.flight = this.runStream(owner)
    await owner.flight
  }

  /** Stop only this native stream; a stuck setup/read returns false at the bound. */
  async stopStream(): Promise<boolean> {
    const owner = this.streamOwner
    if (!owner) return true
    this.cancelStream()
    let timeout: ReturnType<typeof setTimeout> | undefined
    const completed = await Promise.race([
      owner.flight.then(() => true, () => true),
      new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), STREAM_STOP_WAIT_MS) }),
    ])
    if (timeout) clearTimeout(timeout)
    return completed
  }

  /** Synchronously fence an old reader before its physical container is stopped. */
  cancelStream(): void {
    const owner = this.streamOwner
    if (!owner || owner.cancelled) return
    owner.cancelled = true
    owner.controller.abort()
    if (owner.reader) {
      void owner.reader.cancel().catch(() => {
        // Abort/cancel are best-effort; the owner remains fenced either way.
      })
    }
  }

  private owns(owner: StreamOwner): boolean {
    return this.streamOwner === owner && !owner.cancelled
  }

  private async runStream(owner: StreamOwner): Promise<void> {
    const timeout = setTimeout(() => owner.controller.abort(), 10 * 60_000)
    try {
      const settings = await this.options.settings().catch(() => undefined)
      if (!this.owns(owner) || !settings?.streaming) return
      const response = await this.options.runtime.openStream((port) => port.fetch("http://container/api/event", {
        headers: { accept: "text/event-stream" },
        signal: owner.controller.signal,
      }))
      if (!this.owns(owner)) {
        await response.body?.cancel().catch(() => {})
        return
      }
      if (!response.ok || !response.body) {
        this.streamState = `http ${response.status}`
        return
      }
      this.streamState = "opened"
      const reader = response.body.getReader()
      owner.reader = reader
      const decoder = new TextDecoder()
      const parse = createSseParser((message) => {
        if (!this.owns(owner)) return
        let parsed: { type?: string; data?: { sessionID?: string } } | undefined
        if (message.data) {
          try {
            parsed = JSON.parse(message.data) as { type?: string }
          } catch {
            parsed = undefined
          }
        }
        const name = message.event && message.event !== "message" ? message.event : parsed?.type
        if (!name || !this.owns(owner)) return
        this.seenEvents.set(name, (this.seenEvents.get(name) ?? 0) + 1)
        if (name === "session.execution.succeeded" || name === "session.execution.failed" ||
          name === "session.execution.interrupted" || name === "form.created" ||
          name === "form.replied" || name === "form.cancelled") {
          void this.pumpOnce()
        }
        if ((name === "session.step.ended" || name === "session.step.failed" ||
          name === "session.usage.recorded" || name === "session.usage.updated") &&
          parsed?.data?.sessionID === owner.sessionID && this.owns(owner)) {
          this.options.waitUntil(this.options.usage.refresh(owner.sessionID).catch(() => {}))
        }
      })
      for (;;) {
        const { done, value } = await reader.read()
        if (!this.owns(owner) || done) break
        parse(decoder.decode(value, { stream: true }))
      }
    } catch (error) {
      if (this.owns(owner)) this.streamState = errorMessage(error)
    } finally {
      clearTimeout(timeout)
      const stillOwner = this.streamOwner === owner
      if (stillOwner) {
        this.streamOwner = undefined
        this.streaming = false
      }
      if (stillOwner && !owner.cancelled) {
        const state = await this.options.store.get()
        if (state.budgetReservation?.dispatched) {
          await this.options.jobs.schedule("turn:observe", Date.now() + POLL_MS, {
            reservationID: state.budgetReservation.reservationID,
            reservationDate: state.budgetReservation.date,
            sessionID: owner.sessionID,
            reason: "stream-ended",
          })
        }
      }
    }
  }

  /** One poll: deliver new assistant text, permissions, settle + checkpoint. */
  async pumpOnce(): Promise<boolean> {
    if (this.pumping || this.options.guards.recovering()) return false
    this.pumping = true
    try {
      if (await this.options.guards.hasPendingUpgrade()) return false
      const state = await this.options.store.get()
      if (!state.sessionID) {
        await this.options.store.advance("idle")
        return true
      }
      const phase = state.phase ?? "idle"
      if (phase !== "running" && phase !== "settling") return true
      const sessionID = state.sessionID
      const [messages, pending, questions] = await Promise.all([
        this.options.runtime.withClient((client) =>
          client.session.context({ sessionID }, { signal: AbortSignal.timeout(this.observeTimeout) }),
        ) as Promise<MessageInfo[]>,
        this.options.runtime.withClient((client) =>
          client.permission.list({ sessionID }, { signal: AbortSignal.timeout(this.observeTimeout) }),
        ).catch(
          () => undefined,
        ),
        state.slack ? this.options.controlPlane.pendingForms(sessionID).catch(() => [] as Form[]) : Promise.resolve([] as Form[]),
      ])
      const reply = latestAssistantReply(messages, state.turnBaseline)
      const settled = isSettled(messages, state.turnBaseline)
      const failure = turnFailure(messages, state.turnBaseline, state.runStartedAt)
      if (reply && reply !== state.lastReply) {
        await this.options.delivery.event({ type: "assistant", text: reply }, { slack: false })
        await this.options.store.patch({ lastReply: reply })
      }
      // An unavailable list is not an empty authoritative snapshot.
      if (pending) await this.pollPermissions(sessionID, pending).catch(() => this.reportPermissionFailure())
      // Connector delivery and its bookkeeping must never prevent accounting.
      await this.pollQuestions(sessionID, questions).catch((error) => this.reportQuestionFailure(error))
      if (settled || failure) {
        await this.finishTurn(state, reply, failure, messages)
        return true
      }
      return false
    } finally {
      this.pumping = false
    }
  }

  async finishTimedOutTurn(state: ConversationState, reply: string, failure: TurnFailure): Promise<void> {
    await this.finishTurn(state, reply, failure)
  }

  async pauseSettlement(message: string): Promise<void> {
    const current = await this.options.store.get()
    const newlyPaused = current.settlementError !== message
    // A fresh turn is retried at the poll cadence; one that has outlived its own
    // timeout may need an operator, and a 2-second alarm loop only burns
    // invocations without changing the outcome.
    const started = current.runStartedAt
    const stale = typeof started === "number" && Number.isFinite(started) && started > 0 &&
      Date.now() - started > PAUSED_SETTLEMENT_BACKOFF_AFTER_MS
    await this.options.storage.transaction(async () => {
      if (newlyPaused) await this.options.store.patch({ settlementError: message })
      await this.options.jobs.schedule("turn:observe", Date.now() + (stale ? PAUSED_SETTLEMENT_POLL_MS : POLL_MS), {
        reservationID: current.budgetReservation?.reservationID,
        reservationDate: current.budgetReservation?.date,
        sessionID: current.sessionID,
        reason: "settlement-paused",
      })
    }).catch(() => {})
    if (newlyPaused) {
      if (!current.settlementError) {
        await this.options.delivery.count("settlement.paused").catch(() => {})
        logEvent("settlement.paused", {
          conversationID: this.options.conversationID,
          sessionID: current.sessionID,
          message,
        })
      }
      await this.options.delivery.event({ type: "error", message: `Settlement paused: ${message}` }).catch(() => {})
    }
  }

  private async finishTurn(state: ConversationState, reply: string, failure?: TurnFailure, messages?: MessageInfo[]): Promise<void> {
    await withSpan("conversation.settle", async (span) => {
      span.setAttributes({
        "conversation.failed": Boolean(failure),
        ...(state.runStartedAt ? { "conversation.turn_ms": Date.now() - state.runStartedAt } : {}),
        "conversation.reply_chars": reply.length,
      })
      await this.settleTurn(state, reply, failure, messages)
    }, { "conversation.key": this.options.conversationKey() ?? "unknown" })
  }

  private async settleTurn(
    state: ConversationState,
    reply: string,
    failure?: TurnFailure,
    messages?: MessageInfo[],
  ): Promise<void> {
    await this.options.store.advance("settling")
    if (state.budgetReservation?.dispatched) {
      const currentTurn = messages ? turnMessages(messages, state.turnBaseline) : []
      const terminalAssistant = currentTurn.filter((message) => message.type === "assistant").at(-1)
      const hasTerminalUsage = Boolean(messages && isSettled(messages, state.turnBaseline) &&
        terminalAssistant && typeof terminalAssistant.cost === "number" &&
        Number.isFinite(terminalAssistant.cost) && terminalAssistant.cost >= 0)
      if (!hasTerminalUsage) {
        if (failure) {
          const key = failureKey(failure)
          if (key !== state.reportedError) {
            await this.options.delivery.event({ type: "error", message: failure.message })
            await this.options.store.patch({ reportedError: key, lastTurnError: failure.message })
          }
        }
        await this.pauseSettlement("terminal current-turn assistant usage is unavailable; reservation retained")
        return
      }
    }
    if (messages) {
      try {
        await this.options.usage.recordContext(messages)
      } catch (error) {
        await this.pauseSettlement(`usage report failed: ${errorMessage(error)}`)
        return
      }
    } else if (state.budgetReservation) {
      await this.pauseSettlement("terminal usage context is unavailable; reservation retained")
      return
    }
    const publicReply = reply || (!failure ? "The run finished without a public answer. Send a follow-up to continue." : "")
    if (publicReply && this.options.finalReply) {
      const terminalID = messages ? turnMessages(messages, state.turnBaseline).filter(message => message.type === "assistant").at(-1)?.id : undefined
      await this.options.finalReply(state, publicReply, terminalID)
    }
    if (state.budgetReservation) {
      if (failure?.message === "turn timed out") {
        await this.pauseSettlement("turn timed out without terminal usage context; reservation retained")
        return
      }
      if (!(await this.options.releaseBudgetReservation(state.budgetReservation))) {
        await this.pauseSettlement("reservation release was not acknowledged; reservation retained")
        return
      }
    }
    await this.recordTurnOutcome(state, failure)
    if (failure) {
      const key = failureKey(failure)
      if (key !== state.reportedError) {
        await this.options.delivery.event({ type: "error", message: failure.message })
        await this.options.store.patch({ reportedError: key, lastTurnError: failure.message })
      }
    }
    if (!this.options.finalReply && publicReply && publicReply !== state.lastSlackReply) {
      await this.options.delivery.toSlack({ type: "assistant", text: publicReply })
      await this.options.store.patch({ lastSlackReply: publicReply })
    }
    await this.options.delivery.event({ type: "settled" })
    const saved = await this.options.checkpoints.capture()
    if (!saved && !failure) {
      await this.options.delivery.event({ type: "error", message: "workspace checkpoint failed; retrying in the background" })
    }
    const afterSettle = await this.options.store.get()
    const queued = afterSettle.queue?.[0]
    await this.options.storage.transaction(async () => {
      await this.options.store.advance("idle")
      if (queued) await this.options.jobs.schedule(
        "admission:retry",
        Math.max(Date.now() + 1000, queued.nextAttemptAt ?? 0),
        { queueID: queued.id, reason: "turn-settled-queue-wake" },
      )
    })
    const reviewed = failure || !messages ? undefined : lastTurnPair(messages)
    if (reviewed) this.options.memoryReview?.(reviewed)
    this.recordTurnTelemetry(state, failure)
  }

  /** Count and emit the terminal turn event; nothing here can change settlement. */
  private recordTurnTelemetry(state: ConversationState, failure?: TurnFailure): void {
    void this.options.delivery.count(failure ? "turn.failed" : "turn.settled")
    const telemetry = {
      event: "turn.settled",
      conversationID: this.options.conversationID,
      sessionID: state.sessionID,
      turnID: state.budgetReservation?.reservationID,
      ...(state.runStartedAt ? { durationMs: Math.max(0, Date.now() - state.runStartedAt) } : {}),
      result: failure ? "failed" : "settled",
      reasonCode: failure ? "provider_failure" : "terminal_usage_acknowledged",
    } satisfies ConversationTelemetryInput
    if (this.options.telemetry) this.options.telemetry(telemetry)
    else emitConversationTelemetry(telemetry, undefined, traceId)
  }

  /**
   * Close the settled turn: clear the settlement marker and record the terminal
   * state. Terminal only after settlement succeeded, so a paused settlement
   * keeps the turn running and the hold held.
   */
  private async recordTurnOutcome(state: ConversationState, failure?: TurnFailure): Promise<void> {
    await this.options.store.patch({ settlementError: undefined })
    if (!state.turnID) return
    // A turn stopped by cancel settles as cancelled, not as a failure.
    const turn = await this.options.store.getTurn(state.turnID)
    await this.options.store.transitionTurn(state.turnID, {
      state: turn?.cancellation?.requested ? "cancelled" : failure ? "failed" : "completed",
      finishedAt: Date.now(),
    })
  }

  private async pollPermissions(sessionID: string, pending: PermissionSummary[]): Promise<void> {    await this.options.store.syncPermissions(sessionID, pending.map((request) => request.id))
    for (const request of pending) {
      try {
        const state = await this.options.store.get()
        const notification = state.permissionNotifications?.[request.id]
        if (state.sessionID !== sessionID || !notification || notification.sessionID !== sessionID ||
          notification.delivered || Date.now() < notification.nextAttemptAt) continue
        const attempts = Math.min(notification.attempts + 1, 32)
        const delay = Math.min(DELIVERY_RETRY_BASE_MS * 2 ** (attempts - 1), DELIVERY_RETRY_MAX_MS)
        // Persist the retry bound before external delivery. A lost acknowledgement
        // remains ambiguous; it can retry later, never claim exactly-once posting.
        if (!await this.options.store.updatePermissionNotification(request.id, sessionID, {
          attempts, nextAttemptAt: Date.now() + delay,
        })) continue
        await this.options.delivery.event({
          type: "permission", requestID: request.id, action: request.action, resources: request.resources,
        })
        await this.options.store.updatePermissionNotification(request.id, sessionID, { delivered: true, nextAttemptAt: 0 })
      } catch {
        await this.reportPermissionFailure()
      }
    }
  }

  private async reportPermissionFailure(): Promise<void> {
    await this.options.delivery.count("permission.notification.failed").catch(() => {})
    logEvent("permission.notification.failed", { conversationID: this.options.conversationID })
    // Never send a connector's own failure through that connector or expose its
    // error body, which can contain credentials or request payloads.
    await this.options.delivery.event({
      type: "error", message: "Permission notification failed; retrying with backoff.",
    }, { slack: false }).catch(() => {})
  }

  private async pollQuestions(sessionID: string, forms: Form[]): Promise<void> {
    if (!forms.length || !this.options.delivery.slackBotToken()) return
    const state = await this.options.store.get()
    if (state.sessionID !== sessionID || !state.slack) return
    const key = this.options.conversationKey() ?? this.options.conversationID
    const pending = forms.filter((form) => !state.announcedForms?.includes(form.id))
    const saved = await this.options.storage.get<FormRetries>("slackFormRetries")
    const retries: FormRetries = {
      sessionID,
      forms: Object.fromEntries(Object.entries(saved?.sessionID === sessionID ? saved.forms : {})
        .filter(([id]) => pending.some((form) => form.id === id))),
    }
    await this.options.storage.put("slackFormRetries", retries)
    for (const form of pending) {
      const retry = retries.forms[form.id]
      if (retry && Date.now() < retry.nextAttemptAt) continue
      const text = `${describeForm(form)}\n${answerHint(form)}`
      const common = { key, requestID: form.id, channel: state.slack.channel, sessionID }
      const actions = formButtons(form).map((option) => ({
        type: "button", text: { type: "plain_text", text: option.text },
        ...(option.style ? { style: option.style } : {}), action_id: "form_answer",
        value: JSON.stringify({ ...common, ...JSON.parse(option.value) }),
      })).filter((action) => action.value.length <= 2000)
      const blocks: Record<string, unknown>[] = [
        { type: "section", text: { type: "mrkdwn", text: text.slice(0, 2800) } },
        ...actions.map((action) => ({ type: "actions", elements: [action] })),
        { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Skip question" },
          action_id: "form_cancel", value: JSON.stringify(common) }] },
      ]
      try {
        await this.options.delivery.slack("chat.postMessage", {
          channel: state.slack.channel, text,
          ...(state.slack.replyTs ? { thread_ts: state.slack.replyTs } : {}), blocks,
        })
      } catch (error) {
        const attempts = Math.min((retry?.attempts ?? 0) + 1, 32)
        const delay = Math.min(DELIVERY_RETRY_BASE_MS * 2 ** (attempts - 1), DELIVERY_RETRY_MAX_MS)
        retries.forms[form.id] = { attempts, nextAttemptAt: Date.now() + delay }
        await this.options.storage.put("slackFormRetries", retries)
        await this.reportQuestionFailure(error)
        continue
      }
      const current = await this.options.store.get()
      if (current.sessionID === sessionID) {
        await this.options.store.patch({ announcedForms: [...(current.announcedForms ?? []), form.id].slice(-100) })
      }
    }
  }

  private async reportQuestionFailure(error: unknown): Promise<void> {
    await this.options.delivery.count("slack.form.failed").catch(() => {})
    logEvent("slack.form.failed", { conversationID: this.options.conversationID, message: errorMessage(error) })
    // The failing Slack connector must not also handle its own failure event.
    await this.options.delivery.event({
      type: "error", message: `Slack question delivery failed; retrying with backoff: ${errorMessage(error)}`,
    }, { slack: false }).catch(() => {})
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try { return JSON.stringify(error) } catch { return String(error) }
}
