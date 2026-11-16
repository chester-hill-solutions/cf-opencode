import type { makeClient } from "../opencode"
import { traceId } from "../telemetry"
import { ConversationStore, type ConversationState } from "../state"
import { parseFormAnswer, visibleFields, type Form, type FormAnswer } from "../slack-forms"
import { projectQuestions, type PendingQuestion } from "../questions"
import {
  emitConversationTelemetry,
  type ConversationTelemetryEventName,
  type ConversationTelemetryResult,
} from "./telemetry"

type OpenCodeClient = ReturnType<typeof makeClient>

export interface PermissionRequest {
  requestID: string
  decision: "once" | "always" | "reject"
  sessionID?: string
}

export interface SlackFormRequest {
  sessionID: string
  formID: string
  channel: string
  cancel?: boolean
  field?: string
  value?: string | number | boolean
}

export interface ControlPlaneOptions {
  conversationID?: string
  storage: DurableObjectStorage
  store: ConversationStore
  withClient<T>(fn: (client: OpenCodeClient) => Promise<T>, recoverOnRejection?: boolean): Promise<T>
  withAdmissionLock<T>(task: () => Promise<T>): Promise<T>
  hasPendingRuntimeUpgrade(): Promise<boolean>
  scheduleObservation(at: number, payload: {
    reservationID?: string
    reservationDate?: string
    sessionID: string
    reason: string
  }): Promise<void>
}

/** The two answer shapes the public question route accepts. */
function answerInput(body: unknown):
  | { kind: "permission"; decision: "once" | "always" | "reject" }
  | { kind: "question"; answer: FormAnswer }
  | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined
  const input = body as { decision?: unknown; answer?: unknown }
  if (input.decision === "once" || input.decision === "always" || input.decision === "reject") {
    return { kind: "permission", decision: input.decision }
  }
  if (input.answer && typeof input.answer === "object" && !Array.isArray(input.answer)) {
    return { kind: "question", answer: input.answer as FormAnswer }
  }
  return undefined
}

function questionConflict(error: "stale" | "not_pending" | "foreign_turn"): Response {
  return Response.json({ error }, { status: 409 })
}

/** Phases in which a turn can be blocked waiting for an answer. */
function isBlockingPhase(phase: ConversationState["phase"]): boolean {
  return phase === "running" || phase === "settling" || phase === "admitting"
}

/** Durable control token and session-scoped permission/form operations. */
export class ConversationControlPlane {
  private cached?: string
  private tokenFlight?: Promise<string>

  constructor(private readonly options: ControlPlaneOptions) {}

  private emitPermissionTelemetry(
    event: Extract<ConversationTelemetryEventName, `permission.${string}`>,
    result: ConversationTelemetryResult,
    reasonCode?: string,
  ): void {
    emitConversationTelemetry({
      event,
      ...(this.options.conversationID ? { conversationID: this.options.conversationID } : {}),
      result,
      ...(reasonCode ? { reasonCode } : {}),
    }, undefined, traceId)
  }

  get cachedToken(): string | undefined {
    return this.cached
  }

  clearCache(): void {
    this.cached = undefined
  }

  async token(): Promise<string> {
    if (this.cached) return this.cached
    if (this.tokenFlight) return this.tokenFlight
    const flight = this.loadOrCreateToken()
    this.tokenFlight = flight
    try {
      return await flight
    } finally {
      if (this.tokenFlight === flight) this.tokenFlight = undefined
    }
  }

  private async loadOrCreateToken(): Promise<string> {
    const token = await this.options.storage.transaction(async (txn) => {
      const stored = await txn.get<string>("controlToken")
      if (stored) return stored
      const bytes = new Uint8Array(32)
      crypto.getRandomValues(bytes)
      const created = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
      await txn.put("controlToken", created)
      return created
    })
    this.cached = token
    return token
  }

  /**
   * Pending interactions for a caller that is not Slack. A running turn can be
   * blocked on either kind, so both are read together. Unreadable runtime state
   * is `503`, never an empty list: "nothing asked" and "cannot tell" are
   * different answers.
   */
  async onQuestions(): Promise<Response> {
    const state = await this.options.store.get()
    if (!state.sessionID || !isBlockingPhase(state.phase)) return Response.json({ questions: [] })
    const sessionID = state.sessionID
    try {
      const [forms, permissions] = await Promise.all([
        this.pendingForms(sessionID),
        this.options.withClient((client) => client.permission.list({ sessionID }), false),
      ])
      const questions: PendingQuestion[] = projectQuestions({
        forms,
        permissions: permissions.filter((request) => state.pending[request.id] === sessionID),
        ...(state.turnID ? { turnID: state.turnID } : {}),
      })
      return Response.json({ questions })
    } catch {
      return Response.json({ error: "questions_unavailable" }, { status: 503 })
    }
  }

  /**
   * Answer one pending interaction. The first answer wins: the runtime's own
   * pending check decides, so a second answer from HTTP or Slack is
   * `409 not_pending` rather than a second reply.
   */
  async answerQuestion(requestID: string, body: unknown): Promise<Response> {
    const state = await this.options.store.get()
    if (!state.sessionID) return questionConflict("stale")
    const input = answerInput(body)
    if (!input) return Response.json({ error: "answer or decision is required" }, { status: 400 })
    return input.kind === "permission"
      ? this.answerPermission(state.sessionID, requestID, input.decision)
      : this.answerForm(state.sessionID, requestID, input.answer)
  }

  private async answerPermission(
    sessionID: string,
    requestID: string,
    decision: "once" | "always" | "reject",
  ): Promise<Response> {
    const owner = (await this.options.store.get()).pending[requestID]
    if (owner !== undefined && owner !== sessionID) return questionConflict("foreign_turn")
    if (owner === undefined) return questionConflict("not_pending")
    const response = await this.onPermission({ requestID, decision })
    if (response.status === 404) return questionConflict("not_pending")
    return response.ok ? new Response(null, { status: 204 }) : response
  }

  private async answerForm(sessionID: string, formID: string, answer: FormAnswer): Promise<Response> {
    try {
      await this.replyToForm(sessionID, formID, answer)
      return new Response(null, { status: 204 })
    } catch (error) {
      const message = errorMessage(error)
      if (message.includes("older session")) return questionConflict("stale")
      if (message.includes("no longer waiting")) return questionConflict("not_pending")
      return Response.json({ error: "questions_unavailable" }, { status: 503 })
    }
  }

  async pendingForms(sessionID: string): Promise<Form[]> {
    const rows = await this.options.withClient((client) => client.session.form.list({ sessionID }), false)
    const pending: Form[] = []
    for (const row of rows) {
      const form = await this.options.withClient((client) => client.session.form.get({ sessionID, formID: row.id }), false)
      if (form.sessionID === sessionID && form.state.status === "pending") pending.push(form)
    }
    return pending
  }

  async replyToForm(sessionID: string, formID: string, answer?: FormAnswer): Promise<void> {
    await this.options.withAdmissionLock(async () => {
      if (await this.options.hasPendingRuntimeUpgrade()) {
        throw new Error("A runtime upgrade is pending. Resume it before answering or cancelling a form.")
      }
      if ((await this.options.store.get()).sessionID !== sessionID) {
        throw new Error("This question belongs to an older session.")
      }
      const form = await this.options.withClient(
        (client) => client.session.form.get({ sessionID, formID }),
        false,
      )
      if (form.sessionID !== sessionID || form.state.status !== "pending") {
        throw new Error("This question is no longer waiting for an answer.")
      }
      if (answer) await this.options.withClient(
        (client) => client.session.form.reply({ sessionID, formID, answer }),
        false,
      )
      else await this.options.withClient(
        (client) => client.session.form.cancel({ sessionID, formID, message: "Cancelled from Slack" }),
        false,
      )
      const state = await this.options.store.get()
      await this.options.scheduleObservation(Date.now() + 1000, {
        reservationID: state.budgetReservation?.reservationID,
        reservationDate: state.budgetReservation?.date,
        sessionID,
        reason: "form-completion-poll",
      })
    })
  }

  async onSlackForm(input: SlackFormRequest): Promise<Response> {
    try {
      if (await this.options.hasPendingRuntimeUpgrade()) {
        return Response.json({ error: "runtime upgrade is pending" }, { status: 409 })
      }
      if (!input || typeof input.sessionID !== "string" || typeof input.formID !== "string") {
        return Response.json({ error: "invalid question" }, { status: 400 })
      }
      const state = await this.options.store.get()
      if (state.sessionID !== input.sessionID || !state.slack || state.slack.channel !== input.channel) {
        return Response.json({ error: "stale question or wrong channel" }, { status: 409 })
      }
      if (input.cancel === true) await this.replyToForm(input.sessionID, input.formID)
      else {
        const form = (await this.pendingForms(input.sessionID)).find((candidate) => candidate.id === input.formID)
        const fields = form && visibleFields(form)
        if (!form || fields?.length !== 1 || fields[0]?.key !== input.field ||
          !["string", "boolean", "number"].includes(typeof input.value)) {
          return Response.json({ error: "invalid question answer" }, { status: 400 })
        }
        const parsed = parseFormAnswer(form, String(input.value))
        if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 })
        await this.replyToForm(input.sessionID, input.formID, parsed.answer)
      }
      return Response.json({ ok: true })
    } catch (error) {
      return Response.json({ error: errorMessage(error) }, { status: 409 })
    }
  }

  async onPermission(input: PermissionRequest): Promise<Response> {
    return this.options.withAdmissionLock(async () => {
      if (await this.options.hasPendingRuntimeUpgrade()) {
        this.emitPermissionTelemetry("permission.reply.blocked", "blocked", "runtime_upgrade_pending")
        return Response.json({ error: "runtime upgrade is pending" }, { status: 409 })
      }
      const sessionID = (await this.options.store.peekPermission(input.requestID)) ?? input.sessionID
      if (!sessionID) {
        this.emitPermissionTelemetry("permission.reply.blocked", "blocked", "unknown_request")
        return Response.json({ ok: false, error: "unknown request" }, { status: 404 })
      }
      try {
        await this.options.withClient((client) =>
          client.permission.reply({ sessionID, requestID: input.requestID, decision: input.decision }),
        )
      } catch (error) {
        this.emitPermissionTelemetry("permission.reply.failed", "failed", "upstream_rejected")
        throw error
      }
      try {
        await this.options.store.clearPermission(input.requestID)
      } catch (error) {
        this.emitPermissionTelemetry("permission.reply.failed", "failed", "local_clear_failed")
        throw error
      }
      this.emitPermissionTelemetry(
        "permission.resolved",
        input.decision === "reject" ? "denied" : "approved",
      )
      return Response.json({ ok: true })
    })
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
