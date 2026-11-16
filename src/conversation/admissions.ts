import { ConversationStore, type BudgetReservation, type ConversationPhase, type QueueEnqueueResult, type QueuedMessage, type SlackTarget } from "../state"
import type { ConversationBudgetReservations } from "./budget-reservations"
import type { ConversationJobKind, ConversationJobPayload } from "./jobs"
import type { HarnessSettings } from "../settings"
import type { ConversationEvent } from "../events"
import { nextBudgetReset } from "../budget"
import { CAPACITY_ERROR, CAPACITY_RETRY_MS, isCapacityRejection, queueCapacity } from "../queue"
import { waitingKey, type TurnRecord } from "../turns"
import { emitConversationTelemetry, type ConversationTelemetrySink } from "./telemetry"

const POLL_MS = 2000

/** Everything one queued admission can answer with, including turn identity. */
export type QueueAdmissionOutcome =
  | (Extract<QueueEnqueueResult, { kind: "enqueued" }> & { duplicate?: boolean; turn?: TurnRecord })
  | { kind: "replayed"; turn: TurnRecord }
  | { kind: "conflict"; turnID: string }
  | { kind: "expired" }
  | Extract<QueueEnqueueResult, { kind: "queue_full" | "admission_in_progress" }>
  | { kind: "unavailable"; message: string }

/** Limits fixed before the transaction so every branch answers the same way. */
interface EnqueuePlan {
  nextAttemptAt: number
  queueLimit: number
}

export function isBusyPhase(phase: ConversationPhase | undefined): boolean {
  return phase === "admitting" || phase === "running" || phase === "settling" || phase === "queued"
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try { return JSON.stringify(error) } catch { return String(error) }
}

export interface ConversationAdmissionsOptions {
  conversationID?: string
  queueLimit?: number
  telemetry?: ConversationTelemetrySink
  storage: DurableObjectStorage
  store: ConversationStore
  budgetReservations: ConversationBudgetReservations
  session: {
    ensure(text: string, transport: "http" | "slack", slack?: SlackTarget): Promise<string>
    baseline(sessionID: string): Promise<string | undefined>
  }
  recovery: {
    active(): boolean
    pumping(): boolean
    pendingUpgrade(): Promise<boolean>
    pendingMaintenance?(): Promise<boolean>
  }
  jobs: {
    schedule(kind: ConversationJobKind, at: number, payload?: Omit<ConversationJobPayload, "epoch" | "dueAt">): Promise<void>
  }
  prompt(sessionID: string, text: string): Promise<void>
  settings(): Promise<Pick<HarnessSettings, "streaming">>
  delivery: {
    event(event: ConversationEvent, options?: { slack?: boolean }): Promise<void>
    postChunked(channel: string, text: string, threadTs?: string): Promise<void>
    count(name: string): Promise<void>
  }
  startStream(sessionID: string): Promise<void>
  waitUntil(promise: Promise<unknown>): void
}

/** Owns local admission state, queue retry, and accepted-turn transition bookkeeping. */
export class ConversationAdmissions {
  private admissionTail: Promise<unknown> = Promise.resolve()
  private admitting = false

  constructor(private readonly options: ConversationAdmissionsOptions) {}

  private emitLifecycle(input: Parameters<typeof emitConversationTelemetry>[0]): void {
    emitConversationTelemetry({ ...input, conversationID: this.options.conversationID }, this.options.telemetry)
  }

  get active(): boolean {
    return this.admitting
  }

  finishLocal(): void {
    this.admitting = false
  }

  withLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.admissionTail.then(task, task)
    this.admissionTail = run.then(() => undefined, () => undefined)
    return run
  }

  claim(): Promise<boolean> {
    return this.withLock(async () => {
      let claimed = false
      try {
        await this.options.storage.transaction(async () => {
          const state = await this.options.store.get()
          if (this.options.recovery.active() || await this.options.recovery.pendingUpgrade() || await this.options.recovery.pendingMaintenance?.() ||
            (state.queue?.length ?? 0) > 0 || isBusyPhase(state.phase)) return
          const admissionID = crypto.randomUUID()
          const admissionStartedAt = Date.now()
          await this.options.store.patch({ phase: "admitting", admissionID, admissionStartedAt })
          await this.options.jobs.schedule("recovery:wake", admissionStartedAt + POLL_MS, {
            admissionID,
            reason: "inflight-admission-recovery",
          })
          claimed = true
        })
      } catch (error) {
        console.warn("admission claim was not persisted", { error: errorMessage(error) })
      }
      this.admitting = claimed
      if (claimed) this.emitLifecycle({ event: "admission.started", result: "started" })
      return claimed
    })
  }

  async enqueue(text: string, slack?: SlackTarget, options: { replace?: boolean; idempotencyKey?: string; turn?: TurnRecord } = {}): Promise<QueueAdmissionOutcome> {
    try {
      if (this.options.recovery.active()) return { kind: "unavailable", message: "conversation recovery is active" }
      if (await this.options.recovery.pendingUpgrade()) return { kind: "unavailable", message: "runtime upgrade is pending" }
    } catch (error) {
      return { kind: "unavailable", message: errorMessage(error) }
    }
    const plan = { nextAttemptAt: Date.now() + 5000, queueLimit: queueCapacity(this.options.queueLimit) }
    const entry: QueuedMessage = {
      id: crypto.randomUUID(),
      enqueuedAt: Date.now(),
      source: slack ? "slack" : "http",
      text,
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      ...(options.turn ? { turnID: options.turn.id } : {}),
      ...(slack ? { slack } : {}),
      attempts: 0,
      nextAttemptAt: plan.nextAttemptAt,
    }
    let outcome: QueueAdmissionOutcome | undefined
    try {
      outcome = await this.withLock(() =>
        this.options.storage.transaction(() => this.persistEnqueue(entry, options, plan)))
    } catch (error) {
      console.warn("queue admission was not persisted", { error: errorMessage(error) })
      return { kind: "unavailable", message: errorMessage(error) }
    }
    return this.accepted(outcome, slack)
  }

  /** One admission decision, inside the caller's serialized transaction. */
  private async persistEnqueue(
    entry: QueuedMessage,
    options: { replace?: boolean; idempotencyKey?: string; turn?: TurnRecord },
    plan: EnqueuePlan,
  ): Promise<QueueAdmissionOutcome> {
    const blocked = await this.blocked(options, plan)
    if (blocked) return blocked
    const waiting = await this.waiting(options, plan)
    if (waiting) return waiting
    return this.beginAndEnqueue(entry, options, plan)
  }

  /** Refusals that outrank a new entry: maintenance, or a replace mid-admission. */
  private async blocked(
    options: { replace?: boolean },
    plan: EnqueuePlan,
  ): Promise<QueueAdmissionOutcome | undefined> {
    if (await this.options.recovery.pendingMaintenance?.()) {
      return { kind: "unavailable", message: "workspace maintenance is pending" }
    }
    if (options.replace && this.admitting) {
      const state = await this.options.store.get()
      return { kind: "admission_in_progress", depth: state.queue?.length ?? 0, limit: plan.queueLimit }
    }
    return undefined
  }

  /** A key that already names a waiting entry replays, conflicts, or repeats. */
  private async waiting(
    options: { idempotencyKey?: string; turn?: TurnRecord },
    plan: EnqueuePlan,
  ): Promise<QueueAdmissionOutcome | undefined> {
    if (!options.idempotencyKey) return undefined
    return waitingKey(await this.options.store.get(), options.idempotencyKey, plan.queueLimit, options.turn?.digest)
  }

  private async beginAndEnqueue(
    entry: QueuedMessage,
    options: { replace?: boolean; idempotencyKey?: string; turn?: TurnRecord },
    plan: EnqueuePlan,
  ): Promise<QueueAdmissionOutcome> {
    if (!options.turn) return this.storeEntry(entry, options, plan)
    const begun = await this.options.store.beginTurn(
      { ...options.turn, queueID: entry.id },
      { key: options.idempotencyKey },
    )
    if (begun.kind !== "created") return begun
    const result = await this.storeEntry(entry, options, plan)
    if (result.kind !== "enqueued") {
      // Nothing was queued, so the turn and its key must stay reusable.
      await this.options.store.abandonTurn(options.turn.id, options.idempotencyKey)
      return result
    }
    return { ...result, turn: begun.turn }
  }

  private async storeEntry(
    entry: QueuedMessage,
    options: { replace?: boolean },
    plan: EnqueuePlan,
  ): Promise<QueueAdmissionOutcome> {
    const result = await this.options.store.enqueue(entry, plan.queueLimit, options.replace)
    if (result.kind !== "enqueued" || result.position !== 1) return result
    await this.options.jobs.schedule("admission:retry", plan.nextAttemptAt, {
      queueID: entry.id,
      reason: options.replace ? "queued-admission-replaced" : "queued-admission",
    })
    return result
  }

  /** Announce a queued entry once, and answer with the persisted receipt. */
  private async accepted(
    outcome: QueueAdmissionOutcome | undefined,
    slack?: SlackTarget,
  ): Promise<QueueAdmissionOutcome> {
    if (!outcome || outcome.kind !== "enqueued") {
      return outcome ?? { kind: "unavailable", message: "queue admission was not persisted" }
    }
    if (outcome.duplicate) return outcome
    void this.options.delivery.count("queue.enqueued")
    this.emitLifecycle({ event: "queue.enqueued", result: "scheduled", reasonCode: "queued" })
    if (slack) {
      await this.options.delivery.postChunked(slack.channel, await this.queuedNotice(), slack.replyTs).catch(() => {})
    }
    return outcome
  }

  /**
   * What a queued message is actually waiting for. A paused settlement retains
   * a dispatched reservation, which blocks every drain, so promising a retry
   * there would name work nothing is going to do.
   */
  private async queuedNotice(): Promise<string> {
    const state = await this.options.store.get().catch(() => undefined)
    if (state?.settlementError && state.budgetReservation?.dispatched) {
      return "⏳ Queued, but this thread is waiting on an unsettled previous turn " +
        `(${state.settlementError}). It will not start on its own: that turn has to settle first. ` +
        "`!status` shows the details."
    }
    // Capacity is the one wait a user can understand: every slot is held by
    // another conversation, so this stays harness-only until one frees.
    if (state?.queue?.[0]?.lastError === CAPACITY_ERROR) {
      return `⏳ No container slot is free right now (${state.queue.length} queued). ` +
        "Your message retries every 30 seconds; `!status` shows the queue. Nothing was lost."
    }
    return "⏳ Container busy — queued; I'll retry shortly."
  }

  async scheduleQueuedRetry(
    queued: QueuedMessage,
    retryAt: number,
    updates: Partial<QueuedMessage> = {},
    reason: string,
  ): Promise<void> {
    await this.options.storage.transaction(async () => {
      const updated = await this.options.store.updateQueueHead(queued.id, { ...updates, nextAttemptAt: retryAt })
      const state = await this.options.store.get()
      if (!updated || state.queue?.[0]?.id !== queued.id) return
      await this.options.store.advance("queued")
      await this.options.jobs.schedule("admission:retry", retryAt, { queueID: queued.id, reason })
    })
  }

  private async scheduleCurrentQueueHead(reason: string): Promise<void> {
    await this.options.storage.transaction(async () => {
      const head = (await this.options.store.get()).queue?.[0]
      if (!head) return
      await this.options.jobs.schedule("admission:retry", Math.max(head.nextAttemptAt ?? 0, Date.now()), {
        queueID: head.id,
        reason,
      })
    })
  }

  async drainQueue(): Promise<boolean> {
    if (this.admitting || this.options.recovery.pumping() || this.options.recovery.active()) return false
    // Claim the queued work under the same lock as admissions, so a new
    // message cannot start while the queue is being drained.
    const queued = await this.withLock(async () => {
      const state = await this.options.store.get()
      // The warm stream stays connected while idle; it must not block the queue.
      if (await this.options.recovery.pendingMaintenance?.()) return undefined
      const queued = state.queue?.[0]
      if (!queued || this.admitting || this.options.recovery.pumping() ||
        this.options.recovery.active() || state.budgetReservation?.dispatched) return undefined
      if (Date.now() < (queued.nextAttemptAt ?? 0)) return undefined
      const phase = state.phase ?? "idle"
      if (phase === "running" || phase === "settling" || phase === "admitting") return undefined
      await this.options.store.advance("admitting")
      this.admitting = true
      return queued
    })
    if (!queued) return false
    this.emitLifecycle({ event: "admission.started", result: "started", reasonCode: "queued_admission" })

    let sessionID = ""
    let baseline: string | undefined
    try {
      sessionID = await this.options.session.ensure(queued.text, queued.slack ? "slack" : "http", queued.slack)
      baseline = await this.options.session.baseline(sessionID)
    } catch (error) {
      this.admitting = false
      // Capacity pressure is temporary: keep the message queued until a lease
      // frees up instead of burning the prompt-retry budget and dropping it.
      if (isCapacityRejection(error)) {
        const retryAt = Date.now() + CAPACITY_RETRY_MS
        this.emitLifecycle({
          event: "queue.capacity", attempt: queued.attempts, result: "scheduled", reasonCode: "capacity",
        })
        await this.scheduleQueuedRetry(queued, retryAt, { lastError: "container capacity reached" }, "queue-capacity-retry")
        return false
      }
      const attempts = queued.attempts + 1
      if (attempts >= 5) {
        const removed = await this.withLock(() => this.options.storage.transaction(async () => {
          const didRemove = await this.options.store.removeQueueHead(queued.id)
          if (didRemove) {
            const current = await this.options.store.get()
            await this.options.store.patch({
              phase: current.queue?.length ? "queued" : ((current.phase ?? "idle") === "admitting" ? "idle" : current.phase),
              lastTurnError: errorMessage(error),
            })
          }
          return didRemove
        }))
        void this.options.delivery.count("queue.failed")
        this.emitLifecycle({ event: "queue.failed", attempt: attempts, result: "failed", reasonCode: "retry_limit" })
        await this.options.delivery.event(
          { type: "error", message: "queued message could not start: " + errorMessage(error) },
          { slack: false },
        )
        if (queued.slack) {
          await this.options.delivery.postChunked(
            queued.slack.channel,
            "⚠️ Couldn't start the session: " + errorMessage(error),
            queued.slack.replyTs,
          ).catch(() => {})
        }
        if (removed) await this.scheduleCurrentQueueHead("queued-after-retry-limit")
        return false
      }
      const retryAt = Date.now() + Math.min(5000 * attempts, 30_000)
      await this.scheduleQueuedRetry(queued, retryAt, { attempts, lastError: errorMessage(error) }, "queue-session-retry")
      return false
    }

    const reservation = await this.options.budgetReservations.acquire()
    if (reservation.kind === "denied") {
      this.admitting = false
      const retryAt = nextBudgetReset(Date.now())
      const notice = "daily budget reached"
      if (queued.slack && queued.lastError !== notice) {
        await this.options.delivery.postChunked(
          queued.slack.channel,
          "⚠️ " + reservation.message + ". I'll retry this queued message after the daily reset.",
          queued.slack.replyTs,
        ).catch(() => {})
      }
      await this.scheduleQueuedRetry(queued, retryAt, { lastError: notice }, "queue-budget-reset")
      return false
    }
    if (reservation.kind === "conflict" || reservation.kind === "unavailable") {
      this.admitting = false
      const retryAt = Date.now() + 30_000
      if (queued.slack && queued.lastError !== reservation.message) {
        await this.options.delivery.postChunked(
          queued.slack.channel,
          "⚠️ Queued message is waiting for budget authority: " + reservation.message + ".",
          queued.slack.replyTs,
        ).catch(() => {})
      }
      await this.scheduleQueuedRetry(queued, retryAt, { lastError: reservation.message }, "queue-budget-retry")
      return false
    }
    if (reservation.kind === "already-dispatched") {
      await this.resumeDispatched()
      if (queued.slack) {
        await this.options.delivery.postChunked(
          queued.slack.channel,
          "⚠️ The queued message is waiting for a previous prompt with an unresolved dispatch result.",
          queued.slack.replyTs,
        ).catch(() => {})
      }
      return false
    }
    if (!(await this.options.budgetReservations.markDispatched(reservation.reservation, baseline, queued.id))) {
      this.admitting = false
      const retryAt = Date.now() + 30_000
      await this.scheduleQueuedRetry(queued, retryAt, { lastError: "could not persist dispatch state" }, "queue-dispatch-marker-retry")
      return false
    }
    // The dispatch marker already persisted turn observation. A best-effort
    // wake for the next queue head must never prevent this head's one prompt.
    await this.scheduleCurrentQueueHead("queued-after-head-dispatch").catch((error) => {
      console.warn("next queued admission wake was not persisted", { error: errorMessage(error) })
    })
    try {
      // Once marked, request failure is ambiguous and this queue item must not
      // be replayed or released as if dispatch definitely never happened.
      await this.options.prompt(sessionID, queued.text)
    } catch (error) {
      this.admitting = false
      await this.recordAccepted(baseline, "ambiguous")
      void this.options.delivery.count("queue.dispatch_ambiguous")
      this.emitLifecycle({ event: "queue.dispatch_ambiguous", result: "failed", reasonCode: "dispatch_ambiguous" })
      await this.options.delivery.event({
        type: "error",
        message: "queued prompt dispatch outcome is unknown; reservation retained: " + errorMessage(error),
      }).catch(() => {})
      if (queued.slack) {
        await this.options.delivery.postChunked(
          queued.slack.channel,
          "⚠️ Queued prompt dispatch outcome is unknown; its reservation is retained and it will not be retried automatically.",
          queued.slack.replyTs,
        ).catch(() => {})
      }
      return false
    }

    // The dispatch marker already consumed this queued item atomically. A new
    // follow-up may have been queued while the provider request was pending.
    void this.options.delivery.count("queue.drained")
    this.emitLifecycle({
      event: "queue.drained", attempt: queued.attempts, result: "succeeded", reasonCode: "dispatch_acknowledged",
    })
    await this.recordAccepted(baseline, "acknowledged")
    const settings = await this.options.settings().catch(() => undefined)
    if (settings?.streaming) this.options.waitUntil(this.options.startStream(sessionID))
    return true
  }

  async recordAccepted(
    baseline: string | undefined,
    dispatchOutcome?: "acknowledged" | "ambiguous",
  ): Promise<void> {
    try {
      await this.startRun(baseline)
    } catch {
      this.emitLifecycle({ event: "turn.start.failed", result: "failed", reasonCode: "bookkeeping_failed" })
      await this.options.store.patch({ phase: "running", turnBaseline: baseline, lastReply: undefined, lastSlackReply: undefined }).catch(() => {})
      const state = await this.options.store.get().catch(() => undefined)
      await this.options.jobs.schedule("turn:observe", Date.now() + POLL_MS, {
        reservationID: state?.budgetReservation?.reservationID,
        reservationDate: state?.budgetReservation?.date,
        sessionID: state?.sessionID,
        reason: "accepted-turn-bookkeeping-recovery",
      }).catch(() => {})
    } finally {
      if (dispatchOutcome) {
        const state = await this.options.store.get().catch(() => undefined)
        this.emitLifecycle({
          event: "admission.settled",
          sessionID: state?.sessionID,
          turnID: state?.budgetReservation?.reservationID,
          result: "settled",
          reasonCode: dispatchOutcome === "acknowledged" ? "dispatch_acknowledged" : "dispatch_ambiguous",
        })
      }
    }
  }

  async resumeDispatched(scheduleRecovery = true): Promise<void> {
    this.admitting = false
    if (!(await this.options.store.advance("running"))) {
      await this.options.store.patch({ phase: "running" }).catch(() => {})
    }
    const state = await this.options.store.get()
    if (scheduleRecovery) await this.options.jobs.schedule("recovery:wake", Date.now() + POLL_MS, {
      reservationID: state.budgetReservation?.reservationID,
      reservationDate: state.budgetReservation?.date,
      sessionID: state.sessionID,
      reason: "dispatched-turn-recovery",
    }).catch(() => {})
  }

  async startRun(turnBaseline?: string): Promise<void> {
    this.admitting = false
    const current = await this.options.store.get()
    const dispatchedAt = current.budgetReservation?.dispatched === true &&
      typeof current.runStartedAt === "number" && Number.isFinite(current.runStartedAt) && current.runStartedAt > 0
      ? current.runStartedAt
      : Date.now()
    await this.options.storage.transaction(async () => {
      await this.options.store.patch({
        lastReply: undefined,
        lastSlackReply: undefined,
        // Keep the pre-provider durable dispatch time so immediate provider
        // failure records remain attributable to this accepted turn.
        runStartedAt: dispatchedAt,
        turnBaseline,
      })
      if (!(await this.options.store.advance("running"))) {
        await this.options.store.patch({ phase: "running" })
      }
      if (current.turnID) {
        await this.options.store.transitionTurn(current.turnID, {
          state: "running",
          startedAt: current.runStartedAt ?? dispatchedAt,
          ...(current.sessionID ? { sessionID: current.sessionID } : {}),
        })
      }
      await this.options.jobs.schedule("turn:observe", Date.now() + POLL_MS, {
        sessionID: (await this.options.store.get()).sessionID,
        reason: "turn-started",
      })
    })
    const state = await this.options.store.get()
    this.emitLifecycle({
      event: "turn.started",
      sessionID: state.sessionID,
      turnID: state.budgetReservation?.reservationID,
      result: "started",
      reasonCode: "dispatch_accepted",
    })
  }
}
