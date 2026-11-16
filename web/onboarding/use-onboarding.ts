import { useCallback, useEffect, useRef, useState } from "react"
import { api, readToken, rememberToken } from "../shared/api"
import { hasConnectedProvider } from "../../src/onboarding"

type Method = {
  id: string
  type: "oauth" | "key" | "command" | "external" | "env"
  label: string
}
type Integration = {
  id: string
  name: string
  methods?: Method[]
  connections?: unknown[]
}
type LiveModel = {
  providerID: string
  id: string
  name?: string
  enabled?: boolean
  type?: string
}
type Attempt = {
  attemptID: string
  url: string
  instructions?: string
  paste?: boolean
}
type AttemptStatus = { status?: string; error?: { message?: string } }
type SetupStatus = {
  configured: { github: boolean; vault: boolean }
  onboarding: {
    opencodeConnectedAt?: number
    githubConnectedAt?: number
    githubLogin?: string
    completedAt?: number
  }
  workspace: { repo: string; branch: string }
  model: string
  secrets: { github: boolean }
}
type Phase =
  | "idle"
  | "loading-status"
  | "begin-oauth"
  | "complete-oauth"
  | "connect-key"
  | "connect-github"
  | "save-workspace"
  | "finish"
  | "check-oauth"
type WorkspaceDraft = { repo: string; branch: string; model: string }
const DRAFT_KEY = "aboiteau.setup-draft"

function storedDraft(): Partial<WorkspaceDraft> {
  try {
    const value = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? "null")
    if (value && ["repo", "branch", "model"].every((key) => typeof value[key] === "string"))
      return value
  } catch {
    /* Browser storage is optional. */
  }
  return {}
}

export function useOnboarding() {
  const [token, setToken] = useState(readToken)
  const [activeToken, setActiveToken] = useState("")
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [models, setModels] = useState<LiveModel[]>([])
  const [selected, setSelected] = useState("")
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const [code, setCode] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [draft, setDraft] = useState<WorkspaceDraft>({
    repo: "",
    branch: "",
    model: "",
  })
  const [phase, setPhase] = useState<Phase>("idle")
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [catalogueNote, setCatalogueNote] = useState("")
  const [storageNote, setStorageNote] = useState("")
  const lock = useRef(false)
  const generation = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const integration = integrations.find((item) => item.id === selected)
  const pending = phase !== "idle"

  const stopPolling = useCallback(() => {
    generation.current++
    clearTimeout(timer.current)
  }, [])
  useEffect(() => stopPolling, [stopPolling])

  async function run(nextPhase: Phase, task: () => Promise<void>) {
    if (lock.current) return
    lock.current = true
    setPhase(nextPhase)
    setError("")
    setMessage("")
    try {
      await task()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The request failed. Try again.")
    } finally {
      lock.current = false
      setPhase("idle")
    }
  }

  async function refresh(value = activeToken) {
    const next = await api<SetupStatus>(value, "/api/onboarding/status")
    setStatus(next)
    return next
  }

  async function loadProviders(value = activeToken) {
    const result = await api<{ data: Integration[] }>(
      value,
      "/api/onboarding/opencode/integrations"
    )
    if (!Array.isArray(result.data))
      throw new Error("The provider list could not be read. Retry the connection.")
    setIntegrations(result.data)
    setSelected((current) =>
      result.data.some((item) => item.id === current) ? current : (result.data[0]?.id ?? "")
    )
  }

  async function loadModels(value = activeToken) {
    try {
      const result = await api<{ data: LiveModel[] }>(value, "/api/onboarding/opencode/models")
      if (!Array.isArray(result.data)) throw new Error("Unreadable model catalogue")
      setModels(
        result.data.filter((item) => (item.type ?? "chat") === "chat" && item.enabled !== false)
      )
      setCatalogueNote("")
    } catch {
      setModels([])
      setCatalogueNote(
        "The live model catalogue is unavailable. You can enter a model reference or retry providers."
      )
    }
  }

  async function connect(value = token) {
    if (!value.trim()) return
    await run("loading-status", async () => {
      stopPolling()
      setAttempt(null)
      const next = await refresh(value.trim())
      setActiveToken(value.trim())
      setToken(value.trim())
      if (!rememberToken(value.trim()))
        setStorageNote(
          "Browser storage is unavailable. You’ll need to enter your token again next time."
        )
      const saved = storedDraft()
      setDraft({
        repo: saved.repo ?? next.workspace.repo,
        branch: saved.branch ?? next.workspace.branch,
        model: saved.model ?? next.model,
      })
      await Promise.all([loadProviders(value.trim()), loadModels(value.trim())])
      const params = new URLSearchParams(window.location.search)
      const outcome = params.get("step") === "github" ? params.get("status") : null
      if (outcome === "connected") setMessage("GitHub connected. Continue with your workspace.")
      else if (outcome)
        setError(`GitHub connection ${outcome.replace(/_/g, " ")}. Try connecting again.`)
      else if (next.onboarding.completedAt)
        setMessage("This deployment has completed setup. You can update its connections here.")
    })
  }

  useEffect(() => {
    const value = readToken()
    if (value) void connect(value)
  }, [])
  useEffect(() => {
    if (!activeToken) return
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
    } catch {
      setStorageNote(
        "Browser storage is unavailable. Keep this page open to retain your workspace draft."
      )
    }
  }, [draft, activeToken])

  function update(key: keyof WorkspaceDraft, value: string) {
    setDraft((current) => ({ ...current, [key]: value }))
  }
  function cancelAttempt() {
    stopPolling()
    setAttempt(null)
    setCode("")
    setMessage("Sign-in check stopped. You can start a new sign-in.")
  }
  function selectProvider(value: string) {
    stopPolling()
    setAttempt(null)
    setCode("")
    setApiKey("")
    setSelected(value)
    setError("")
    setMessage("")
  }

  async function checkAttempt(current = attempt, epoch = generation.current): Promise<boolean> {
    if (!integration || !current) return true
    const result = await api<{ data: AttemptStatus }>(
      activeToken,
      `/api/onboarding/opencode/integrations/${encodeURIComponent(integration.id)}/connect/oauth/${encodeURIComponent(current.attemptID)}`
    )
    if (epoch !== generation.current) return true
    const outcome = result.data?.status
    if (!outcome)
      throw new Error("The sign-in status could not be read. Check again or restart sign-in.")
    if (outcome === "pending") return false
    stopPolling()
    setAttempt(null)
    if (outcome !== "complete" && outcome !== "completed")
      throw new Error(result.data?.error?.message ?? `Sign-in ${outcome}. Try again.`)
    await Promise.all([loadProviders(), loadModels(), refresh()])
    setMessage(`${integration.name} connected.`)
    return true
  }

  function schedulePoll(current: Attempt, epoch: number, started: number) {
    timer.current = setTimeout(async () => {
      if (epoch !== generation.current) return
      if (Date.now() - started > 5 * 60_000) {
        setError(
          "Automatic sign-in checks paused after five minutes. Check sign-in status or start again."
        )
        return
      }
      try {
        if (!(await checkAttempt(current, epoch)) && epoch === generation.current)
          schedulePoll(current, epoch, started)
      } catch (cause) {
        if (epoch === generation.current)
          setError(
            cause instanceof Error ? cause.message : "Sign-in status unavailable. Check again."
          )
      }
    }, 3000)
  }

  async function beginOAuth() {
    const method = integration?.methods?.find((item) => item.type === "oauth")
    if (!integration || !method) return
    await run("begin-oauth", async () => {
      stopPolling()
      const result = await api<{ data: Attempt }>(
        activeToken,
        `/api/onboarding/opencode/integrations/${encodeURIComponent(integration.id)}/connect/oauth`,
        { body: { methodID: method.id } }
      )
      if (!result.data?.attemptID || !/^https?:\/\//.test(result.data.url))
        throw new Error("The provider returned an invalid sign-in link. Try again.")
      setAttempt(result.data)
      window.open(result.data.url, "_blank", "noopener,noreferrer")
      schedulePoll(result.data, generation.current, Date.now())
    })
  }

  async function completeOAuth() {
    if (!integration || !attempt || !code.trim()) return
    await run("complete-oauth", async () => {
      await api(
        activeToken,
        `/api/onboarding/opencode/integrations/${encodeURIComponent(integration.id)}/connect/oauth/${encodeURIComponent(attempt.attemptID)}/complete`,
        { body: { code: code.trim() } }
      )
      setCode("")
      await checkAttempt()
    })
  }

  async function connectKey() {
    if (!integration || !apiKey.trim()) return
    await run("connect-key", async () => {
      await api(
        activeToken,
        `/api/onboarding/opencode/integrations/${encodeURIComponent(integration.id)}/connect/key`,
        { body: { key: apiKey.trim() } }
      )
      setApiKey("")
      await Promise.all([loadProviders(), loadModels(), refresh()])
      setMessage(`${integration.name} connected.`)
    })
  }

  async function connectGithub() {
    await run("connect-github", async () => {
      const result = await api<{ url: string }>(activeToken, "/api/onboarding/github/start")
      window.location.assign(result.url)
    })
  }

  async function saveWorkspace() {
    await run("save-workspace", async () => {
      await api(activeToken, "/api/settings", {
        method: "PUT",
        body: {
          workspaceRepo: draft.repo.trim(),
          workspaceBranch: draft.branch.trim(),
          model: draft.model.trim(),
        },
      })
      const next = await refresh()
      setDraft({
        repo: next.workspace.repo,
        branch: next.workspace.branch,
        model: next.model,
      })
      setMessage("Workspace saved. You can finish setup.")
    })
  }

  async function finish() {
    if (!workspaceSaved) {
      setError("Save your repository, branch and model before finishing setup.")
      return
    }
    await run("finish", async () => {
      const result = await api<{ snapshot: boolean }>(activeToken, "/api/onboarding/finish", {
        body: {},
      })
      await refresh()
      setMessage(
        result.snapshot
          ? "Setup complete. New conversations inherit this provider connection."
          : "Setup saved. Provider credentials were not checkpointed; new conversations may need to reconnect."
      )
    })
  }

  const providerConnected = hasConnectedProvider(integrations)
  const workspaceSaved =
    !!status?.workspace.repo &&
    !!status.model &&
    draft.repo.trim() === status.workspace.repo &&
    draft.branch.trim() === status.workspace.branch &&
    draft.model.trim() === status.model

  return {
    token,
    setToken,
    connect,
    authenticated: !!activeToken,
    phase,
    pending,
    status,
    integrations,
    models,
    integration,
    selected,
    selectProvider,
    attempt,
    code,
    setCode,
    apiKey,
    setApiKey,
    draft,
    update,
    error,
    message,
    catalogueNote,
    storageNote,
    providerConnected,
    workspaceSaved,
    beginOAuth,
    completeOAuth,
    connectKey,
    connectGithub,
    saveWorkspace,
    finish,
    cancelAttempt,
    checkSignIn: () =>
      run("check-oauth", async () => {
        if (!(await checkAttempt()))
          setMessage("Sign-in is still waiting. Complete it with your provider, then check again.")
      }),
    retryProviders: () =>
      run("loading-status", async () => {
        await Promise.all([loadProviders(), loadModels(), refresh()])
      }),
  }
}
