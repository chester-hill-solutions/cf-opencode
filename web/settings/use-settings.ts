import { useEffect, useReducer, useRef } from "react"
import { validateSettings, type HarnessSettings } from "../../src/settings"
import type { ModelOption } from "../../src/models"
import {
  DEFAULT_MODEL,
  initialSettingsState,
  isAuthenticated,
  isDirty,
  isLoaded,
  isPending,
  isTokenChanged,
  reduceSettings,
  settingsPresentation,
  type SettingsDraft,
  type SettingsError,
} from "./machine"

export type { PermissionKind, SettingsDraft } from "./machine"

const TOKEN_KEY = "cfopencode.token"

export const ruleLines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ""
  } catch {
    return ""
  }
}

class SettingsRequestError extends Error {
  constructor(
    message: string,
    readonly offline = false
  ) {
    super(message)
  }
}

function isSettings(value: unknown): value is HarnessSettings {
  if (!value || typeof value !== "object") return false
  const item = value as Record<string, unknown>
  const permissions = item.permissions as Record<string, unknown> | undefined
  return (
    typeof item.workspaceRepo === "string" &&
    typeof item.workspaceBranch === "string" &&
    typeof item.model === "string" &&
    typeof item.pollSeconds === "number" &&
    typeof item.streaming === "boolean" &&
    typeof item.dailyBudgetUSD === "number" &&
    typeof item.version === "number" &&
    !!permissions &&
    ["allow", "ask", "deny"].every(
      (kind) =>
        Array.isArray(permissions[kind]) &&
        (permissions[kind] as unknown[]).every((rule) => typeof rule === "string")
    )
  )
}

async function request<T>(token: string, path: string, body?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      method: body ? "PUT" : "GET",
      headers: {
        authorization: "Bearer " + token,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    })
  } catch {
    throw new SettingsRequestError(
      "Couldn’t reach Aboiteau. Check your connection and try again. Your changes are still here.",
      true
    )
  }
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    if (response.status === 401)
      throw new SettingsRequestError(
        "The API token was rejected. Check the token and load settings again."
      )
    throw new SettingsRequestError(
      payload?.error ?? "The request failed (" + response.status + "). Try again."
    )
  }
  if (!payload)
    throw new SettingsRequestError("The server returned an unreadable response. Try again.")
  return payload as T
}

export function useSettings() {
  const [state, dispatch] = useReducer(reduceSettings, readToken(), initialSettingsState)
  const busy = useRef(false)
  const {
    token,
    draft,
    saved,
    models,
    recommended,
    catalogueAvailable,
    storageAvailable,
    status,
    error,
  } = state
  const loaded = isLoaded(state)
  const pending = isPending(state)
  const dirty = isDirty(state)
  const authenticated = isAuthenticated(state)
  const tokenChanged = isTokenChanged(state)
  const presentation = settingsPresentation(state)

  function setToken(value: string) {
    dispatch({ type: "token", token: value })
  }

  function update<K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) {
    dispatch({ type: "patch-draft", patch: { [key]: value } as Partial<SettingsDraft> })
  }

  async function load() {
    if (busy.current || dirty || !token.trim()) return
    busy.current = true
    dispatch({ type: "load-start" })
    const currentToken = token.trim()
    try {
      const [settingsResult, catalogueResult] = await Promise.allSettled([
        request<HarnessSettings>(currentToken, "/api/settings"),
        request<{ models: ModelOption[]; recommended: string }>(currentToken, "/api/models"),
      ])
      if (settingsResult.status === "rejected") throw settingsResult.reason
      const settings = settingsResult.value
      // Defaults may be incomplete until the first save; check shape, not input validity.
      if (!isSettings(settings))
        throw new SettingsRequestError("The saved settings could not be read. Try loading again.")
      const catalogue =
        catalogueResult.status === "fulfilled" &&
        Array.isArray(catalogueResult.value.models) &&
        catalogueResult.value.models.length
          ? {
              models: catalogueResult.value.models,
              recommended: catalogueResult.value.recommended || DEFAULT_MODEL,
            }
          : { models: [], recommended: DEFAULT_MODEL }
      dispatch({
        type: "load-success",
        settings,
        models: catalogue.models,
        recommended: catalogue.recommended,
        token: currentToken,
      })
      try {
        localStorage.setItem(TOKEN_KEY, currentToken)
      } catch {
        dispatch({ type: "storage-unavailable" })
      }
    } catch (cause) {
      const failure: SettingsError = {
        scope: "load",
        message: cause instanceof Error ? cause.message : "Couldn’t load settings. Try again.",
        offline: cause instanceof SettingsRequestError && cause.offline,
      }
      dispatch({ type: "load-failure", error: failure })
    } finally {
      busy.current = false
    }
  }

  async function save() {
    if (busy.current || !authenticated || !saved) return
    const payload = {
      workspaceRepo: draft.workspaceRepo.trim(),
      workspaceBranch: draft.workspaceBranch.trim(),
      model: draft.model.trim(),
      pollSeconds: Number(draft.pollSeconds),
      streaming: draft.streaming,
      dailyBudgetUSD: Number(draft.dailyBudgetUSD),
      permissions: {
        allow: ruleLines(draft.permissions.allow),
        ask: ruleLines(draft.permissions.ask),
        deny: ruleLines(draft.permissions.deny),
      },
    }
    const validated = validateSettings(payload, saved)
    if (!validated.ok) {
      dispatch({
        type: "save-failure",
        error: { scope: "save", message: validated.error, offline: false },
      })
      return
    }
    busy.current = true
    dispatch({ type: "save-start" })
    try {
      const settings = await request<HarnessSettings>(token.trim(), "/api/settings", payload)
      if (!isSettings(settings))
        throw new SettingsRequestError(
          "The save response could not be read. Reload settings to check the saved values."
        )
      dispatch({ type: "save-success", settings, token: token.trim() })
      try {
        localStorage.setItem(TOKEN_KEY, token.trim())
      } catch {
        dispatch({ type: "storage-unavailable" })
      }
    } catch (cause) {
      const failure: SettingsError = {
        scope: "save",
        message:
          cause instanceof Error
            ? cause.message
            : "Couldn’t save settings. Your changes are still here.",
        offline: cause instanceof SettingsRequestError && cause.offline,
      }
      dispatch({ type: "save-failure", error: failure })
    } finally {
      busy.current = false
    }
  }

  useEffect(() => {
    if (token) void load()
  }, [])

  return {
    token,
    setToken,
    draft,
    update,
    saved,
    loaded,
    status,
    error,
    dirty,
    pending,
    authenticated,
    tokenChanged,
    models,
    recommended,
    catalogueAvailable,
    storageAvailable,
    presentation,
    load,
    save,
  }
}
