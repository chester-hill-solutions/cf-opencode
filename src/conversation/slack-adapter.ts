import { makeClient } from "../opencode"
import type { ConversationEvent } from "../events"
import type { SlackContextMessage } from "../adapters/slack"
import { chunkText, formatSlackContext, mrkdwnEscape } from "../adapters/slack"
import type { BudgetReservation, SlackTarget } from "../state"
import type { ConversationStore } from "../state"
import type { SlackEventRequest } from "./requests"
import type { ConversationAdmissions } from "./admissions"
import type { ConversationBudgetReservations } from "./budget-reservations"
import type { ConversationControlPlane, SlackFormRequest } from "./control-plane"
import type { ConversationRuntimeUpgrades } from "./runtime-upgrades"
import type { ConversationTurnExecution } from "./turn-execution"
import type { ConversationScheduler } from "./scheduler"
import type { ConversationRecoveryActions } from "./recovery-actions"
import type { ConversationSessions } from "./sessions"
import type { HarnessSettings } from "../settings"
import { logEvent } from "../log"
import { retryAfterSeconds } from "../backoff"
import { isSettled } from "../messages"
import { parseModelRef, type Env } from "../env"
import { checkSlackImageModel, downloadSlackImage, formatSlackImageModelSuggestions, type ImageModelCheck, type SlackImageAttachment } from "../slack-images"
import { parseSlackCommand } from "../slack-command-format"
import { handleSlackCommand } from "../slack-commands"
import { isBusyPhase } from "./admissions"

type OpenCodeClient = ReturnType<typeof makeClient>

export type { SlackEventRequest } from "./requests"

export interface ConversationSlackAdapterOptions {
  store: ConversationStore
  sessions: Pick<ConversationSessions, "ensure" | "baseline">
  admissions: Pick<ConversationAdmissions,
    "withLock" | "claim" | "enqueue" | "finishLocal" | "resumeDispatched" | "recordAccepted" | "active">
  budget: Pick<ConversationBudgetReservations, "acquire" | "markDispatched">
  controlPlane: Pick<ConversationControlPlane, "pendingForms" | "replyToForm">
  upgrades: Pick<ConversationRuntimeUpgrades, "hasPending">
  turnExecution: Pick<ConversationTurnExecution, "isPumping" | "startStream">
  scheduler: Pick<ConversationScheduler, "schedule">
  recovery: Pick<ConversationRecoveryActions, "active">
  withClient<T>(fn: (client: OpenCodeClient) => Promise<T>, recoverOnRejection?: boolean): Promise<T>
  withUsageLifecycle(cleanup: () => Promise<Response>): Promise<Response>
  settings(): Promise<HarnessSettings>
  usageToday(): Promise<{ date: string; costUSD: number; reservedUSD: number; input: number; output: number; historicalUsageUnreconciled?: boolean; unknownReconciliationCount?: number }>
  deliver(event: ConversationEvent, options?: { slack?: boolean }): Promise<void>
  waitUntil(promise: Promise<unknown>): void
  conversationKey(): string
  env(): Pick<Env, "SLACK_BOT_TOKEN" | "SLACK_BOT_USER_ID">
}

/** Slack event policy, commands, model/session controls, and delivery. */
export class ConversationSlackAdapter {
  constructor(private readonly options: ConversationSlackAdapterOptions) {}

  async handleControl(text: string, input: SlackEventRequest, target: SlackTarget): Promise<void> {
    await handleSlackCommand(text, {
      getState: () => this.options.store.get(),
      getDefaultModel: async () => (await this.options.settings()).model,
      getModels: async () => (await this.options.withClient((client) => client.model.list({ location: { directory: "/workspace" } }), false)).data,
      getSession: (sessionID) => this.options.withClient((client) => client.session.get({ sessionID }), false),
      listSessions: async () => (await this.options.withClient((client) => client.session.list({ limit: 100, order: "desc" }), false)).data,
      switchModel: (ref) => this.changeModel(ref),
      selectSession: (sessionID) => this.changeSession(sessionID, target),
      newSession: () => this.changeSession(undefined, target),
      stop: () => this.stopWork(),
      leave: async () => {
        if (input.event.channel_type === "im") return "This is a DM; use `!new` for a fresh session or `!stop` to interrupt work."
        await this.options.store.patch({ slackEngaged: false })
        return "Stopped following this thread. Mention me to re-engage; use `!stop` to interrupt current work."
      },
      listForms: (sessionID) => this.options.controlPlane.pendingForms(sessionID),
      answerForm: (sessionID, formID, answer) => this.options.controlPlane.replyToForm(sessionID, formID, answer),
      cancelForm: (sessionID, formID) => this.options.controlPlane.replyToForm(sessionID, formID),
      usageText: () => this.usageText(),
      reply: (message) => this.postChunked(target.channel, message, target.replyTs),
      setupUrl: input.appUrl ? `${new URL(input.appUrl).origin}/onboarding/` : "the web app's /onboarding/ page",
    })
  }

  async checkImageModel(sessionID: string): Promise<ImageModelCheck> {
    const models = (await this.options.withClient(
      (client) => client.model.list({ location: { directory: "/workspace" } }), false,
    )).data
    let selected: { providerID: string; id: string } | undefined
    try {
      const session = await this.options.withClient((client) => client.session.get({ sessionID }), false)
      const model = (session as { model?: { providerID?: unknown; id?: unknown } }).model
      if (typeof model?.providerID === "string" && typeof model.id === "string") {
        selected = { providerID: model.providerID, id: model.id }
      }
    } catch {
      // Missing session metadata is unknown; do not guess from a stale override.
    }
    return checkSlackImageModel(selected, models)
  }

  imageCompatibilityMessage(check: ImageModelCheck, catalogueUnavailable = false): string {
    if (catalogueUnavailable) {
      return "⚠️ I couldn't check image support right now, so nothing was sent or reserved. Please resend the image when the bot is ready."
    }
    if (check.status === "compatible") return ""
    if (check.status === "unknown") {
      const candidates = formatSlackImageModelSuggestions(check.suggestions)
      return candidates
        ? `⚠️ I couldn't confirm that the selected model can read images, so nothing was sent or reserved. Compatible connected models: ${mrkdwnEscape(candidates)}. Choose one with !model provider/model, then resend the image.`
        : "⚠️ I couldn't confirm that the selected model can read images, so nothing was sent or reserved. Use `!model` to check available models or `!setup` to connect a provider, then resend the image."
    }
    const candidates = formatSlackImageModelSuggestions(check.suggestions)
    return candidates
      ? `⚠️ The selected model can't read images, so nothing was sent or reserved. Compatible connected models: ${mrkdwnEscape(candidates)}. Switch with !model provider/model, then resend the image.`
      : "⚠️ No connected model reports image input support, so nothing was sent or reserved. Use `!setup` to connect a compatible provider, then resend the image."
  }

  async onEvent(input: SlackEventRequest): Promise<Response> {
    const event = input.event
    if (!event.channel || !event.ts) return Response.json({ ok: true })
    const files = event.files ?? []
    const hasImage = files.length > 0
    const isFileShare = event.subtype === "file_share" && hasImage
    if (event.bot_id || (event.subtype && !isFileShare)) return Response.json({ ok: true })
    if (!event.text && !hasImage) return Response.json({ ok: true })
    const strippedText = this.stripMention(event.text ?? "")
    const text = strippedText || (hasImage ? "Describe the attached image." : "")
    if (!text) return Response.json({ ok: true })
    if (await this.options.upgrades.hasPending()) {
      const target = { channel: event.channel, ...(input.replyTs ? { replyTs: input.replyTs } : {}) }
      await this.postChunked(target.channel, "Runtime upgrade is pending. No message was queued; an operator must resume the upgrade first.", target.replyTs).catch(() => {})
      return Response.json({ error: "runtime upgrade pending" }, { status: 409 })
    }
    const isDm = event.channel_type === "im"
    const state = await this.options.store.get()
    if (!isDm && event.type !== "app_mention" && (!event.thread_ts || !state.slackEngaged)) {
      return Response.json({ ok: true })
    }
    if (input.eventID && !(await this.options.store.claimEvent(input.eventID))) return Response.json({ ok: true })
    if (!isDm && event.type === "app_mention") await this.options.store.patch({ slackEngaged: true })
    const target: SlackTarget = { channel: event.channel, ...(input.replyTs ? { replyTs: input.replyTs } : {}) }

    if (parseSlackCommand(text)) {
      if (input.eventID) await this.options.store.markTombstone(input.eventID)
      await this.handleControl(text, input, target)
      return Response.json({ ok: true, command: true })
    }

    let prompt = text
    let sessionID = ""
    let baseline: string | undefined
    let imageAttachment: SlackImageAttachment | undefined
    let accepted = false
    try {
      prompt = await this.buildPrompt(event.channel, event.ts, event.thread_ts, text)
    } catch (error) {
      logEvent("admission.failed", { transport: "slack", stage: "context" })
      if (hasImage) {
        await this.postChunked(target.channel, "⚠️ I couldn't prepare that image message. Nothing was sent or reserved; please resend the image.", target.replyTs).catch(() => {})
        if (input.eventID) await this.options.store.releaseEvent(input.eventID).catch(() => {})
        return Response.json({ ok: true })
      }
      const queued = await this.options.admissions.enqueue(prompt, target)
      accepted = queued
      if (!queued) {
        await this.postChunked(target.channel, `⚠️ Container busy and a message is already queued: ${this.errorMessage(error)}`, target.replyTs).catch(() => {})
      }
      if (!accepted && input.eventID) await this.options.store.releaseEvent(input.eventID).catch(() => {})
      return Response.json({ ok: true, queued })
    }

    if (!(await this.options.admissions.claim())) {
      if (hasImage) {
        await this.postChunked(target.channel, "⏳ I'm busy with another turn, so I didn't send or queue this image. Please resend it when I'm ready.", target.replyTs).catch(() => {})
        if (input.eventID) await this.options.store.releaseEvent(input.eventID).catch(() => {})
        return Response.json({ ok: true, queued: false })
      }
      const queued = await this.options.admissions.enqueue(prompt, target)
      accepted = queued
      if (!queued) await this.postChunked(target.channel, "⚠️ Container busy and a message is already queued.", target.replyTs).catch(() => {})
      if (!accepted && input.eventID) await this.options.store.releaseEvent(input.eventID).catch(() => {})
      return Response.json({ ok: true, queued })
    }

    if (hasImage) {
      try {
        sessionID = await this.options.sessions.ensure(text, "slack", target)
      } catch {
        this.options.admissions.finishLocal()
        await this.options.store.advance("idle")
        await this.postChunked(target.channel, "⚠️ I couldn't start the session, so I didn't send or queue this image. No usage hold was created; please resend it later.", target.replyTs).catch(() => {})
        if (input.eventID) await this.options.store.releaseEvent(input.eventID).catch(() => {})
        return Response.json({ ok: true, queued: false })
      }

      let check: ImageModelCheck
      let catalogueUnavailable = false
      try {
        check = await this.checkImageModel(sessionID)
      } catch {
        catalogueUnavailable = true
        check = checkSlackImageModel(undefined, undefined)
      }
      if (check.status !== "compatible") {
        this.options.admissions.finishLocal()
        await this.options.store.advance("idle")
        await this.postChunked(target.channel, this.imageCompatibilityMessage(check, catalogueUnavailable), target.replyTs).catch(() => {})
        if (input.eventID) await this.options.store.releaseEvent(input.eventID).catch(() => {})
        return Response.json({ ok: true, image: "model-incompatible" })
      }
      try {
        imageAttachment = await downloadSlackImage(files, this.options.env().SLACK_BOT_TOKEN ?? "")
      } catch (error) {
        this.options.admissions.finishLocal()
        await this.options.store.advance("idle")
        await this.postChunked(target.channel, `⚠️ ${this.errorMessage(error)} Nothing was sent or reserved; please resend the image.`, target.replyTs).catch(() => {})
        if (input.eventID) await this.options.store.releaseEvent(input.eventID).catch(() => {})
        return Response.json({ ok: true, image: "invalid" })
      }
    }

    try {
      if (!sessionID) sessionID = await this.options.sessions.ensure(text, "slack", target)
      baseline = await this.options.sessions.baseline(sessionID)
    } catch (error) {
      this.options.admissions.finishLocal()
      logEvent("admission.failed", { transport: "slack", stage: "readiness" })
      if (hasImage) {
        imageAttachment = undefined
        await this.options.store.advance("idle")
        await this.postChunked(target.channel, "⚠️ I couldn't start the session, so I didn't send or queue this image. No usage hold was created; please resend it later.", target.replyTs).catch(() => {})
        if (input.eventID) await this.options.store.releaseEvent(input.eventID).catch(() => {})
        return Response.json({ ok: true, queued: false })
      }
      const queued = await this.options.admissions.enqueue(prompt, target)
      accepted = queued
      if (!queued) {
        await this.options.store.advance("idle")
        await this.postChunked(target.channel, `⚠️ Container busy and a message is already queued: ${this.errorMessage(error)}`, target.replyTs).catch(() => {})
      }
      if (!accepted && input.eventID) await this.options.store.releaseEvent(input.eventID).catch(() => {})
      return Response.json({ ok: true, queued })
    }

    const reservation = await this.options.budget.acquire()
    if (reservation.kind === "denied") {
      imageAttachment = undefined
      this.options.admissions.finishLocal()
      await this.options.store.advance("idle")
      await this.postChunked(target.channel, `⚠️ ${reservation.message}. Raise the budget in settings or wait for the daily reset.`, target.replyTs).catch(() => {})
      if (input.eventID) await this.options.store.releaseEvent(input.eventID).catch(() => {})
      return Response.json({ ok: true })
    }
    if (reservation.kind === "conflict" || reservation.kind === "unavailable") {
      imageAttachment = undefined
      this.options.admissions.finishLocal()
      await this.options.store.advance("idle")
      await this.postChunked(target.channel, `⚠️ ${reservation.message}. No prompt was sent; please try again shortly.`, target.replyTs).catch(() => {})
      if (input.eventID) await this.options.store.releaseEvent(input.eventID).catch(() => {})
      return Response.json({ ok: true })
    }
    if (reservation.kind === "already-dispatched") {
      imageAttachment = undefined
      await this.options.admissions.resumeDispatched()
      await this.postChunked(target.channel, "⚠️ A previous prompt has an unresolved dispatch result. This message was not sent; please retry after it settles.", target.replyTs).catch(() => {})
      if (input.eventID) await this.options.store.releaseEvent(input.eventID).catch(() => {})
      return Response.json({ ok: true })
    }
    if (!(await this.options.budget.markDispatched(reservation.reservation, baseline))) {
      imageAttachment = undefined
      this.options.admissions.finishLocal()
      await this.options.store.advance("idle")
      await this.postChunked(target.channel, "⚠️ Could not persist dispatch state. No prompt was sent; please retry shortly.", target.replyTs).catch(() => {})
      if (input.eventID) await this.options.store.releaseEvent(input.eventID).catch(() => {})
      return Response.json({ ok: true })
    }
    try {
      await this.options.withClient((client) => client.session.prompt({
        sessionID,
        text: prompt,
        ...(imageAttachment ? { files: [imageAttachment] } : {}),
      }))
    } catch (error) {
      imageAttachment = undefined
      await this.options.admissions.recordAccepted(baseline, "ambiguous")
      if (input.eventID) await this.options.store.markTombstone(input.eventID).catch(() => {})
      await this.options.deliver({ type: "error", message: `prompt dispatch outcome is unknown; reservation retained: ${this.errorMessage(error)}` }).catch(() => {})
      return Response.json({ ok: true })
    }
    accepted = true
    imageAttachment = undefined
    await this.options.admissions.recordAccepted(baseline, "acknowledged")
    if (input.eventID) await this.options.store.markTombstone(input.eventID).catch(() => {})
    const settings = await this.options.settings().catch(() => undefined)
    if (settings?.streaming) this.options.waitUntil(this.options.turnExecution.startStream(sessionID))
    return Response.json({ ok: true, sessionID })
  }

  async deliverToSlack(event: ConversationEvent): Promise<void> {
    const state = await this.options.store.get()
    if (!state.slack || !this.options.env().SLACK_BOT_TOKEN) return
    if (event.type === "assistant") await this.postChunked(state.slack.channel, event.text, state.slack.replyTs)
    if (event.type === "permission") await this.postPermission(state.slack, event)
    if (event.type === "error") await this.postChunked(state.slack.channel, `⚠️ ${event.message}`, state.slack.replyTs)
  }

  async postChunked(channel: string, text: string, threadTs?: string): Promise<void> {
    for (const chunk of chunkText(text)) await this.slack("chat.postMessage", { channel, text: chunk, ...(threadTs ? { thread_ts: threadTs } : {}) })
  }

  private async postPermission(target: SlackTarget, event: Extract<ConversationEvent, { type: "permission" }>): Promise<void> {
    const key = this.options.conversationKey()
    const resources = (event.resources ?? []).map((resource) => `• \`${mrkdwnEscape(resource)}\``).join("\n")
    await this.slack("chat.postMessage", {
      channel: target.channel,
      ...(target.replyTs ? { thread_ts: target.replyTs } : {}),
      text: `🔐 Approval needed — ${event.action ?? "unknown action"}`,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: `🔐 *Approval needed* — \`${mrkdwnEscape(event.action ?? "unknown action")}\`\n${resources || "• _(no resources)_"}` } }, {
        type: "actions",
        elements: [
          button("Approve once", "primary", "oc_perm_once", key, event.requestID, target.channel),
          button("Always allow", undefined, "oc_perm_always", key, event.requestID, target.channel),
          button("Deny", "danger", "oc_perm_reject", key, event.requestID, target.channel),
        ],
      }],
    })
  }

  private stripMention(text: string): string {
    const botUserId = this.options.env().SLACK_BOT_USER_ID
    if (!botUserId) return text.trim()
    return text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim()
  }

  async slack(method: string, body: Record<string, unknown>, attempt = 0): Promise<Record<string, any>> {
    const token = this.options.env().SLACK_BOT_TOKEN
    if (!token) throw new Error("SLACK_BOT_TOKEN is not configured")
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    })
    if (res.status === 429) {
      if (attempt >= 2) throw new Error(`${method}: rate_limited`)
      await sleep(retryAfterSeconds(res.headers.get("retry-after")) * 1000)
      return this.slack(method, body, attempt + 1)
    }
    const json = await res.json() as { ok?: boolean; error?: string }
    if (!json.ok) throw new Error(`${method}: ${json.error ?? "unknown_error"}`)
    return json as Record<string, any>
  }

  private async usageText(): Promise<string> {
    const usage = await this.options.usageToday()
    const settings = await this.options.settings()
    const historyNote = usage.historicalUsageUnreconciled
      ? `\n⚠ Historical usage remains unreconciled${usage.unknownReconciliationCount ? ` (${usage.unknownReconciliationCount} unknown amount${usage.unknownReconciliationCount === 1 ? "" : "s"} acknowledged)` : ""}.`
      : ""
    return `*Workspace usage — ${usage.date} (UTC)*\nReported spend: $${usage.costUSD.toFixed(4)}\nReserved: $${usage.reservedUSD.toFixed(4)}\nTokens: ${usage.input} in / ${usage.output} out\nDaily budget: ${settings.dailyBudgetUSD > 0 ? `$${settings.dailyBudgetUSD.toFixed(2)}` : "unlimited"}\nProvider quota and billing may differ from reported usage.${historyNote}`
  }

  private async requireIdle(): Promise<import("../state").ConversationState> {
    const state = await this.options.store.get()
    if (await this.options.upgrades.hasPending()) throw new Error("A runtime upgrade is pending. Resume it before changing the model or session.")
    if (this.options.admissions.active || this.options.turnExecution.isPumping || this.options.recovery.active || isBusyPhase(state.phase) || state.queued || state.budgetReservation) {
      throw new Error("This conversation has unfinished work. Use `!stop`, then wait for settlement; `!status` shows any retained usage hold.")
    }
    return state
  }

  private async changeModel(ref: string): Promise<void> {
    await this.options.admissions.withLock(async () => {
      const state = await this.requireIdle()
      const model = parseModelRef(ref)
      if (!model) throw new Error("Use a provider/model reference from `!model`.")
      if (state.sessionID) await this.options.withClient((client) => client.session.switchModel({ sessionID: state.sessionID!, model }), false)
      await this.options.store.patch({ modelOverride: ref })
    })
  }

  private async changeSession(sessionID: string | undefined, target: SlackTarget): Promise<void> {
    await this.options.admissions.withLock(async () => {
      const current = await this.requireIdle()
      let selectedModel = current.modelOverride
      if (sessionID) {
        const detail = await this.options.withClient((client) => client.session.get({ sessionID }), false)
        if (detail.id !== sessionID || detail.parentID || detail.location?.directory !== "/workspace") {
          throw new Error("That session does not belong to this conversation's workspace.")
        }
        selectedModel = detail.model ? `${detail.model.providerID}/${detail.model.id}${detail.model.variant ? `#${detail.model.variant}` : ""}` : undefined
      }
      const response = await this.options.withUsageLifecycle(async () => {
        await this.options.store.patch({
          sessionID, modelOverride: selectedModel, transport: "slack", slack: target,
          turnBaseline: undefined, runStartedAt: undefined, pending: {}, announcedForms: [],
          lastReply: undefined, lastSlackReply: undefined, reportedError: undefined, lastTurnError: undefined,
          usage: undefined, usageAux: undefined, usageCursor: undefined, usageTerminal: undefined,
          usageExecution: undefined, usageError: undefined, settlementError: undefined,
        })
        return Response.json({ ok: true })
      })
      if (!response.ok) {
        const body = await response.json() as { error?: string }
        throw new Error(body.error ?? "Cannot change sessions while usage is unresolved.")
      }
    })
  }

  private async stopWork(): Promise<string> {
    return this.options.admissions.withLock(async () => {
      const state = await this.options.store.get()
      if (this.options.admissions.active || state.phase === "admitting") return "A message is being admitted. Retry `!stop` once startup finishes."
      if (state.queued && !state.budgetReservation && state.phase === "queued") {
        await this.options.store.patch({ queued: undefined, phase: "idle" })
        return "Stopped the queued message before dispatch."
      }
      if (!state.sessionID) return "No session mapped here yet."
      if (!isBusyPhase(state.phase) && !state.budgetReservation) return "This session is already idle."
      await this.options.withClient((client) => client.session.interrupt({ sessionID: state.sessionID!, resume: false }), false)
      await this.options.store.patch({ queued: undefined })
      await this.options.scheduler.schedule("turn:observe", Date.now() + 1000, {
        reservationID: state.budgetReservation?.reservationID,
        reservationDate: state.budgetReservation?.date,
        sessionID: state.sessionID,
        reason: "slack-stop-settlement",
      })
      return "Stop requested; queued follow-ups cleared. Usage settlement will finish before the next turn."
    })
  }

  private async buildPrompt(channel: string, ts: string, threadTs: string | undefined, text: string): Promise<string> {
    const messages = await this.fetchContext(channel, ts, threadTs)
    const context = formatSlackContext(messages, { botUserId: this.options.env().SLACK_BOT_USER_ID ?? "", excludeTs: ts })
    if (!context) return text
    return [`<slack_context channel="${channel}" source="${threadTs ? `thread ${threadTs}` : "recent channel history"}">`, context, "</slack_context>", "", "<message>", text, "</message>"].join("\n")
  }

  private async fetchContext(channel: string, ts: string, threadTs: string | undefined): Promise<SlackContextMessage[]> {
    try {
      if (threadTs) {
        const res = await this.slack("conversations.replies", { channel, ts: threadTs, limit: 60 })
        return (res.messages ?? []) as SlackContextMessage[]
      }
      const res = await this.slack("conversations.history", { channel, latest: ts, inclusive: false, limit: 20 })
      return ((res.messages ?? []) as SlackContextMessage[]).reverse()
    } catch {
      return []
    }
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message
    try { return JSON.stringify(error) } catch { return String(error) }
  }
}

function button(label: string, style: "primary" | "danger" | undefined, actionID: string, key: string, requestID: string, channel: string): Record<string, unknown> {
  return {
    type: "button",
    text: { type: "plain_text", text: label },
    ...(style ? { style } : {}),
    action_id: actionID,
    value: JSON.stringify({ key, requestID, channel }),
  }
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)) }
