import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { MODEL_CATALOG } from "../src/models"
import { defaultSettings, type HarnessSettings } from "../src/settings"
import {
  initialSettingsState,
  isAuthenticated,
  isDirty,
  isLoaded,
  isPending,
  isTokenChanged,
  reduceSettings,
  settingsPresentation,
  type SettingsEvent,
  type SettingsState,
} from "../web/settings/machine"

const root = join(import.meta.dir, "..")
const base: HarnessSettings = defaultSettings({
  WORKSPACE_REPO: "https://github.com/chester-hill-solutions/cf-opencode",
  OPENCODE_MODEL: "opencode/deepseek-v4.1-flash",
  POLL_SECONDS: "2",
})
const model = MODEL_CATALOG[0]!

const empty = initialSettingsState("token")
const loading = reduceSettings(empty, { type: "load-start" })
const ready = reduceSettings(loading, {
  type: "load-success",
  settings: base,
  models: [model],
  recommended: base.model,
  token: "token",
})
const saving = reduceSettings(ready, { type: "save-start" })
const saved = reduceSettings(saving, {
  type: "save-success",
  settings: base,
  token: "token",
})
const loadError = reduceSettings(empty, {
  type: "load-failure",
  error: { scope: "load", message: "offline", offline: true },
})
const saveError = reduceSettings(ready, {
  type: "save-failure",
  error: { scope: "save", message: "rejected", offline: false },
})

const states: Record<SettingsState["status"], SettingsState> = {
  empty,
  loading,
  ready,
  saving,
  saved,
  "load-error": loadError,
  "save-error": saveError,
}

const events: SettingsEvent[] = [
  { type: "token", token: "next-token" },
  { type: "patch-draft", patch: { pollSeconds: "5" } },
  { type: "load-start" },
  { type: "load-success", settings: base, models: [model], recommended: base.model, token: "token" },
  { type: "load-failure", error: { scope: "load", message: "offline", offline: true } },
  { type: "save-start" },
  { type: "save-success", settings: base, token: "token" },
  { type: "save-failure", error: { scope: "save", message: "rejected", offline: false } },
  { type: "storage-unavailable" },
]

describe("settings state machine", () => {
  test("every state has one coherent status and no contradictory fields", () => {
    for (const state of Object.values(states)) {
      const isError = state.status === "load-error" || state.status === "save-error"
      expect(state.error !== null).toBe(isError)
      if (state.status === "empty") {
        expect(state.saved).toBeNull()
        expect(state.error).toBeNull()
      }
      if (["ready", "saving", "saved", "save-error"].includes(state.status)) {
        expect(state.saved).not.toBeNull()
      }
      expect(isPending(state)).toBe(state.status === "loading" || state.status === "saving")
    }
  })

  test("every state × event returns a valid state", () => {
    for (const state of Object.values(states)) {
      for (const event of events) {
        const next = reduceSettings(state, event)
        expect(Object.keys(states)).toContain(next.status)
        if (next.error) expect(["load-error", "save-error"]).toContain(next.status)
        if (next.status === "empty") expect(next.saved).toBeNull()
      }
    }
  })

  test("guards illegal transitions", () => {
    expect(reduceSettings(loading, { type: "load-start" })).toBe(loading)
    expect(reduceSettings(saving, { type: "load-start" })).toBe(saving)
    expect(reduceSettings(empty, { type: "save-start" })).toBe(empty)
    expect(reduceSettings(loading, { type: "save-start" })).toBe(loading)
    expect(reduceSettings(loadError, { type: "save-start" })).toBe(loadError)
    expect(reduceSettings(ready, { type: "save-success", settings: base, token: "token" })).toBe(ready)
    expect(reduceSettings(empty, { type: "save-failure", error: { scope: "save", message: "x", offline: false } })).toBe(empty)
  })

  test("load, save and error transitions are explicit", () => {
    expect(ready.status).toBe("ready")
    expect(saving.status).toBe("saving")
    expect(saved.status).toBe("saved")
    expect(loadError.status).toBe("load-error")
    expect(saveError.status).toBe("save-error")

    const recovered = reduceSettings(saveError, { type: "patch-draft", patch: { pollSeconds: "8" } })
    expect(recovered.status).toBe("ready")
    expect(recovered.error).toBeNull()

    const retried = reduceSettings(saved, { type: "save-start" })
    expect(retried.status).toBe("saving")
  })

  test("derived boolean answers come from status, not sibling flags", () => {
    expect(isLoaded(empty)).toBe(false)
    expect(isLoaded(loading)).toBe(false)
    expect(isLoaded(ready)).toBe(true)
    expect(isLoaded(loadError)).toBe(false)
    expect(isPending(loading)).toBe(true)
    expect(isPending(saving)).toBe(true)
    expect(isDirty(ready)).toBe(false)
    expect(isDirty(reduceSettings(ready, { type: "patch-draft", patch: { pollSeconds: "5" } }))).toBe(true)
    expect(isAuthenticated(ready)).toBe(true)
    expect(isAuthenticated(reduceSettings(ready, { type: "token", token: "  " }))).toBe(false)
    expect(isTokenChanged(ready)).toBe(false)
    expect(isTokenChanged(reduceSettings(ready, { type: "token", token: "other" }))).toBe(true)
  })

  test("presentation is one mapping from state", () => {
    expect(settingsPresentation(empty)).toEqual({ label: "not loaded", tone: "neutral" })
    expect(settingsPresentation(loading)).toEqual({ label: "loading…", tone: "busy" })
    expect(settingsPresentation(ready)).toEqual({ label: "loaded", tone: "success" })
    expect(settingsPresentation(saved)).toEqual({ label: "saved", tone: "success" })
    expect(settingsPresentation(loadError)).toEqual({
      label: "connection unavailable",
      tone: "error",
    })
    expect(settingsPresentation(saveError)).toEqual({ label: "save failed", tone: "error" })
    expect(
      settingsPresentation(reduceSettings(ready, { type: "patch-draft", patch: { pollSeconds: "5" } }))
    ).toEqual({ label: "unsaved changes", tone: "warning" })
    expect(
      settingsPresentation(reduceSettings(ready, { type: "token", token: "other" }))
    ).toEqual({ label: "token changed", tone: "warning" })
  })
})

function filesUnder(dir: string, extensions: string[]): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...filesUnder(path, extensions))
    else if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(path)
  }
  return found
}

describe("implicit state machine ratchet", () => {
  test("product UI does not keep status in boolean useState flags", () => {
    const statusFlag =
      /const\s*\[\s*(loading|saving|saved|pending|error|success|ready|busy|dirty|failed|offline|authenticated|loaded)\s*,\s*\w+\s*\]\s*=\s*useState\s*(?:<[^>]*>)?\s*\(\s*(?:true|false)\s*\)/g
    const sources = [
      ...filesUnder(join(root, "web/settings"), [".ts", ".tsx"]),
      ...filesUnder(join(root, "web/onboarding"), [".ts", ".tsx"]),
    ]
    const offenders: string[] = []
    for (const source of sources) {
      for (const [lineNumber, line] of readFileSync(source, "utf8").split("\n").entries()) {
        if (statusFlag.test(line)) {
          offenders.push(`${relative(root, source)}:${lineNumber + 1}: ${line.trim()}`)
        }
        statusFlag.lastIndex = 0
      }
    }
    expect(offenders).toEqual([])
  })

  test("product UI names phase state with a typed union, not an empty string", () => {
    const statusString =
      /const\s*\[\s*(busy|phase|status|mode)\s*,\s*\w+\s*\]\s*=\s*useState\s*(?:<[^>]*>)?\s*\(\s*""\s*\)/g
    const sources = [
      ...filesUnder(join(root, "web/settings"), [".ts", ".tsx"]),
      ...filesUnder(join(root, "web/onboarding"), [".ts", ".tsx"]),
    ]
    const offenders: string[] = []
    for (const source of sources) {
      for (const [lineNumber, line] of readFileSync(source, "utf8").split("\n").entries()) {
        if (statusString.test(line)) {
          offenders.push(`${relative(root, source)}:${lineNumber + 1}: ${line.trim()}`)
        }
        statusString.lastIndex = 0
      }
    }
    expect(offenders).toEqual([])
  })

  test("the settings surface has one reducer and one presentation mapping", () => {
    const hook = readFileSync(join(root, "web/settings/use-settings.ts"), "utf8")
    const app = readFileSync(join(root, "web/settings/app.tsx"), "utf8")
    expect(hook).toContain("useReducer(reduceSettings")
    expect(hook).not.toMatch(/\buseState\(/)
    expect(app).toContain("state.presentation")
    expect(app).not.toContain("state.phase")
  })
})
