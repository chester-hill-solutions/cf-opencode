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
import type { MemoryEntry, MemoryScope } from "./memory"
import type { TurnObservation } from "./turn-observation"
import { parseWorkspaceRepositoryBinding } from "./workspace-repository"
import { handleSlackWorkspaceCommand, readSlackWorkspaceProfile, type SlackWorkspaceCommandServices } from "./slack-workspace-commands"

export interface SlackCommandServices {
  getState(): Promise<{
    sessionID?: string
    phase?: string
    modelOverride?: string
    lastTurnError?: string
    settlementError?: string
    workspaceRepository?: unknown
    queue?: Array<{ id?: string; text: string; enqueuedAt?: number }>
    turnObservation?: TurnObservation
  }>
  /**
   * Whether a code runtime is already warm. Commands must read this rather than
   * call a runtime-backed service to find out: asking is free, starting is not.
   */
  runtime(): { warm: boolean }
  getDefaultModel(): Promise<string>
  getModels(): Promise<ModelSummary[]>
  getSession(id: string): Promise<SessionSummary & { parentID?: string; location?: { directory?: string } }>
  listSessions(): Promise<Array<SessionSummary & { parentID?: string; location?: { directory?: string } }>>
  switchModel(ref: string): Promise<void>
  selectSession(id: string): Promise<void>
  newSession(): Promise<void>
  steer(text: string): Promise<string>
  stop(followUp?: string): Promise<string>
  leave(): Promise<string>
  listForms(sessionID: string): Promise<Form[]>
  answerForm(sessionID: string, formID: string, answer: FormAnswer): Promise<void>
  cancelForm(sessionID: string, formID: string): Promise<void>
  usageText(): Promise<string>
  /** Team and user memory; absent when the harness has no store wired. */
  memory?: {
    context(): Promise<{ team: MemoryEntry[]; user: MemoryEntry[] }>
    remember(scope: MemoryScope, text: string): Promise<MemoryResult>
    forget(scope: MemoryScope, index: number): Promise<MemoryResult>
  }
  reply(text: string): Promise<void>
  setupUrl: string
  workspace?: SlackWorkspaceCommandServices
}

type Reply = (message: string) => Promise<void>
type CommandHandler = (name: string, args: string, services: SlackCommandServices, reply: Reply) => Promise<void>
type ConversationState = Awaited<ReturnType<SlackCommandServices["getState"]>>
type MemoryResult = { ok: true; entry: MemoryEntry } | { ok: false; error: string }
type SessionDetail = Awaited<ReturnType<SlackCommandServices["getSession"]>>

const SESSION_DIRECTORY = "/workspace"
const SESSION_LIMIT = 10

const HELP = [
  "*OpenCode commands*",
  "• Mention me to start a session; mention me in a thread to engage it before its follow-up replies. DMs are one continuous session.",
  "• `!help` — show commands",
  "• `!status` — show this conversation's session and pending work",
  "• Messages without a command queue while a turn is active.",
  "• `!model` — list enabled models; `!model provider/model#variant` switches this conversation",
  "• `!sessions` — list recent sessions; `!session 2` or an id switches to one",
  "• `!answer` — show the waiting question; `!answer <value>` answers it",
  "• `!cancel` — dismiss the waiting question",
  "• `!steer <text>` — add guidance to the active turn",
  "• `!stop` — interrupt the active turn and clear queued follow-ups",
  "• `!stop <text>` — interrupt and use the text as the follow-up message",
  "• `!new` — start a fresh session",
  "• `!leave` — detach this thread; in DMs, use `!new` for a fresh session",
  "• `!usage` — show usage information",
  "• `!remember <text>` — keep a note about you; `!remember team <text>` keeps it for everyone",
  "• `!memory` — list what is remembered; `!forget [team] <n>` removes one entry",
  "• Workspace first — durable projects, scripts, analysis, documents and prototypes may start blank and remain repository-free permanently. Keeping work requires no git initialization, commit or remote.",
  "• `!workspace` — show retention and name; persistent is the default",
  "• `!workspace persistent [name]` / `!workspace disposable [name]` — name or change retention in place; files and session are preserved",
  "• `!workspace discard` — explicitly discard a disposable workspace. Disposable work keeps recovery checkpoints until then; finish/idle never auto-discards it.",
  "• A repository is optional. If requested, use a public checkout in a new subfolder and carry over chosen files, preserving originals and checking conflicts.",
  "• `!repo [GitHub URL base working]` — inspect this workspace, or register an optional root repository before work starts",
  "• `!check` / `!check [\"bun\",\"test\",...]` — request isolated checks on a registered root's committed snapshot; nested agent checkouts are not eligible",
  "• `!checks` — inspect this thread's check requests and results",
  "• `!setup` / `!connect` — open account setup",
  "• Images — one PNG or JPEG up to 5 MiB; the selected model must support images. If the bot is busy, resend when it is ready.",
].join("\n")

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function boundedSlackText(text: string, limit: number): string {
  return mrkdwnEscape(text.slice(0, limit)).replace(/[`*_~|]/g, (char) => {
    switch (char) {
      case "`": return "ˋ"
      case "*": return "＊"
      case "_": return "＿"
      case "~": return "～"
      case "|": return "｜"
      default: return char
    }
  })
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

/** Commands whose work only a code runtime can do answer with this, never a start. */
function runtimeRequired(action: string): string {
  return `⚠️ ${action} needs the code runtime, and none is running here. ` +
    "This conversation keeps its state, queue and commands without one. " +
    "Send a message that starts code work, then run the command again."
}

function runtimeLine(warm: boolean): string {
  return warm
    ? "Runtime: warm (code execution is available here)."
    : "Runtime: cold (harness mode) — state, queue and usage are answered without one; code work starts the runtime."
}

function modelLine(model: string | undefined): string {
  return model ? `Current model: \`${model}\`` : "_No model is selected yet._"
}

async function savedModel(services: SlackCommandServices): Promise<string | undefined> {
  return services.getDefaultModel().catch(() => undefined)
}

async function replyHelp(_name: string, _args: string, _services: SlackCommandServices, reply: Reply): Promise<void> {
  await reply(HELP)
}

async function replySetup(_name: string, _args: string, services: SlackCommandServices, reply: Reply): Promise<void> {
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
}

async function replyUsage(_name: string, _args: string, services: SlackCommandServices, reply: Reply): Promise<void> {
  await reply(await services.usageText())
}

async function replyLeave(_name: string, _args: string, services: SlackCommandServices, reply: Reply): Promise<void> {
  await reply(await services.leave())
}

async function replyNew(_name: string, _args: string, services: SlackCommandServices, reply: Reply): Promise<void> {
  // Closing an existing session replays its usage through the runtime first.
  if ((await services.getState()).sessionID && !services.runtime().warm) {
    await reply(runtimeRequired("Starting a fresh session while one is mapped"))
    return
  }
  await services.newSession()
  await reply("🆕 Next message starts a fresh session.")
}

async function replySteer(_name: string, args: string, services: SlackCommandServices, reply: Reply): Promise<void> {
  const guidance = args.trim()
  if (!guidance) {
    await reply("Use `!steer <text>` to add guidance to the active turn.")
    return
  }
  if (!services.runtime().warm) {
    await reply(runtimeRequired("Steering a running turn"))
    return
  }
  await reply(await services.steer(guidance))
}

async function replyStop(_name: string, args: string, services: SlackCommandServices, reply: Reply): Promise<void> {
  const followUp = args.trim()
  await reply(await (followUp ? services.stop(followUp) : services.stop()))
}

async function replyWorkspace(name: string, args: string, services: SlackCommandServices, reply: Reply): Promise<void> {
  try {
    await reply(await handleSlackWorkspaceCommand(name, args, services.workspace) ?? "Workspace control unavailable.")
  } catch {
    await reply("Workspace control could not be completed. Use `!workspace`, `!repo` or `!checks` to inspect retained state before retrying.")
  }
}

/** The model this conversation would use: the session's own, else the override, else the global default. */
async function activeModel(state: ConversationState, services: SlackCommandServices): Promise<string | undefined> {
  if (state.sessionID) {
    const active = await services.getSession(state.sessionID).catch(() => undefined)
    if (active?.model) return modelRef(active.model)
  }
  const saved = state.modelOverride
  return saved ? saved : savedModel(services)
}

async function replyModel(_name: string, args: string, services: SlackCommandServices, reply: Reply): Promise<void> {
  const state = await services.getState()
  if (!services.runtime().warm) {
    const current = state.modelOverride || await savedModel(services)
    await reply([modelLine(current), runtimeRequired("Listing enabled models and switching to one")].join("\n\n"))
    return
  }
  let models: ModelSummary[]
  try {
    models = usableModels(await services.getModels())
  } catch {
    await reply(`⚠️ The enabled model catalogue is unavailable. Try \`!model\` again when OpenCode is ready.${setupGuidance()}`)
    return
  }
  if (models.length === 0) {
    await reply(`⚠️ No enabled chat models are available, so I can't validate a model switch yet.${setupGuidance()}`)
    return
  }
  const current = await activeModel(state, services)
  if (!args) {
    await reply([modelLine(current), formatModelList(models, { current })].join("\n\n"))
    return
  }
  await switchModel(args, models, services, reply)
}

async function switchModel(args: string, models: ModelSummary[], services: SlackCommandServices, reply: Reply): Promise<void> {
  const cleaned = cleanArg(args)
  const parsed = parseModelRef(cleaned)
  if (!parsed) {
    await reply("Model refs look like `provider/model` or `provider/model#variant` — run `!model` to list them.")
    return
  }
  const match = models.find((candidate) => candidate.providerID === parsed.providerID && candidate.id === parsed.id)
  if (!match) {
    const suggestions = modelSuggestions(models, cleaned.split("#", 1)[0] ?? cleaned)
    await reply([
      `⚠️ \`${cleaned}\` is not an enabled chat model here.`,
      suggestions.length ? `Did you mean ${suggestions.map((item) => `\`${item}\``).join(", ")}?` : "Run `!model` to list available models.",
    ].join("\n"))
    return
  }
  await services.switchModel(`${parsed.providerID}/${parsed.id}${parsed.variant ? `#${parsed.variant}` : ""}`)
  await reply(`🧠 This conversation now uses \`${cleaned}\`.`)
}

async function replySessions(_name: string, args: string, services: SlackCommandServices, reply: Reply): Promise<void> {
  if (!services.runtime().warm) {
    await reply(runtimeRequired(args ? "Inspecting another session" : "Listing sessions"))
    return
  }
  const allSessions = sortSessions((await services.listSessions()).filter(currentDirectorySession))
  if (!args) {
    await reply(formatSessionList(allSessions, { limit: SESSION_LIMIT, current: (await services.getState()).sessionID }))
    return
  }
  await selectSession(args, allSessions, services, reply)
}

/** A page choice, a full/prefix id from the full list, or an exact session verified by the runtime. */
async function resolveSessionTarget(
  arg: string,
  choice: ReturnType<typeof resolveSessionChoice>,
  allSessions: Array<SessionSummary & { parentID?: string; location?: { directory?: string } }>,
  services: SlackCommandServices,
): Promise<SessionDetail | undefined> {
  if (choice.kind === "session") return choice.session
  if (arg.length === 0 || /^\d+$/.test(arg)) return undefined
  const listedMatches = allSessions.filter((session) => session.id.startsWith(arg))
  if (listedMatches.length === 1) return listedMatches[0]
  if (listedMatches.length > 0 || !arg.startsWith("ses_")) return undefined
  const detail = await services.getSession(arg).catch(() => undefined)
  return detail && detail.id === arg && currentDirectorySession(detail) ? detail : undefined
}

async function selectSession(
  args: string,
  allSessions: Array<SessionSummary & { parentID?: string; location?: { directory?: string } }>,
  services: SlackCommandServices,
  reply: Reply,
): Promise<void> {
  const arg = cleanArg(args.split(/\s+/, 1)[0] ?? "")
  const choice = resolveSessionChoice(allSessions.slice(0, SESSION_LIMIT), arg)
  const target = await resolveSessionTarget(arg, choice, allSessions, services)
  if (!target) {
    await reply(choice.kind === "error" && !arg.startsWith("ses_") ? choice.message : `No session matches \`${arg}\` in /workspace.`)
    return
  }
  // Recheck even list-provided entries before passing a selection to the lifecycle callback.
  const detail = await services.getSession(target.id)
  if (detail.id !== target.id || !currentDirectorySession(detail)) {
    await reply(`No session matches \`${arg}\` in /workspace.`)
    return
  }
  await services.selectSession(detail.id)
  await reply(`🔗 This conversation now continues \`${detail.id}\`${detail.title ? ` — *${mrkdwnEscape(detail.title)}*` : ""}.`)
}

function workspaceLines(state: ConversationState): string {
  if (state.workspaceRepository === undefined) return "Workspace: general; a repository is optional."
  try {
    const binding = parseWorkspaceRepositoryBinding(state.workspaceRepository)
    return `Registered root (${binding.status}): ${mrkdwnEscape(binding.repository)}`
  } catch {
    return "Root repository status is unavailable; inspect it with `!repo`."
  }
}

async function retentionLines(services: SlackCommandServices): Promise<string[]> {
  if (!services.workspace?.workspace) return []
  try {
    const profile = await readSlackWorkspaceProfile(services.workspace.workspace)
    return [`Retention: ${profile.retention}${profile.name ? ` — ${mrkdwnEscape(profile.name)}` : ""}${profile.status === "discarding" ? " (discard pending)" : ""}.`]
  } catch {
    return ["Workspace retention status is unavailable; inspect `!workspace` before making changes."]
  }
}

function queueLines(queue: NonNullable<ConversationState["queue"]>): string[] {
  if (!queue.length) return []
  const lines = [`⏳ ${queue.length} message${queue.length === 1 ? "" : "s"} queued.`]
  const head = queue[0]
  if (head) {
    const id = typeof head.id === "string" ? ` [${boundedSlackText(head.id, 80)}]` : ""
    const queueText = typeof head.text === "string" ? head.text : "(message text unavailable)"
    const boundedText = queueText.length > 180 ? `${queueText.slice(0, 177)}…` : queueText
    lines.push(`Next: ${boundedSlackText(boundedText, 180)}${id}`)
  }
  return lines
}

function problemLines(state: ConversationState): string[] {
  const lines: string[] = []
  const observation = state.turnObservation
  if (observation?.overdue) {
    const minutes = Math.round(observation.thresholdMs / 60_000)
    lines.push(`⚠️ Turn exceeded the ${minutes}-minute observation threshold. This reports elapsed time only; execution is not automatically stopped.`)
  }
  if (state.lastTurnError) lines.push(`⚠️ Last turn error: ${state.lastTurnError}`)
  if (state.settlementError) lines.push(`⚠️ Settlement error: ${state.settlementError}`)
  return lines
}

/** Add the runtime's own view of the session to lines that were already built from state. */
function describeSession(lines: string[], sessionID: string, session: SessionDetail, forms: Form[]): void {
  const title = session.title ? ` — *${mrkdwnEscape(session.title)}*` : ""
  lines[0] = `Session \`${sessionID}\`${title}`
  lines.splice(1, 0, "Directory: `/workspace`")
  if (session.model) {
    const modelAtIndex = lines.findIndex((line) => line.startsWith("Model: "))
    const shown = `Model: \`${modelRef(session.model)}\``
    if (modelAtIndex >= 0) lines[modelAtIndex] = shown
    else lines.splice(2, 0, shown)
  }
  if (forms.length) lines.push(`Pending question${forms.length === 1 ? "" : `s (${forms.length})`}: use \`!answer\` or \`!cancel\`.`)
}

async function replyStatus(_name: string, _args: string, services: SlackCommandServices, reply: Reply): Promise<void> {
  const state = await services.getState()
  const warm = services.runtime().warm
  const model = state.modelOverride || await savedModel(services)
  const lines = [
    state.sessionID ? `Session \`${state.sessionID}\`` : "No session mapped here yet.",
    `Phase: ${state.phase ?? "idle"}`,
    runtimeLine(warm),
    workspaceLines(state),
    ...await retentionLines(services),
    ...(model ? [`Model: \`${model}\``] : []),
    ...queueLines(state.queue ?? []),
    ...problemLines(state),
  ]
  if (!state.sessionID || !warm) {
    if (state.sessionID) lines.push("Session title and pending questions live in the code runtime; they are not shown while it is cold.")
    await reply(lines.join("\n"))
    return
  }
  const [session, forms] = await Promise.all([
    services.getSession(state.sessionID).catch(() => undefined),
    services.listForms(state.sessionID).catch(() => []),
  ])
  if (!session) {
    lines.push("The runtime stopped before its session details could be read; `!status` is still answering from saved state.")
    await reply(lines.join("\n"))
    return
  }
  describeSession(lines, state.sessionID, session, forms)
  await reply(lines.join("\n"))
}

async function replyRemember(_name: string, args: string, services: SlackCommandServices, reply: Reply): Promise<void> {
  const memory = await requireMemory(services, reply)
  if (!memory) return
  const { scope, text } = rememberScope(args)
  if (!text) {
    await reply("Use `!remember <something>` or `!remember team <something>`.")
    return
  }
  const result = await memory.remember(scope, text)
  if (!result.ok) {
    await reply(`⚠️ ${result.error}`)
    return
  }
  await reply(scope === "team" ? `🧠 Remembered for the team: ${result.entry.text}` : `🧠 Noted: ${result.entry.text}`)
}

/** Memory or an honest refusal; every memory command shares this guard. */
async function requireMemory(services: SlackCommandServices, reply: Reply): Promise<NonNullable<SlackCommandServices["memory"]> | undefined> {
  const memory = services.memory
  if (!memory) await reply("Memory is unavailable here.")
  return memory
}

/** "team" is the only scope keyword; everything else is a personal note. */
function rememberScope(args: string): { scope: MemoryScope; text: string } {
  const match = /^team\s+([\s\S]+)$/i.exec(args.trim())
  return match?.[1] ? { scope: "team", text: match[1] } : { scope: "user", text: args.trim() }
}

async function replyMemory(_name: string, _args: string, services: SlackCommandServices, reply: Reply): Promise<void> {
  const memory = await requireMemory(services, reply)
  if (!memory) return
  const { team, user } = await memory.context()
  const lines = ["*Memory*"]
  if (!team.length && !user.length) lines.push("Nothing is remembered yet.")
  lines.push(memorySection("Team", team), memorySection("You", user))
  lines.push("`!remember <text>` adds a note; `!remember team <text>` shares it. `!forget <n>` removes one.")
  await reply(lines.filter((line) => line.length > 0).join("\n"))
}

function memorySection(title: string, entries: MemoryEntry[]): string {
  if (!entries.length) return ""
  return [`\n*${title}*`, ...entries.map((entry, index) => `${index + 1}. ${entry.text}`)].join("\n")
}

async function replyForget(_name: string, args: string, services: SlackCommandServices, reply: Reply): Promise<void> {
  const memory = await requireMemory(services, reply)
  if (!memory) return
  const target = forgetTarget(args)
  if (!target) {
    await reply("Use `!forget <n>` or `!forget team <n>`, where n is the number `!memory` shows.")
    return
  }
  const result = await memory.forget(target.scope, target.index)
  await reply(result.ok ? `🧽 Forgot: ${result.entry.text}` : `⚠️ ${result.error}`)
}

function forgetTarget(args: string): { scope: MemoryScope; index: number } | undefined {
  const match = /^(?:(team)\s+)?(\d{1,3})$/i.exec(args.trim())
  const index = Number(match?.[2])
  if (!match?.[2] || !Number.isSafeInteger(index) || index < 1) return undefined
  return { scope: match[1] ? "team" : "user", index }
}

async function replyForm(name: string, args: string, services: SlackCommandServices, reply: Reply): Promise<void> {
  const state = await services.getState()
  if (!state.sessionID) {
    await reply("No session here yet — send a message first.")
    return
  }
  if (!services.runtime().warm) {
    await reply(runtimeRequired("Reading and answering the waiting question"))
    return
  }
  const form = pendingForm(await services.listForms(state.sessionID))
  if (!form) {
    await reply(name === "answer" ? "No question is waiting for an answer." : "No question is waiting to be cancelled.")
    return
  }
  if (name === "cancel") {
    await services.cancelForm(state.sessionID, form.id)
    await reply(`🚫 Cancelled — *${mrkdwnEscape(form.title)}*.`)
    return
  }
  if (!args) {
    await reply(`${describeForm(form)}\n${answerHint(form)}`)
    return
  }
  const parsed = parseFormAnswer(form, args)
  if (!parsed.ok) {
    await reply(`⚠️ ${parsed.error}`)
    return
  }
  await services.answerForm(state.sessionID, form.id, parsed.answer)
  const summary = describeAnswer(parsed.answer, visibleFields(form))
  await reply(`✅ Answered${summary ? ` — ${summary}` : ""}.`)
}

const COMMANDS: Record<string, CommandHandler> = {
  help: replyHelp,
  setup: replySetup,
  connect: replySetup,
  usage: replyUsage,
  new: replyNew,
  leave: replyLeave,
  steer: replySteer,
  stop: replyStop,
  model: replyModel,
  sessions: replySessions,
  session: replySessions,
  status: replyStatus,
  answer: replyForm,
  cancel: replyForm,
  remember: replyRemember,
  memory: replyMemory,
  forget: replyForget,
  workspace: replyWorkspace,
  repo: replyWorkspace,
  check: replyWorkspace,
  checks: replyWorkspace,
}

/** Handle a leading Slack command. All bang tokens are consumed, including unknown ones. */
export async function handleSlackCommand(text: string, services: SlackCommandServices): Promise<boolean> {
  const command = parseSlackCommand(text)
  if (!command) return false
  const reply: Reply = (message) => services.reply(message)
  const handler = COMMANDS[command.name]
  try {
    if (handler) await handler(command.name, command.args, services, reply)
    else await reply(`I don't know \`!${command.name}\`. Try \`!help\` to see the available commands.`)
  } catch (error) {
    const setup = isQuotaRelated(error) ? setupGuidance() : ""
    await reply(`⚠️ Couldn't run \`!${command.name}\`: ${errorMessage(error)}${setup}`)
  }
  return true
}
