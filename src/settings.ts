/** Harness-wide settings, stored in the singleton Settings Durable Object. */

import { DENY_COMMANDS, SAFE_COMMANDS } from "./permissions"

export interface PermissionLists {
  /** Shell patterns allowed without asking. */
  allow: string[]
  /** Extra patterns that ask even if they match the catch-all. */
  ask: string[]
  /** Patterns denied outright. */
  deny: string[]
}

export interface HarnessSettings {
  workspaceRepo: string
  workspaceBranch: string
  /** provider/model or provider/model#variant */
  model: string
  /** Alarm poll cadence while a run is active. */
  pollSeconds: number
  /** Read OpenCode's event stream while the container is warm. */
  streaming: boolean
  /** Harness-wide daily spend cap in USD; 0 disables enforcement. */
  dailyBudgetUSD: number
  /** Maximum conversation containers running at once. */
  maxContainers: number
  permissions: PermissionLists
  /** First-run connection state; written by the onboarding API, never by PUT. */
  onboarding: OnboardingState
  /** Bumped on every save; conversation DOs restart when it changes. */
  version: number
  updatedAt?: number
}

export interface OnboardingState {
  /** When a provider was connected for the first time. */
  opencodeConnectedAt?: number
  /** GitHub account connected for private repository access. */
  githubConnectedAt?: number
  githubLogin?: string
  /** When the operator finished (or explicitly skipped) the wizard. */
  completedAt?: number
}

export const DEFAULT_ALLOW = SAFE_COMMANDS.map((command) => `${command} *`)

/** Common legitimate-but-risky commands: explicit so operators can see and edit them. */
export const DEFAULT_ASK = [
  "git add *",
  "git commit *",
  "git push *",
  "git checkout *",
  "git switch *",
  "git merge *",
  "git rebase *",
  "bun add *",
  "bun install *",
  "bun remove *",
  "npm install *",
  "npm add *",
  "pnpm add *",
  "yarn add *",
  "curl *",
  "wget *",
  "ssh *",
  "scp *",
  "gh *",
  "docker *",
  "kubectl *",
  "terraform *",
  "ffmpeg *",
  "python *",
  "node *",
]

export const DEFAULT_DENY = [
  ...DENY_COMMANDS,
  "dd *",
  "mkfs*",
  "shutdown *",
  "reboot *",
  "chown -R *",
]

export const DEFAULT_POLL_SECONDS = 2

export interface SettingsDefaults {
  WORKSPACE_REPO?: string
  OPENCODE_MODEL?: string
  POLL_SECONDS?: string
}

export function defaultSettings(env: SettingsDefaults): HarnessSettings {
  return {
    workspaceRepo: env.WORKSPACE_REPO ?? "",
    workspaceBranch: "main",
    model: env.OPENCODE_MODEL ?? "opencode/deepseek-v4.1-flash",
    pollSeconds: Number(env.POLL_SECONDS ?? DEFAULT_POLL_SECONDS) || DEFAULT_POLL_SECONDS,
    streaming: true,
    dailyBudgetUSD: 0,
    maxContainers: 2,
    permissions: { allow: DEFAULT_ALLOW, ask: DEFAULT_ASK, deny: DEFAULT_DENY },
    onboarding: {},
    version: 1,
  }
}

const MAX_LIST = 200
const MAX_PATTERN = 200

export function validateSettings(
  input: unknown,
  base: HarnessSettings,
): { ok: true; value: HarnessSettings } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "body must be an object" }
  const body = input as Record<string, unknown>

  const workspaceRepo = body.workspaceRepo ?? base.workspaceRepo
  if (typeof workspaceRepo !== "string" || !/^https?:\/\/\S+$/.test(workspaceRepo)) {
    return { ok: false, error: "workspaceRepo must be an http(s) URL" }
  }

  const workspaceBranch = body.workspaceBranch ?? base.workspaceBranch
  if (typeof workspaceBranch !== "string" || !/^[A-Za-z0-9._/-]{1,200}$/.test(workspaceBranch)) {
    return { ok: false, error: "workspaceBranch is not a valid branch name" }
  }

  const model = body.model ?? base.model
  if (typeof model !== "string" || !/^[^/\s]+\/[^/\s]+(#[\w.-]+)?$/.test(model)) {
    return { ok: false, error: "model must be provider/model or provider/model#variant" }
  }

  const pollSeconds = body.pollSeconds ?? base.pollSeconds
  if (typeof pollSeconds !== "number" || !Number.isInteger(pollSeconds) || pollSeconds < 2 || pollSeconds > 60) {
    return { ok: false, error: "pollSeconds must be an integer between 2 and 60" }
  }

  const streaming = body.streaming ?? base.streaming
  if (typeof streaming !== "boolean") return { ok: false, error: "streaming must be a boolean" }

  const dailyBudgetUSD = body.dailyBudgetUSD ?? base.dailyBudgetUSD
  if (
    typeof dailyBudgetUSD !== "number" ||
    !Number.isFinite(dailyBudgetUSD) ||
    dailyBudgetUSD < 0 ||
    dailyBudgetUSD > 100_000
  ) {
    return { ok: false, error: "dailyBudgetUSD must be a number between 0 and 100000" }
  }

  const maxContainers = body.maxContainers ?? base.maxContainers
  if (
    typeof maxContainers !== "number" ||
    !Number.isInteger(maxContainers) ||
    maxContainers < 1 ||
    maxContainers > 10
  ) {
    return { ok: false, error: "maxContainers must be an integer between 1 and 10" }
  }

  const permissionsInput = (body.permissions ?? base.permissions) as Record<string, unknown>
  const permissions: PermissionLists = { allow: [], ask: [], deny: [] }
  for (const key of ["allow", "ask", "deny"] as const) {
    const list = permissionsInput?.[key] ?? base.permissions[key]
    if (!Array.isArray(list) || list.length > MAX_LIST) {
      return { ok: false, error: `permissions.${key} must be an array of at most ${MAX_LIST} patterns` }
    }
    for (const pattern of list) {
      if (typeof pattern !== "string" || !pattern.trim() || pattern.length > MAX_PATTERN) {
        return { ok: false, error: `permissions.${key} contains an invalid pattern` }
      }
    }
    permissions[key] = (list as string[]).map((pattern) => pattern.trim())
  }

  return {
    ok: true,
    value: {
      workspaceRepo,
      workspaceBranch,
      model,
      pollSeconds,
      streaming,
      dailyBudgetUSD,
      maxContainers,
      permissions,
      onboarding: base.onboarding ?? {},
      version: base.version,
    },
  }
}
