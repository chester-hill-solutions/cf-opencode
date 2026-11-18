import { parseWorkspaceProfile, parseWorkspaceDiscardRecord, WORKSPACE_UUID, type WorkspaceProfile } from "./workspace-profile"
import { mrkdwnEscape } from "./adapters/slack"
import { parseWorkspaceCheckArgv } from "./workspace-check"
import { parseWorkspaceRepositoryBinding, parseWorkspaceRepositorySelection } from "./workspace-repository"

/** Callbacks delegate to the same guarded services as the authenticated HTTP API. */
export interface SlackWorkspaceCommandServices {
  workspace?(request: Request): Promise<Response>
  discardRequestID?(): Promise<string>
  repository(request: Request): Promise<Response>
  check(argv: string[]): Promise<string>
  checks(): Promise<string>
}

const REPO_USAGE = "To register an optional root repository before work starts, use `!repo https://github.com/owner/repo main aboiteau/task-123`. Use `!repo` to inspect this workspace."
const CARRY_WORK = "You can explicitly ask me to check out a repository in a new subfolder, copy only chosen files, preserve originals, exclude workspace/runtime metadata, and ask before overwriting conflicts. A private repository needs its root binding (`!repo`), because my own Git commands carry no credential. That checkout does not change the registered root repository or make the subfolder eligible for `!check`."

/** Slack escapes these three entities. Decode once, never reinterpret recursively. */
export function decodeSlackCommandEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt);/g, entity => entity === "&amp;" ? "&" : entity === "&lt;" ? "<" : ">")
}

export async function handleSlackWorkspaceCommand(name: string, rawArgs: string, services: SlackWorkspaceCommandServices | undefined): Promise<string | undefined> {
  if (!["workspace", "repo", "check", "checks"].includes(name)) return undefined
  if (!services) return "Workspace controls are unavailable here. No repository, check or prompt was started."
  if (name === "workspace") return workspaceControl(rawArgs, services)
  if (name === "checks") {
    if (rawArgs.trim()) return "Use `!checks` to inspect this thread's checks."
    return services.checks()
  }
  if (name === "check") {
    let argv: string[]
    try {
      argv = rawArgs.trim() ? parseWorkspaceCheckArgv(JSON.parse(decodeSlackCommandEntities(rawArgs))) :
        ["bun", "--no-env-file", "--no-install", "test"]
    } catch { return 'Use `!check` for Bun tests, or an explicit JSON argv array such as `!check ["bun","test","test/example.test.ts"]`. No check was requested.' }
    return services.check(argv)
  }
  const args = decodeSlackCommandEntities(rawArgs).trim()
  let selection: ReturnType<typeof parseWorkspaceRepositorySelection> | undefined
  if (args && args !== "status") {
    // Slack may turn a pasted URL into <url|label>; only its URL is authoritative.
    const match = /^(<https:\/\/[^<>|\s]+(?:\|[^<>]{1,200})?>|https:\/\/[^\s<>]+)\s+([^\s<>]+)\s+([^\s<>]+)$/.exec(args)
    if (!match) return REPO_USAGE
    const repository = match[1].startsWith("<") ? match[1].slice(1, -1).split("|", 1)[0] : match[1]
    try { selection = parseWorkspaceRepositorySelection({ repository, baseBranch: match[2], workingBranch: match[3] }) }
    catch { return "Repository or branch is unsupported. Use a GitHub HTTPS URL without credentials and distinct plain branch names. " + REPO_USAGE }
  }
  const response = await services.repository(new Request("https://conversation/workspace/repository", {
    method: selection ? "PUT" : "GET", ...(selection ? { headers: { "content-type": "application/json" }, body: JSON.stringify(selection) } : {}),
  }))
  if (response.status === 409) return "Keep this workspace, preserving its files and history. An existing root selection or prior work prevents registering a new root here. " + CARRY_WORK + " This command started no checkout, copy, or model request."
  if (!response.ok) return "Repository binding is unavailable or could not be saved. No prompt or runtime was started. " + REPO_USAGE
  let binding: ReturnType<typeof parseWorkspaceRepositoryBinding> | null
  try {
    const value: unknown = await response.json()
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "workspaceRepository")) throw new Error()
    const raw = (value as Record<string, unknown>).workspaceRepository
    binding = raw === null ? null : parseWorkspaceRepositoryBinding(raw)
    if (selection && (!binding || binding.repository !== selection.repository || binding.baseBranch !== selection.baseBranch || binding.workingBranch !== selection.workingBranch)) throw new Error()
  } catch { return "Repository binding could not be verified. No prompt or runtime was started." }
  if (!binding) return "Your general workspace is ready to use; a repository is optional. Ask me to create or edit files here. " + CARRY_WORK + " " + REPO_USAGE
  return [
    `Repository: ${binding.repository}`,
    `Base: \`${mrkdwnEscape(binding.baseBranch)}\`; working branch: \`${mrkdwnEscape(binding.workingBranch)}\`.`,
    binding.status === "pending" ? "Selection saved. The first normal message will attempt checkout and start the agent; this command started no runtime or provider." :
      `Binding is materialized at original base \`${binding.baseCommit}\`. This does not establish that checks passed.`,
  ].join("\n")
}


const WORKSPACE_USAGE = "Use `!workspace` for status, `!workspace persistent [name]` to keep work, `!workspace disposable [name]` for an explicitly disposable workspace, or `!workspace discard` to discard a disposable workspace."
function envelope(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workspace status unavailable")
  return value as Record<string, unknown>
}
export function describeWorkspaceProfile(profile: WorkspaceProfile): string {
  return [
    profile.name ? `Workspace: ${mrkdwnEscape(profile.name)}` : "Workspace: unnamed",
    `Retention: ${profile.retention}${profile.retention === "persistent" ? " (the default)" : ""}.`,
    profile.status === "discarding" ? "An explicit discard is pending; cleanup is not yet confirmed." :
      profile.retention === "disposable" ? "Recovery checkpoints remain in use until explicit `!workspace discard`. Finishing work or going idle does not discard it." :
        "Files and sessions are retained when work finishes or goes idle. Promotion to persistent preserves existing work.",
    "Durable projects, scripts, analysis, documents and prototypes may start blank and remain repository-free permanently. Keeping work requires no git initialization, commit or remote.",
  ].join("\n")
}
/** Stable event identity survives reset and never rebinds an old discard to new work. */
export async function slackWorkspaceDiscardRequestID(conversationKey: string, eventID: string): Promise<string> {
  if (!conversationKey || !eventID || conversationKey.length > 512 || eventID.length > 512) throw new Error("Stable workspace command identity unavailable")
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["aboiteau.slack.workspace.discard.v1", conversationKey, eventID])))).slice(0, 16)
  bytes[6] = (bytes[6]! & 15) | 128; bytes[8] = (bytes[8]! & 63) | 128
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
export async function readSlackWorkspaceProfile(service: NonNullable<SlackWorkspaceCommandServices["workspace"]>): Promise<WorkspaceProfile> {
  const response = await service(new Request("https://conversation/workspace/profile"))
  if (!response.ok) throw new Error("Workspace status unavailable")
  return parseWorkspaceProfile(envelope(await response.json()).workspace)
}
async function workspaceControl(rawArgs: string, services: SlackWorkspaceCommandServices): Promise<string> {
  if (!services.workspace) return "Workspace retention controls are unavailable here. No retention change or discard was requested."
  const args = decodeSlackCommandEntities(rawArgs).trim()
  if (!args || args === "status") return describeWorkspaceProfile(await readSlackWorkspaceProfile(services.workspace)) + "\n" + WORKSPACE_USAGE
  if (args === "discard") {
    const requestID = await services.discardRequestID?.()
    if (!requestID || !WORKSPACE_UUID.test(requestID)) return "Discard requires a stable command identity. No discard was requested."
    // Consult the durable receipt before current profile: replay must not refreeze a successor workspace.
    const priorResponse = await services.workspace(new Request("https://conversation/workspace/discard?requestID=" + requestID))
    if (!priorResponse.ok) return "Discard status could not be verified. No new discard was requested; inspect `!workspace`."
    const raw = envelope(await priorResponse.json()).discard
    let prior = raw === null ? null : parseWorkspaceDiscardRecord(raw)
    if (prior && prior.requestID !== requestID) throw new Error("Discard identity mismatch")
    if (prior?.status === "complete") return "Previously completed discard acknowledged. No new workspace was discarded. Slack conversation and financial records are retained."
    const profile = prior ? undefined : await readSlackWorkspaceProfile(services.workspace)
    if (profile?.status === "discarding") {
      const pendingResponse = await services.workspace(new Request("https://conversation/workspace/discard"))
      if (!pendingResponse.ok) return "Pending discard could not be verified. No new discard was requested; inspect `!workspace`."
      prior = parseWorkspaceDiscardRecord(envelope(await pendingResponse.json()).discard)
      if (prior.status !== "pending" || prior.expectedProfileID !== profile.profileID) throw new Error("Pending discard changed")
      // Keep this event's new ID: the lifecycle service durably aliases it to the frozen pending tuple.
    }
    const expectedProfileID = prior?.expectedProfileID ?? profile!.profileID, expectedRevision = prior?.expectedRevision ?? profile!.revision
    const response = await services.workspace(new Request("https://conversation/workspace/discard", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestID, expectedProfileID, expectedRevision }) }))
    if (!response.ok) return profile?.retention === "persistent" ?
      "Discard was not confirmed. This workspace is persistent: explicitly mark it disposable first with `!workspace disposable`, then use `!workspace discard`." :
      "Discard was not confirmed. The workspace may have changed or have unfinished work; inspect `!workspace` and `!status` before retrying."
    const receipt = parseWorkspaceDiscardRecord(envelope(await response.json()).discard)
    if (receipt.requestID !== requestID || receipt.expectedProfileID !== expectedProfileID || receipt.expectedRevision !== expectedRevision) throw new Error("Discard identity mismatch")
    return receipt.status === "complete" ? "Disposable workspace discarded. Slack conversation and financial records are retained." : "Discard is pending; cleanup is not yet confirmed. Inspect `!workspace` for status."
  }
  const match = /^(persistent|disposable)(?:\s+([\s\S]+))?$/.exec(args)
  if (!match) return WORKSPACE_USAGE
  const name = match[2]?.trim()
  if (name !== undefined && (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name))) return "Workspace names must be 1–80 characters without control characters. " + WORKSPACE_USAGE
  const profile = await readSlackWorkspaceProfile(services.workspace)
  const response = await services.workspace(new Request("https://conversation/workspace/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedProfileID: profile.profileID, expectedRevision: profile.revision, retention: match[1], ...(name === undefined ? {} : { name }) }) }))
  if (!response.ok) return "Retention change was not confirmed. Inspect `!workspace` before retrying; no discard was requested."
  const updated = parseWorkspaceProfile(envelope(await response.json()).workspace)
  if (updated.profileID !== profile.profileID || updated.retention !== match[1] || (name !== undefined && updated.name !== name)) throw new Error("Workspace profile changed")
  return describeWorkspaceProfile(updated) + "\nExisting files and session state were preserved. No runtime or model was started by this command."
}
