import { useEffect, useRef, useState } from "react"
import { validateSettings, type HarnessSettings } from "../../src/settings"
import type { ModelOption } from "../../src/models"

const TOKEN_KEY = "cfopencode.token"
const DEFAULT_MODEL = "opencode/deepseek-v4.1-flash"
export type PermissionKind = "allow" | "ask" | "deny"
export type SettingsDraft = {
  workspaceRepo: string
  workspaceBranch: string
  model: string
  pollSeconds: string
  streaming: boolean
  permissions: Record<PermissionKind, string>
}

export const ruleLines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
const emptyDraft: SettingsDraft = {
  workspaceRepo: "",
  workspaceBranch: "",
  model: DEFAULT_MODEL,
  pollSeconds: "2",
  streaming: true,
  permissions: { allow: "", ask: "", deny: "" },
}

function toDraft(settings: HarnessSettings): SettingsDraft {
  return {
    workspaceRepo: settings.workspaceRepo,
    workspaceBranch: settings.workspaceBranch,
    model: settings.model,
    pollSeconds: String(settings.pollSeconds),
    streaming: settings.streaming,
    permissions: {
      allow: settings.permissions.allow.join("\n"),
      ask: settings.permissions.ask.join("\n"),
      deny: settings.permissions.deny.join("\n"),
    },
  }
}

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
  const [token, setToken] = useState(readToken)
  const [activeToken, setActiveToken] = useState("")
  const [draft, setDraft] = useState<SettingsDraft>(emptyDraft)
  const [saved, setSaved] = useState<HarnessSettings | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [phase, setPhase] = useState<"idle" | "loading" | "loaded" | "saving" | "saved">("idle")
  const [error, setError] = useState<{
    scope: "load" | "save"
    message: string
    offline: boolean
  } | null>(null)
  const [models, setModels] = useState<ModelOption[]>([])
  const [recommended, setRecommended] = useState(DEFAULT_MODEL)
  const [catalogueAvailable, setCatalogueAvailable] = useState(false)
  const [storageAvailable, setStorageAvailable] = useState(true)
  const busy = useRef(false)
  const dirty = loaded && saved !== null && JSON.stringify(draft) !== JSON.stringify(toDraft(saved))
  const pending = phase === "loading" || phase === "saving"
  const authenticated = loaded && !!token.trim()
  const tokenChanged = loaded && token.trim() !== activeToken

  function update<K extends keyof SettingsDraft>(key: K, value: SettingsDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
    setError(null)
  }

  async function load() {
    if (busy.current || dirty || !token.trim()) return
    busy.current = true
    setPhase("loading")
    setError(null)
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
      setSaved(settings)
      setDraft(toDraft(settings))
      setActiveToken(currentToken)
      setLoaded(true)
      if (
        catalogueResult.status === "fulfilled" &&
        Array.isArray(catalogueResult.value.models) &&
        catalogueResult.value.models.length
      ) {
        setModels(catalogueResult.value.models)
        setRecommended(catalogueResult.value.recommended || DEFAULT_MODEL)
        setCatalogueAvailable(true)
      } else {
        setModels([])
        setCatalogueAvailable(false)
      }
      try {
        localStorage.setItem(TOKEN_KEY, currentToken)
      } catch {
        setStorageAvailable(false)
      }
      setPhase("loaded")
    } catch (cause) {
      setLoaded(false)
      setPhase("idle")
      setError({
        scope: "load",
        message: cause instanceof Error ? cause.message : "Couldn’t load settings. Try again.",
        offline: cause instanceof SettingsRequestError && cause.offline,
      })
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
      permissions: {
        allow: ruleLines(draft.permissions.allow),
        ask: ruleLines(draft.permissions.ask),
        deny: ruleLines(draft.permissions.deny),
      },
    }
    const validated = validateSettings(payload, saved)
    if (!validated.ok) {
      setError({ scope: "save", message: validated.error, offline: false })
      return
    }
    busy.current = true
    setPhase("saving")
    setError(null)
    try {
      const settings = await request<HarnessSettings>(token.trim(), "/api/settings", payload)
      if (!isSettings(settings))
        throw new SettingsRequestError(
          "The save response could not be read. Reload settings to check the saved values."
        )
      setSaved(settings)
      setDraft(toDraft(settings))
      setActiveToken(token.trim())
      try {
        localStorage.setItem(TOKEN_KEY, token.trim())
      } catch {
        setStorageAvailable(false)
      }
      setPhase("saved")
    } catch (cause) {
      setPhase("loaded")
      setError({
        scope: "save",
        message:
          cause instanceof Error
            ? cause.message
            : "Couldn’t save settings. Your changes are still here.",
        offline: cause instanceof SettingsRequestError && cause.offline,
      })
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
    phase,
    error,
    dirty,
    pending,
    authenticated,
    tokenChanged,
    models,
    recommended,
    catalogueAvailable,
    storageAvailable,
    load,
    save,
  }
}
