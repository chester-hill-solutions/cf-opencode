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
  permissions: PermissionLists
  /** Bumped on every save; conversation DOs restart when it changes. */
  version: number
  updatedAt?: number
}

export const DEFAULT_ALLOW = SAFE_COMMANDS.map((command) => `${command} *`)
export const DEFAULT_DENY = [...DENY_COMMANDS]

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
    pollSeconds: Number(env.POLL_SECONDS ?? 2) || 2,
    streaming: true,
    permissions: { allow: DEFAULT_ALLOW, ask: [], deny: DEFAULT_DENY },
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
      permissions,
      version: base.version,
    },
  }
}
