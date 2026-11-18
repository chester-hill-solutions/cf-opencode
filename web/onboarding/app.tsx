import type { ReactNode } from "react"
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  LinkButton,
  NativeSelect,
  Status,
  type BrandAccent,
  type StatusTone,
} from "@aboiteau/ui"
import { SiteHeader } from "../shared/site-header"
import { TokenForm } from "../shared/token-form"
import { useOnboarding } from "./use-onboarding"

const steps = [
  { number: "01", title: "Provider", accent: "ultramarine" },
  { number: "02", title: "GitHub", accent: "vermilion" },
  { number: "03", title: "Workspace", accent: "yellow" },
  { number: "04", title: "Finish", accent: "pink" },
] as const

function Step({
  number,
  title,
  accent,
  description,
  status,
  children,
}: {
  number: string
  title: string
  accent: BrandAccent
  description: string
  status: { label: string; tone: StatusTone }
  children: ReactNode
}) {
  return (
    <section
      className="settings-section setup-step"
      id={`step-${number}`}
      data-accent={accent}
      aria-labelledby={`step-${number}-heading`}
    >
      <div className="section-heading">
        <span className="section-number" aria-hidden="true">
          {number}
        </span>
        <div>
          <h2 id={`step-${number}-heading`}>{title}</h2>
          <p>{description}</p>
        </div>
        <Status tone={status.tone}>{status.label}</Status>
      </div>
      {children}
    </section>
  )
}

export function OnboardingApp() {
  const s = useOnboarding()
  const canOAuth = s.integration?.methods?.some((method) => method.type === "oauth")
  const canKey = s.integration?.methods?.some((method) => method.type === "key")
  const githubConnected = !!s.status?.secrets.github
  const currentModel = s.models.some((item) => `${item.providerID}/${item.id}` === s.draft.model)

  return (
    <>
      <SiteHeader page="onboarding" />
      <main id="main" className="content-layout setup-layout">
        <div className="page-heading">
          <p className="eyebrow">Your workspace / First run</p>
          <h1>Make yourself at home.</h1>
          <p className="lead">
            Connect a model provider, choose a repository, and give your agent a place to work.
          </p>
        </div>
        <div className="setup-feedback">
          {s.error && (
            <Alert variant="destructive" role="alert">
              <AlertTitle>Something needs attention</AlertTitle>
              <AlertDescription>{s.error}</AlertDescription>
            </Alert>
          )}
          {s.message && (
            <Alert role="status">
              <AlertTitle>Setup status</AlertTitle>
              <AlertDescription>{s.message}</AlertDescription>
            </Alert>
          )}
          {s.storageNote && (
            <p className="connection-note" role="status">
              {s.storageNote}
            </p>
          )}
        </div>
        {!s.authenticated ? (
          <section className="settings-section token-section" aria-labelledby="connect-heading">
            <h2 id="connect-heading">Connect your deployment</h2>
            <p className="section-description">
              Enter your deployment’s API token to load its existing connections and settings.
            </p>
            <TokenForm
              token={s.token}
              setToken={s.setToken}
              connect={() => void s.connect()}
              pending={s.pending}
              label="Continue setup"
            />
          </section>
        ) : (
          <>
            <nav className="heading-spectrum setup-progress" aria-label="Setup steps">
              {steps.map((step) => (
                <a href={`#step-${step.number}`} key={step.number} data-accent={step.accent}>
                  <span className="heading-spectrum-chip" aria-hidden="true">
                    {step.number}
                  </span>
                  {step.title}
                </a>
              ))}
            </nav>
            {s.status && !s.status.configured.vault && (
              <Alert className="setup-notice">
                <AlertTitle>Credential vault not configured</AlertTitle>
                <AlertDescription>
                  Set the deployment’s <code>VAULT_MASTER_KEY</code> before connecting accounts.
                  Provider credentials cannot be checkpointed securely without it.
                </AlertDescription>
              </Alert>
            )}
            <fieldset className="settings-fieldset" disabled={s.pending} aria-busy={s.pending}>
              <legend className="sr-only">Deployment setup</legend>
              <Step
                number="01"
                accent="ultramarine"
                title="Connect a model provider"
                description="A dedicated provider API key is recommended for shared Slack access."
                status={
                  s.providerConnected
                    ? { label: "Connected", tone: "success" }
                    : { label: "Not connected", tone: "warning" }
                }
              >
                <Field>
                  <FieldLabel htmlFor="provider">Provider</FieldLabel>
                  <NativeSelect
                    id="provider"
                    name="provider"
                    value={s.selected}
                    onChange={(event) => s.selectProvider(event.target.value)}
                    disabled={!!s.attempt}
                  >
                    {!s.integrations.length && <option value="">No providers found</option>}
                    {s.integrations.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                        {item.connections?.length ? " (connected)" : ""}
                      </option>
                    ))}
                  </NativeSelect>
                  <FieldDescription>
                    Connection methods are supplied by the running OpenCode instance.
                  </FieldDescription>
                </Field>
                <div className="setup-actions">
                  <Button
                    variant="outline"
                    onPress={() => void s.retryProviders()}
                    isDisabled={s.pending || !!s.attempt}
                  >
                    Refresh providers
                  </Button>
                </div>
                {s.catalogueNote && (
                  <p className="connection-note" role="status">
                    {s.catalogueNote}
                  </p>
                )}
                {canOAuth && (
                  <div className="setup-actions">
                    <Button
                      onPress={() => void s.beginOAuth()}
                      isDisabled={s.pending || !!s.attempt}
                    >
                      Sign in with {s.integration?.name}
                    </Button>
                    <span className="connection-note">Opens the provider in a new tab.</span>
                  </div>
                )}
                {s.attempt && (
                  <div className="oauth-panel">
                    <Status tone="busy">Waiting for provider sign-in</Status>
                    <p>
                      {s.attempt.instructions ||
                        "Complete sign-in with your provider, then return here."}
                    </p>
                    <a href={s.attempt.url} target="_blank" rel="noopener noreferrer">
                      Open provider sign-in ↗
                    </a>
                    {s.attempt.paste && (
                      <form
                        onSubmit={(event) => {
                          event.preventDefault()
                          void s.completeOAuth()
                        }}
                      >
                        <Field>
                          <FieldLabel htmlFor="auth-code">Authorization code (required)</FieldLabel>
                          <Input
                            id="auth-code"
                            name="code"
                            required
                            autoComplete="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            value={s.code}
                            onChange={(event) => s.setCode(event.target.value)}
                          />
                        </Field>
                        <Button
                          type="submit"
                          pending={s.phase === "complete-oauth"}
                          pendingLabel="Completing…"
                        >
                          Complete sign-in
                        </Button>
                      </form>
                    )}
                    <div className="setup-actions">
                      <Button
                        variant="outline"
                        onPress={() => void s.checkSignIn()}
                        isDisabled={s.pending}
                      >
                        Check sign-in status
                      </Button>
                      <Button variant="ghost" onPress={s.cancelAttempt} isDisabled={s.pending}>
                        Stop checking
                      </Button>
                    </div>
                  </div>
                )}
                {canKey && !s.attempt && (
                  <form
                    className="setup-form"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void s.connectKey()
                    }}
                  >
                    <Field>
                      <FieldLabel htmlFor="provider-key">Provider API key (required)</FieldLabel>
                      <Input
                        id="provider-key"
                        name="key"
                        type="password"
                        required
                        autoComplete="off"
                        spellCheck={false}
                        value={s.apiKey}
                        onChange={(event) => s.setApiKey(event.target.value)}
                      />
                      <FieldDescription>
                        The key is sent to your deployment. It is cleared from this form after
                        connection.
                      </FieldDescription>
                    </Field>
                    <Button
                      variant="outline"
                      type="submit"
                      pending={s.phase === "connect-key"}
                      pendingLabel="Connecting…"
                    >
                      Connect with API key
                    </Button>
                  </form>
                )}
                {!!s.integration && !canOAuth && !canKey && (
                  <p className="connection-note">
                    This provider has no browser connection method. Choose another provider or
                    configure its connection in your deployment, then refresh providers.
                  </p>
                )}
              </Step>
              <Step
                number="02"
                accent="vermilion"
                title="Connect GitHub"
                description="Connect an account for private repositories. Public repositories can skip this step."
                status={
                  githubConnected
                    ? {
                        label: `Connected${s.status?.onboarding.githubLogin ? " · " + s.status.onboarding.githubLogin : ""}`,
                        tone: "success",
                      }
                    : { label: "Optional for public repos", tone: "neutral" }
                }
              >
                <div className="setup-actions">
                  <Button
                    onPress={() => void s.connectGithub()}
                    pending={s.phase === "connect-github"}
                    pendingLabel="Opening GitHub…"
                    isDisabled={
                      s.pending || !s.status?.configured.github || !s.status?.configured.vault
                    }
                  >
                    {githubConnected ? "Reconnect GitHub" : "Connect GitHub"}
                  </Button>
                </div>
                <p className="connection-note">
                  {s.status?.configured.github
                    ? "GitHub authorizes repository access. Your workspace draft is kept in this browser while you sign in."
                    : "GitHub sign-in is not configured on this deployment. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to enable it."}
                </p>
              </Step>
              <Step
                number="03"
                accent="yellow"
                title="Choose the workspace"
                description="Optionally pin a repository for every new conversation; otherwise bind one per conversation."
                status={
                  s.workspaceSaved
                    ? { label: "Saved", tone: "success" }
                    : { label: "Save required", tone: "warning" }
                }
              >
                <form
                  className="setup-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void s.saveWorkspace()
                  }}
                >
                  <div className="fields-grid">
                    <Field className="field-wide">
                      <FieldLabel htmlFor="setup-repo">Repository URL (optional)</FieldLabel>
                      <Input
                        id="setup-repo"
                        name="repository"
                        type="url"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="https://github.com/your-team/your-repo"
                        value={s.draft.repo}
                        onChange={(event) => s.update("repo", event.target.value)}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="setup-branch">Branch (required)</FieldLabel>
                      <Input
                        id="setup-branch"
                        name="branch"
                        required
                        autoComplete="off"
                        spellCheck={false}
                        value={s.draft.branch}
                        onChange={(event) => s.update("branch", event.target.value)}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="setup-model">Model (required)</FieldLabel>
                      {s.models.length ? (
                        <NativeSelect
                          id="setup-model"
                          name="model"
                          required
                          value={s.draft.model}
                          onChange={(event) => s.update("model", event.target.value)}
                        >
                          {!currentModel && (
                            <option value={s.draft.model}>
                              {s.draft.model || "Choose a model"}
                            </option>
                          )}
                          {s.models.map((item) => (
                            <option
                              key={`${item.providerID}/${item.id}`}
                              value={`${item.providerID}/${item.id}`}
                            >
                              {item.providerID} / {item.name ?? item.id}
                            </option>
                          ))}
                        </NativeSelect>
                      ) : (
                        <Input
                          id="setup-model"
                          name="model"
                          required
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="provider/model"
                          value={s.draft.model}
                          onChange={(event) => s.update("model", event.target.value)}
                        />
                      )}
                    </Field>
                  </div>
                  <Button
                    type="submit"
                    pending={s.phase === "save-workspace"}
                    pendingLabel="Saving workspace…"
                    isDisabled={s.pending}
                  >
                    Save workspace
                  </Button>
                </form>
              </Step>
              <Step
                number="04"
                accent="pink"
                title="Finish setup"
                description="Checkpoint the provider connection for future conversations."
                status={
                  s.status?.onboarding.completedAt
                    ? { label: "Setup completed", tone: "success" }
                    : { label: "Not finished", tone: "neutral" }
                }
              >
                <p className="section-description">
                  {!s.providerConnected
                    ? "Connect a provider before finishing."
                    : !s.workspaceSaved
                      ? "Save your workspace before finishing."
                      : "Your provider is connected and your workspace settings are saved."}
                </p>
                <div className="setup-actions">
                  <Button
                    onPress={() => void s.finish()}
                    pending={s.phase === "finish"}
                    pendingLabel="Finishing setup…"
                    isDisabled={s.pending || !s.providerConnected || !s.workspaceSaved}
                  >
                    Finish setup
                  </Button>
                  {s.status?.onboarding.completedAt && (
                    <LinkButton href="/workspace/" variant="outline">
                      Open workspace →
                    </LinkButton>
                  )}
                </div>
              </Step>
            </fieldset>
            {s.pending && (
              <p className="setup-operation" role="status">
                {s.phase === "loading-status"
                  ? "Loading connections. The runtime may take a moment to start…"
                  : "Updating your deployment…"}
              </p>
            )}
          </>
        )}
      </main>
    </>
  )
}
