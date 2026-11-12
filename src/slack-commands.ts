import { mrkdwnEscape } from "./adapters/slack"
import {
  cleanArg,
  formatModelList,
  formatSessionList,
  modelRef,
  modelSuggestions,
  parseSlackCommand,
  resolveSessionChoice,
  type ModelSummary,
  type SessionSummary,
} from "./slack-command-format"
import {
  answerHint,
  describeAnswer,
  describeForm,
  parseFormAnswer,
  visibleFields,
  type Form,
  type FormAnswer,
} from "./slack-forms"

export interface SlackCommandServices {
  getState(): Promise<{
    sessionID?: string
    phase?: string
    modelOverride?: string
    lastTurnError?: string
    settlementError?: string
    queued?: unknown
  }>
  getDefaultModel(): Promise<string>
  getModels(): Promise<ModelSummary[]>
  getSession(id: string): Promise<SessionSummary & { parentID?: string; location?: { directory?: string } }>
  listSessions(): Promise<Array<SessionSummary & { parentID?: string; location?: { directory?: string } }>>
  switchModel(ref: string): Promise<void>
  selectSession(id: string): Promise<void>
  newSession(): Promise<void>
  stop(): Promise<string>
  leave(): Promise<string>
  listForms(sessionID: string): Promise<Form[]>
  answerForm(sessionID: string, formID: string, answer: FormAnswer): Promise<void>
  cancelForm(sessionID: string, formID: string): Promise<void>
  usageText(): Promise<string>
  reply(text: string): Promise<void>
  setupUrl: string
}

const SESSION_DIRECTORY = "/workspace"
const SESSION_LIMIT = 10

const HELP = [
  "*OpenCode commands*",
  "• Mention me to start a session; mention me in a thread to engage it before its follow-up replies. DMs are one continuous session.",
  "• `!help` — show commands",
  "• `!status` — show this conversation's session and pending work",
  "• `!model` — list enabled models; `!model provider/model#variant` switches this conversation",
  "• `!sessions` — list recent sessions; `!session 2` or an id switches to one",
  "• `!answer` — show the waiting question; `!answer <value>` answers it",
  "• `!cancel` — dismiss the waiting question",
  "• `!stop` — interrupt the running session",
  "• `!new` — start a fresh session",
  "• `!leave` — detach this thread; in DMs, use `!new` for a fresh session",
  "• `!usage` — show usage information",
  "• `!setup` / `!connect` — open account setup",
].join("\n")

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function currentDirectorySession<T extends { parentID?: string; location?: { directory?: string } }>(session: T): boolean {
  return !session.parentID && session.location?.directory === SESSION_DIRECTORY
}

function sortSessions<T extends SessionSummary>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => {
    const updatedA = a.time?.updated ?? 0
    const updatedB = b.time?.updated ?? 0
    return updatedB - updatedA || a.id.localeCompare(b.id)
  })
}

function parseModelRef(ref: string): { providerID: string; id: string; variant?: string } | undefined {
  const match = ref.match(/^([^/#\s]+)\/([^#\s]+)(?:#([^#\s]+))?$/)
  if (!match?.[1] || !match[2]) return undefined
  return { providerID: match[1], id: match[2], ...(match[3] ? { variant: match[3] } : {}) }
}

function setupGuidance(): string {
  return " Run `!setup` to check provider connections and model access."
}

function isQuotaRelated(error: unknown): boolean {
  return /quota|billing|credit|budget|provider.{0,20}(key|connect|access)|model.{0,20}(unavailable|catalogue)/i.test(errorMessage(error))
}

function usableModels(models: ModelSummary[]): ModelSummary[] {
  const hasTypes = models.some((model) => model.type !== undefined)
  return models.filter((model) =>
    model.enabled !== false && model.status !== "deprecated" && model.status !== "unavailable" &&
    (!hasTypes || model.type === "chat"),
  )
}

function pendingForm(forms: Form[]): Form | undefined {
  return forms[0]
}

/** Handle a leading Slack command. All bang tokens are consumed, including unknown ones. */
export async function handleSlackCommand(text: string, services: SlackCommandServices): Promise<boolean> {
  const command = parseSlackCommand(text)
  if (!command) return false
  const { name, args } = command

  const reply = (message: string) => services.reply(message)
  try {
    if (name === "help") {
      await reply(HELP)
      return true
    }
    if (name === "setup" || name === "connect") {
      let setupLink = services.setupUrl
      try {
        const safeUrl = new URL(services.setupUrl)
        safeUrl.search = ""
        safeUrl.hash = ""
        setupLink = safeUrl.toString()
      } catch {
        // Keep the supplied setup location visible if a deployment uses a relative URL.
        setupLink = services.setupUrl.split(/[?#]/, 1)[0] ?? services.setupUrl
      }
      await reply(`Open account setup: ${setupLink}`)
      return true
    }
    if (name === "usage") {
      await reply(await services.usageText())
      return true
    }
    if (name === "new") {
      await services.newSession()
      await reply("🆕 Next message starts a fresh session.")
      return true
    }
    if (name === "leave") {
      await reply(await services.leave())
      return true
    }
    if (name === "stop") {
      await reply(await services.stop())
      return true
    }
    if (name === "model") {
      const state = await services.getState()
      let models: ModelSummary[]
      try {
        models = usableModels(await services.getModels())
      } catch {
        await reply(`⚠️ The enabled model catalogue is unavailable. Try \`!model\` again when OpenCode is ready.${setupGuidance()}`)
        return true
      }
      if (models.length === 0) {
        await reply(`⚠️ No enabled chat models are available, so I can't validate a model switch yet.${setupGuidance()}`)
        return true
      }
      const active = state.sessionID ? await services.getSession(state.sessionID).catch(() => undefined) : undefined
      const current = active?.model ? modelRef(active.model) : state.modelOverride || await services.getDefaultModel()
      if (!args) {
        await reply([
          current ? `Current model: \`${current}\`` : "_No model is selected yet._",
          formatModelList(models, { current }),
        ].join("\n\n"))
        return true
      }
      const cleaned = cleanArg(args)
      const parsed = parseModelRef(cleaned)
      if (!parsed) {
        await reply("Model refs look like `provider/model` or `provider/model#variant` — run `!model` to list them.")
        return true
      }
      const match = models.find((candidate) => candidate.providerID === parsed.providerID && candidate.id === parsed.id)
      if (!match) {
        const suggestions = modelSuggestions(models, cleaned.split("#", 1)[0] ?? cleaned)
        await reply([
          `⚠️ \`${cleaned}\` is not an enabled chat model here.`,
          suggestions.length ? `Did you mean ${suggestions.map((item) => `\`${item}\``).join(", ")}?` : "Run `!model` to list available models.",
        ].join("\n"))
        return true
      }
      await services.switchModel(`${parsed.providerID}/${parsed.id}${parsed.variant ? `#${parsed.variant}` : ""}`)
      await reply(`🧠 This conversation now uses \`${cleaned}\`.`)
      return true
    }
    if (name === "sessions" || name === "session") {
      const allSessions = sortSessions((await services.listSessions()).filter(currentDirectorySession))
      if (!args) {
        await reply(formatSessionList(allSessions, { limit: SESSION_LIMIT, current: (await services.getState()).sessionID }))
        return true
      }
      const sessions = allSessions.slice(0, SESSION_LIMIT)
      const arg = cleanArg(args.split(/\s+/, 1)[0] ?? "")
      const choice = resolveSessionChoice(sessions, arg)
      let target = choice.kind === "session" ? choice.session : undefined
      // Older full/prefix ids may not appear in the ten-row page. Verify details before adoption.
      if (!target && !/^\d+$/.test(arg) && arg.length > 0) {
        const listedMatches = (await services.listSessions()).filter(currentDirectorySession).filter((session) => session.id.startsWith(arg))
        if (listedMatches.length === 1) target = listedMatches[0]
        else if (listedMatches.length === 0 && arg.startsWith("ses_")) {
          const detail = await services.getSession(arg).catch(() => undefined)
          if (detail && detail.id === arg && currentDirectorySession(detail)) target = detail
        }
      }
      if (!target) {
        await reply(choice.kind === "error" && !arg.startsWith("ses_") ? choice.message : `No session matches \`${arg}\` in /workspace.`)
        return true
      }
      // Recheck even list-provided entries before passing a selection to the lifecycle callback.
      const detail = await services.getSession(target.id)
      if (detail.id !== target.id || !currentDirectorySession(detail)) {
        await reply(`No session matches \`${arg}\` in /workspace.`)
        return true
      }
      await services.selectSession(detail.id)
      await reply(`🔗 This conversation now continues \`${detail.id}\`${detail.title ? ` — *${mrkdwnEscape(detail.title)}*` : ""}.`)
      return true
    }
    if (name === "status") {
      const state = await services.getState()
      const model = state.modelOverride || await services.getDefaultModel().catch(() => undefined)
      const lines = [
        state.sessionID ? `Session \`${state.sessionID}\`` : "No session mapped here yet.",
        `Phase: ${state.phase ?? "idle"}`,
        ...(model ? [`Model: \`${model}\``] : []),
      ]
      if (state.queued) lines.push("⏳ A message is queued.")
      if (state.lastTurnError) lines.push(`⚠️ Last turn error: ${state.lastTurnError}`)
      if (state.settlementError) lines.push(`⚠️ Settlement error: ${state.settlementError}`)
      if (!state.sessionID) {
        await reply(lines.join("\n"))
        return true
      }
      const [session, forms] = await Promise.all([
        services.getSession(state.sessionID),
        services.listForms(state.sessionID).catch(() => []),
      ])
      const title = session.title ? ` — *${mrkdwnEscape(session.title)}*` : ""
      lines[0] = `Session \`${state.sessionID}\`${title}`
      lines.splice(1, 0, "Directory: `/workspace`")
      if (session.model) {
        const modelLine = lines.findIndex((line) => line.startsWith("Model: "))
        const shownModel = `Model: \`${modelRef(session.model)}\``
        if (modelLine >= 0) lines[modelLine] = shownModel
        else lines.splice(2, 0, shownModel)
      }
      if (forms.length) lines.push(`Pending question${forms.length === 1 ? "" : `s (${forms.length})`}: use \`!answer\` or \`!cancel\`.`)
      await reply(lines.join("\n"))
      return true
    }
    if (name === "answer" || name === "cancel") {
      const state = await services.getState()
      if (!state.sessionID) {
        await reply("No session here yet — send a message first.")
        return true
      }
      const form = pendingForm(await services.listForms(state.sessionID))
      if (!form) {
        await reply(name === "answer" ? "No question is waiting for an answer." : "No question is waiting to be cancelled.")
        return true
      }
      if (name === "cancel") {
        await services.cancelForm(state.sessionID, form.id)
        await reply(`🚫 Cancelled — *${mrkdwnEscape(form.title)}*.`)
        return true
      }
      if (!args) {
        await reply(`${describeForm(form)}\n${answerHint(form)}`)
        return true
      }
      const parsed = parseFormAnswer(form, args)
      if (!parsed.ok) {
        await reply(`⚠️ ${parsed.error}`)
        return true
      }
      await services.answerForm(state.sessionID, form.id, parsed.answer)
      const summary = describeAnswer(parsed.answer, visibleFields(form))
      await reply(`✅ Answered${summary ? ` — ${summary}` : ""}.`)
      return true
    }
    await reply(`I don't know \`!${name}\`. Try \`!help\` to see the available commands.`)
    return true
  } catch (error) {
    await reply(`⚠️ Couldn't run \`!${name}\`: ${errorMessage(error)}${isQuotaRelated(error) ? setupGuidance() : ""}`)
    return true
  }
}
