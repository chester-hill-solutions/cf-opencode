import { makeClient } from "../opencode"
import type { SlackTarget, Transport } from "../state"
import type { MessageInfo } from "../messages"
import { parseModelRef } from "../env"
import { AccountingPolicyError } from "../accounting-policy"
import type { HarnessSettings } from "../settings"
import type { ConversationStore } from "../state"
import type { ConversationRuntime } from "./runtime"
import type { ConversationLease } from "./lease"
import type { ConversationUsage } from "./usage"
import { logEvent } from "../log"

type OpenCodeClient = ReturnType<typeof makeClient>

export interface ConversationSessionsOptions {
  store: ConversationStore
  runtime: Pick<ConversationRuntime, "eventPersistence" | "generation" | "eventPersistenceGeneration">
  upgrades: { hasPending(): Promise<boolean> }
  prepare(): Promise<unknown>
  leases: Pick<ConversationLease, "ensureHeld">
  usage: Pick<ConversationUsage, "refresh">
  settings(): Promise<HarnessSettings>
  withClient<T>(fn: (client: OpenCodeClient) => Promise<T>, recoverOnRejection?: boolean): Promise<T>
}

/** Session creation, validation, and per-turn context boundaries. */
export class ConversationSessions {
  constructor(private readonly options: ConversationSessionsOptions) {}

  async ensure(text: string, transport: Transport, slack?: SlackTarget): Promise<string> {
    if (await this.options.upgrades.hasPending()) {
      throw new Error("runtime upgrade is pending; an operator must resume it before a session can change")
    }
    await this.options.prepare()
    await this.options.leases.ensureHeld()
    if (this.options.runtime.eventPersistence !== true || !this.options.runtime.generation ||
      this.options.runtime.eventPersistenceGeneration !== this.options.runtime.generation) {
      throw new AccountingPolicyError("runtime cannot retain usage events; upgrade pending")
    }
    const state = await this.options.store.get()
    if (state.sessionID && await this.usable(state.sessionID)) {
      // Drain durable events before admission. Foreground policy disables
      // title generation and background compaction after the terminal fence.
      await this.options.usage.refresh(state.sessionID)
      const override = parseModelRef(state.modelOverride ?? (await this.options.settings()).model)
      if (override) {
        await this.options.withClient((client) => client.session.switchModel({ sessionID: state.sessionID!, model: override }))
      }
      if (slack && (state.slack?.channel !== slack.channel || state.slack?.replyTs !== slack.replyTs)) {
        await this.options.store.patch({ slack })
      }
      return state.sessionID
    }
    if (state.sessionID) {
      // Keep the old mapping until its replacement exists, so a transient
      // failure cannot erase a session that might still be present.
      logEvent("session.stale", { sessionID: state.sessionID })
    }

    const session = await this.options.withClient((client) => client.session.create({
      location: { directory: "/workspace" },
      title: text.replace(/\s+/g, " ").slice(0, 80),
    }))
    const sessionID = (session as { id?: string }).id
    if (!sessionID) throw new Error("session.create returned no id")

    const settings = await this.options.settings()
    const model = parseModelRef(state.modelOverride ?? settings.model)
    if (model) await this.options.withClient((client) => client.session.switchModel({ sessionID, model }))
    await this.options.store.patch({
      sessionID,
      transport,
      ...(slack ? { slack } : {}),
      ...(state.sessionID ? {
        pending: {},
        announcedForms: [],
        turnBaseline: undefined,
        lastReply: undefined,
        lastSlackReply: undefined,
        reportedError: undefined,
        usage: undefined,
        usageAux: undefined,
        usageCursor: undefined,
        usageTerminal: undefined,
        usageExecution: undefined,
        usageError: undefined,
      } : {}),
    })
    return sessionID
  }

  async usable(sessionID: string): Promise<boolean> {
    try {
      return await this.options.withClient(async (client) => {
        try {
          await client.session.get({ sessionID })
          return true
        } catch {
          // A missing session is expected and should not trip the runtime breaker.
          return false
        }
      })
    } catch {
      return false
    }
  }

  /** Last assistant id before prompt dispatch; everything after it belongs to this turn. */
  async baseline(sessionID: string): Promise<string | undefined> {
    const messages = await this.options.withClient((client) => client.session.context({ sessionID })) as MessageInfo[]
    if (!Array.isArray(messages)) throw new Error("session context is unreadable while establishing turn baseline")
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]
      if (message?.type === "assistant" && message.id) return message.id
    }
    return undefined
  }
}

