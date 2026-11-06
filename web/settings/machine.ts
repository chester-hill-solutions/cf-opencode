import type { HarnessSettings } from "../../src/settings"
import type { ModelOption } from "../../src/models"

export type PermissionKind = "allow" | "ask" | "deny"

export type SettingsDraft = {
  workspaceRepo: string
  workspaceBranch: string
  model: string
  pollSeconds: string
  streaming: boolean
  dailyBudgetUSD: string
  maxContainers: string
  permissions: Record<PermissionKind, string>
}

export type SettingsError = {
  scope: "load" | "save"
  message: string
  offline: boolean
}

export type SettingsTone = "neutral" | "success" | "warning" | "error" | "busy"

/**
 * One status for the whole settings surface. Everything else is either loaded
 * data, editable draft text or a derived selector. There is deliberately no
 * `loading`/`saving`/`loaded`/`error` boolean set.
 */
export type SettingsStatus =
  | "empty"
  | "loading"
  | "ready"
  | "saving"
  | "saved"
  | "load-error"
  | "save-error"

export type SettingsState = {
  status: SettingsStatus
  token: string
  activeToken: string
  draft: SettingsDraft
  saved: HarnessSettings | null
  error: SettingsError | null
  models: ModelOption[]
  recommended: string
  catalogueAvailable: boolean
  storageAvailable: boolean
}

export const DEFAULT_MODEL = "opencode/deepseek-v4.1-flash"

export const emptyDraft: SettingsDraft = {
  workspaceRepo: "",
  workspaceBranch: "",
  model: DEFAULT_MODEL,
  pollSeconds: "2",
  streaming: true,
  dailyBudgetUSD: "0",
  maxContainers: "2",
  permissions: { allow: "", ask: "", deny: "" },
}

export function toDraft(settings: HarnessSettings): SettingsDraft {
  return {
    workspaceRepo: settings.workspaceRepo,
    workspaceBranch: settings.workspaceBranch,
    model: settings.model,
    pollSeconds: String(settings.pollSeconds),
    streaming: settings.streaming,
    dailyBudgetUSD: String(settings.dailyBudgetUSD ?? 0),
    maxContainers: String(settings.maxContainers ?? 2),
    permissions: {
      allow: settings.permissions.allow.join("\n"),
      ask: settings.permissions.ask.join("\n"),
      deny: settings.permissions.deny.join("\n"),
    },
  }
}

export function initialSettingsState(token = ""): SettingsState {
  return {
    status: "empty",
    token,
    activeToken: "",
    draft: emptyDraft,
    saved: null,
    error: null,
    models: [],
    recommended: DEFAULT_MODEL,
    catalogueAvailable: false,
    storageAvailable: true,
  }
}

export type SettingsEvent =
  | { type: "token"; token: string }
  | { type: "patch-draft"; patch: Partial<SettingsDraft> }
  | { type: "load-start" }
  | {
      type: "load-success"
      settings: HarnessSettings
      models: ModelOption[]
      recommended: string
      token: string
    }
  | { type: "load-failure"; error: SettingsError }
  | { type: "save-start" }
  | { type: "save-success"; settings: HarnessSettings; token: string }
  | { type: "save-failure"; error: SettingsError }
  | { type: "storage-unavailable" }

export function reduceSettings(state: SettingsState, event: SettingsEvent): SettingsState {
  switch (event.type) {
    case "token":
      return { ...state, token: event.token }
    case "patch-draft":
      return {
        ...state,
        draft: { ...state.draft, ...event.patch },
        ...(state.status === "save-error"
          ? { status: "ready" as const, error: null }
          : {}),
      }
    case "load-start":
      if (state.status === "loading" || state.status === "saving") return state
      return { ...state, status: "loading", error: null }
    case "load-success":
      return {
        ...state,
        status: "ready",
        activeToken: event.token,
        draft: toDraft(event.settings),
        saved: event.settings,
        error: null,
        models: event.models,
        recommended: event.recommended || DEFAULT_MODEL,
        catalogueAvailable: event.models.length > 0,
      }
    case "load-failure":
      return { ...state, status: "load-error", error: event.error }
    case "save-start":
      if (state.saved === null) return state
      if (state.status === "loading" || state.status === "saving") return state
      return { ...state, status: "saving", error: null }
    case "save-success":
      if (state.status !== "saving") return state
      return {
        ...state,
        status: "saved",
        activeToken: event.token,
        draft: toDraft(event.settings),
        saved: event.settings,
        error: null,
      }
    case "save-failure":
      if (state.saved === null) return state
      return { ...state, status: "save-error", error: event.error }
    case "storage-unavailable":
      return { ...state, storageAvailable: false }
    default:
      return assertNever(event)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled settings event: ${JSON.stringify(value)}`)
}

export function isPending(state: SettingsState): boolean {
  return state.status === "loading" || state.status === "saving"
}

export function isLoaded(state: SettingsState): boolean {
  return state.saved !== null && state.status !== "load-error"
}

export function isDirty(state: SettingsState): boolean {
  if (!isLoaded(state) || state.saved === null) return false
  return JSON.stringify(state.draft) !== JSON.stringify(toDraft(state.saved))
}

export function isAuthenticated(state: SettingsState): boolean {
  return isLoaded(state) && state.token.trim().length > 0
}

export function isTokenChanged(state: SettingsState): boolean {
  return isLoaded(state) && state.token.trim() !== state.activeToken
}

export type SettingsPresentation = {
  label: string
  tone: SettingsTone
}

/** The single state → presentation mapping. No if-chain over flags in components. */
export function settingsPresentation(state: SettingsState): SettingsPresentation {
  if (isPending(state)) {
    return {
      label: state.status === "loading" ? "loading…" : "saving…",
      tone: "busy",
    }
  }
  if (state.error) {
    return {
      label: state.error.offline
        ? "connection unavailable"
        : state.error.scope === "save"
          ? "save failed"
          : "load failed",
      tone: "error",
    }
  }
  if (isTokenChanged(state)) return { label: "token changed", tone: "warning" }
  if (isDirty(state)) return { label: "unsaved changes", tone: "warning" }
  if (state.status === "saved") return { label: "saved", tone: "success" }
  if (isLoaded(state)) return { label: "loaded", tone: "success" }
  return { label: "not loaded", tone: "neutral" }
}
