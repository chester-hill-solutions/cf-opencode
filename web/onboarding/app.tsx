import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  Alert,
  AlertDescription,
  AlertTitle,
  BrandLockup,
  Button,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  NativeSelect,
  Status,
  type StatusTone,
} from "@aboiteau/ui"

const TOKEN_KEY = "cfopencode.token"

type IntegrationMethod = {
  id: string
  type: "oauth" | "key" | "command" | "external" | "env"
  label: string
}

type Integration = {
  id: string
  name: string
  methods?: IntegrationMethod[]
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
  mode?: string
  paste?: boolean
}

type AttemptStatus = { status?: string; error?: { message?: string } }

type OnboardingStatus = {
  configured: { github: boolean; vault: boolean }
  onboarding: {
    opencodeConnectedAt?: number
    githubConnectedAt?: number
    githubLogin?: string
    completedAt?: number
  }
  workspace: { repo: string; branch: string }
  model: string
  secrets: { github: boolean; opencode: boolean }
}

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ""
  } catch {
    return ""
  }
}

async function api<T>(token: string, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? (init?.body === undefined ? "GET" : "POST"),
    headers: {
      authorization: "Bearer " + token,
      ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(60000),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error((payload as { error?: string } | null)?.error ?? `Request failed (${response.status})`)
  }
  return payload as T
}

function Step({
  number,
  title,
  description,
  status,
  children,
}: {
  number: string
  title: string
  description: string
  status?: { label: string; tone: StatusTone }
  children: ReactNode
}) {
  return (
    <section className="settings-section" aria-labelledby={`step-${number}`}>
      <div className="section-heading">
        <span className="section-number" aria-hidden="true">
          {number}
        </span>
        <div>
          <h2 id={`step-${number}`}>{title}</h2>
          <p>{description}</p>
        </div>
        {status ? <Status tone={status.tone}>{status.label}</Status> : null}
      </div>
      {children}
    </section>
  )
}

export function OnboardingApp() {
  const [token, setToken] = useState(readToken)
  const [activeToken, setActiveToken] = useState("")
  const [status, setStatus] = useState<OnboardingStatus | null>(null)
  const [integrations, setIntegrations] = useState<Integration[]>([])
  const [models, setModels] = useState<LiveModel[]>([])
  const [selected, setSelected] = useState("")
  const [attempt, setAttempt] = useState<Attempt | null>(null)
  const [code, setCode] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [repo, setRepo] = useState("")
  const [branch, setBranch] = useState("main")
  const [model, setModel] = useState("")
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const poll = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const authenticated = !!activeToken

  const refresh = useCallback(async (value: string) => {
    const next = await api<OnboardingStatus>(value, "/api/onboarding/status")
    setStatus(next)
    setRepo((current) => current || next.workspace.repo)
    setBranch((current) => current || next.workspace.branch)
    setModel((current) => current || next.model)
    return next
  }, [])

  const loadIntegrations = useCallback(
    async (value: string) => {
      try {
        const res = await api<{ data: Integration[] }>(value, "/api/onboarding/opencode/integrations")
        setIntegrations(res.data ?? [])
        setSelected((current) => current || res.data?.[0]?.id || "")
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not read providers")
      }
    },
    []
  )

  const loadModels = useCallback(async (value: string) => {
    try {
      const res = await api<{ data: LiveModel[] }>(value, "/api/onboarding/opencode/models")
      setModels((res.data ?? []).filter((item) => (item.type ?? "chat") === "chat" && item.enabled !== false))
    } catch {
      setModels([])
    }
  }, [])

  useEffect(() => {
    if (!token) return
    void (async () => {
      setBusy("load")
      setError("")
      try {
        const next = await refresh(token.trim())
        setActiveToken(token.trim())
        try {
          localStorage.setItem(TOKEN_KEY, token.trim())
        } catch {
          /* storage may be unavailable */
        }
        await Promise.all([loadIntegrations(token.trim()), loadModels(token.trim())])
        if (next.onboarding.completedAt) setMessage("This workspace is already set up.")
      } catch (cause) {
        setActiveToken("")
        setError(cause instanceof Error ? cause.message : "Could not reach Aboiteau")
      } finally {
        setBusy("")
      }
    })()
  }, [token, refresh, loadIntegrations, loadModels])

  useEffect(() => () => clearInterval(poll.current), [])

  const integration = useMemo(
    () => integrations.find((item) => item.id === selected),
    [integrations, selected]
  )

  async function beginOAuth() {
    if (!integration) return
    const method = integration.methods?.find((item) => item.type === "oauth")
    if (!method) {
      setError("This provider does not offer OAuth; paste an API key instead.")
      return
    }
    setBusy("oauth")
    setError("")
    try {
      const started = await api<{ data: Attempt }>(
        activeToken,
        `/api/onboarding/opencode/integrations/${encodeURIComponent(integration.id)}/connect/oauth`,
        { body: { methodID: method.id } }
      )
      const attempt = started.data
      setAttempt(attempt)
      window.open(attempt.url, "_blank", "noopener")
      clearInterval(poll.current)
      poll.current = setInterval(() => void checkAttempt(attempt.attemptID), 3000)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the sign-in")
    } finally {
      setBusy("")
    }
  }

  async function checkAttempt(attemptID: string) {
    if (!integration) return
    try {
      const res = await api<{ data: AttemptStatus }>(
        activeToken,
        `/api/onboarding/opencode/integrations/${encodeURIComponent(integration.id)}/connect/oauth/${encodeURIComponent(attemptID)}`
      )
      const state = res.data?.status
      if (state && state !== "pending") {
        clearInterval(poll.current)
        setAttempt(null)
        await loadIntegrations(activeToken)
        await refresh(activeToken)
        await loadModels(activeToken)
        if (state === "completed") {
          setMessage(`${integration.name} connected.`)
          setError("")
        } else {
          setError(res.data?.error?.message ?? `Sign-in ${state}`)
        }
      }
    } catch {
      /* keep polling */
    }
  }

  async function completeOAuth() {
    if (!integration || !attempt || !code.trim()) return
    setBusy("complete")
    try {
      await api(
        activeToken,
        `/api/onboarding/opencode/integrations/${encodeURIComponent(integration.id)}/connect/oauth/${encodeURIComponent(attempt.attemptID)}/complete`,
        { body: { code: code.trim() } }
      )
      setCode("")
      await checkAttempt(attempt.attemptID)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not finish the sign-in")
    } finally {
      setBusy("")
    }
  }

  async function connectKey() {
    if (!integration || !apiKey.trim()) return
    setBusy("key")
    setError("")
    try {
      await api(
        activeToken,
        `/api/onboarding/opencode/integrations/${encodeURIComponent(integration.id)}/connect/key`,
        { body: { key: apiKey.trim() } }
      )
      setApiKey("")
      await loadIntegrations(activeToken)
      await loadModels(activeToken)
      setMessage(`${integration.name} connected.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the key")
    } finally {
      setBusy("")
    }
  }

  async function connectGithub() {
    setBusy("github")
    setError("")
    try {
      const started = await api<{ url: string }>(activeToken, "/api/onboarding/github/start")
      window.location.assign(started.url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start GitHub sign-in")
      setBusy("")
    }
  }

  async function saveWorkspace() {
    setBusy("save")
    setError("")
    try {
      await api(activeToken, "/api/settings", {
        method: "PUT",
        body: { workspaceRepo: repo.trim(), workspaceBranch: branch.trim(), model: model.trim() },
      })
      await refresh(activeToken)
      setMessage("Workspace saved.")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the workspace")
    } finally {
      setBusy("")
    }
  }

  async function finish() {
    setBusy("finish")
    setError("")
    try {
      const res = await api<{ snapshot: boolean }>(activeToken, "/api/onboarding/finish", { body: {} })
      setMessage(
        res.snapshot
          ? "All set. New conversations inherit this connection."
          : "Saved. The first conversation will connect the provider again if needed."
      )
      await refresh(activeToken)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not finish setup")
    } finally {
      setBusy("")
    }
  }

  const providerConnected = !!status?.onboarding.opencodeConnectedAt || !!integration?.connections?.length
  const githubConnected = !!status?.onboarding.githubConnectedAt
  const workspaceSet = !!status?.workspace.repo

  if (!authenticated) {
    return (
      <main className="settings-main" id="main">
        <div className="page-heading">
          <BrandLockup />
          <h1>Get started</h1>
          <p className="lead">Connect Aboiteau to a model provider and a GitHub repository.</p>
        </div>
        <section className="settings-section">
          <div className="fields-grid">
            <div className="field field-wide" data-slot="field">
              <Field>
                <FieldLabel>API token</FieldLabel>
                <Input
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder="Bearer token from the deployment"
                />
                <FieldDescription>
                  The token is stored in this browser only. Find it in the deployment&rsquo;s secrets.
                </FieldDescription>
              </Field>
            </div>
          </div>
          <div className="save-footer">
            <Button onClick={() => setToken(token.trim())} isDisabled={!token.trim() || busy === "load"}>
              {busy === "load" ? "Checking…" : "Continue"}
            </Button>
          </div>
          {error ? (
            <Alert>
              <AlertTitle>Could not continue</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </section>
      </main>
    )
  }

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to setup
      </a>
      <header className="app-header">
        <div className="app-header-inner">
          <a className="brand-link" href="/" aria-label="Aboiteau">
            <BrandLockup />
          </a>
          <div className="header-context">
            <span className="header-label">Get started</span>
            <a href="/">Settings</a>
          </div>
        </div>
      </header>
      <main className="settings-main" id="main">
        <div className="page-heading">
          <p className="eyebrow">First run</p>
          <h1>Set up Aboiteau</h1>
          <p className="lead">
            Three connections and the harness is ready: a model provider, GitHub, and the repository the agent
            works in.
          </p>
        </div>

        {error ? (
          <Alert>
            <AlertTitle>Something needs attention</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {message ? (
          <Alert>
            <AlertTitle>Saved</AlertTitle>
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        ) : null}
        {status && !status.configured.vault ? (
          <Alert>
            <AlertTitle>Credential vault not configured</AlertTitle>
            <AlertDescription>
              Set the <code>VAULT_MASTER_KEY</code> secret (64 hex characters) before connecting accounts.
            </AlertDescription>
          </Alert>
        ) : null}

        <Step
          number="01"
          title="Connect a model provider"
          description="OpenCode stores the credential in this workspace; every conversation uses it."
          status={
            providerConnected
              ? { label: "connected", tone: "success" }
              : { label: "not connected", tone: "warning" }
          }
        >
          <div className="fields-grid">
            <div className="field field-wide" data-slot="field">
              <Field>
                <FieldLabel>Provider</FieldLabel>
                <NativeSelect
                  value={selected}
                  onChange={(event) => {
                    setSelected(event.target.value)
                    setAttempt(null)
                  }}
                >
                  {integrations.length === 0 ? <option value="">No providers found</option> : null}
                  {integrations.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.name}
                      {item.connections?.length ? " (connected)" : ""}
                    </option>
                  ))}
                </NativeSelect>
                <FieldDescription>
                  Providers come from the running OpenCode instance. Sign in with OAuth where offered, or paste a
                  key.
                </FieldDescription>
              </Field>
            </div>
          </div>
          <div className="connect-row">
            <Button onClick={beginOAuth} isDisabled={!integration || busy === "oauth"}>
              {busy === "oauth" ? "Opening…" : "Sign in"}
            </Button>
            <span className="connection-note">
              {attempt ? "Finish the sign-in in the new tab; this page updates automatically." : "Opens the provider’s sign-in page."}
            </span>
          </div>
          {attempt?.paste ? (
            <div className="fields-grid">
              <div className="field field-wide" data-slot="field">
                <Field>
                  <FieldLabel>Authorization code</FieldLabel>
                  <Input value={code} onChange={(event) => setCode(event.target.value)} placeholder="Paste the code" />
                  <FieldDescription>{attempt.instructions}</FieldDescription>
                </Field>
              </div>
            </div>
          ) : null}
          {attempt?.paste ? (
            <div className="connect-row">
              <Button onClick={completeOAuth} isDisabled={!code.trim() || busy === "complete"}>
                Complete sign-in
              </Button>
            </div>
          ) : null}
          <div className="runtime-divider" />
          <div className="fields-grid">
            <div className="field field-wide" data-slot="field">
              <Field>
                <FieldLabel>API key</FieldLabel>
                <Input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="Paste a key if the provider has no sign-in"
                />
              </Field>
            </div>
          </div>
          <div className="connect-row">
            <Button variant="outline" onClick={connectKey} isDisabled={!integration || !apiKey.trim() || busy === "key"}>
              Save key
            </Button>
          </div>
        </Step>

        <Step
          number="02"
          title="Connect GitHub"
          description="Used to clone the workspace repository, including private repositories."
          status={
            githubConnected
              ? { label: status?.onboarding.githubLogin ?? "connected", tone: "success" }
              : { label: "not connected", tone: "warning" }
          }
        >
          <div className="connect-row">
            <Button onClick={connectGithub} isDisabled={!status?.configured.github || busy === "github"}>
              {githubConnected ? "Reconnect GitHub" : "Connect GitHub"}
            </Button>
            <span className="connection-note">
              {status?.configured.github
                ? "OAuth App with repo access; the token is encrypted at rest."
                : "Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to enable this step."}
            </span>
          </div>
        </Step>

        <Step
          number="03"
          title="Choose the workspace"
          description="The repository the agent works in, and the model it uses."
          status={
            workspaceSet
              ? { label: "configured", tone: "success" }
              : { label: "repository required", tone: "warning" }
          }
        >
          <div className="fields-grid">
            <div className="field field-wide" data-slot="field">
              <Field>
                <FieldLabel>Repository URL</FieldLabel>
                <Input value={repo} onChange={(event) => setRepo(event.target.value)} placeholder="https://github.com/org/repo" />
              </Field>
            </div>
            <div className="field" data-slot="field">
              <Field>
                <FieldLabel>Branch</FieldLabel>
                <Input value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="main" />
              </Field>
            </div>
            <div className="field" data-slot="field">
              <Field>
                <FieldLabel>Model</FieldLabel>
                {models.length ? (
                  <NativeSelect value={model} onChange={(event) => setModel(event.target.value)}>
                    {models.map((item) => (
                      <option value={`${item.providerID}/${item.id}`} key={`${item.providerID}/${item.id}`}>
                        {item.name ?? item.id}
                      </option>
                    ))}
                  </NativeSelect>
                ) : (
                  <Input value={model} onChange={(event) => setModel(event.target.value)} placeholder="provider/model" />
                )}
                <FieldDescription>
                  {models.length ? "Live catalogue from the connected provider." : "Connect a provider to list its models."}
                </FieldDescription>
              </Field>
            </div>
          </div>
          <div className="connect-row">
            <Button onClick={saveWorkspace} isDisabled={!repo.trim() || busy === "save"}>
              {busy === "save" ? "Saving…" : "Save workspace"}
            </Button>
          </div>
        </Step>

        <Step
          number="04"
          title="Finish"
          description="Save the connected state so new conversations start ready."
          status={
            status?.onboarding.completedAt
              ? { label: "complete", tone: "success" }
              : { label: "not finished", tone: "neutral" }
          }
        >
          <div className="connect-row">
            <Button onClick={finish} isDisabled={!providerConnected || busy === "finish"}>
              {busy === "finish" ? "Saving…" : "Finish setup"}
            </Button>
            <span className="connection-note">
              {providerConnected
                ? "Snapshots provider credentials for future conversations."
                : "Connect a provider first."}
            </span>
          </div>
          <p className="connection-note">
            <a href="/">Go to settings</a>
          </p>
        </Step>
      </main>
    </>
  )
}
