import { useState, type ReactNode } from "react"
import {
  BrandLockup,
  Button,
  Checkbox,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  NativeSelect,
  Status,
  Textarea,
  Alert,
  AlertTitle,
  AlertDescription,
  type BrandAccent,
} from "@aboiteau/ui"
import { useSettings, ruleLines, type PermissionKind } from "./use-settings"

const sections: ReadonlyArray<{ id: string; number: string; title: string; accent: BrandAccent }> = [
  { id: "connection", number: "01", title: "Connection", accent: "ultramarine" },
  { id: "workspace", number: "02", title: "Workspace", accent: "vermilion" },
  { id: "model-runtime", number: "03", title: "Model & runtime", accent: "yellow" },
  { id: "permissions", number: "04", title: "Permissions", accent: "pink" },
]

function Section({
  id,
  number,
  accent,
  title,
  description,
  children,
}: {
  id: string
  number: string
  accent: BrandAccent
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section
      className="settings-section"
      id={id}
      data-accent={accent}
      aria-labelledby={id + "-heading"}
    >
      <div className="section-heading">
        <span className="section-number" aria-hidden="true">
          {number}
        </span>
        <div>
          <h2 id={id + "-heading"}>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      {children}
    </section>
  )
}

export function SettingsApp() {
  const state = useSettings()
  const { draft, update, pending } = state
  const { label: status, tone } = state.presentation
  const [customSelected, setCustomSelected] = useState(false)
  const knownModel = state.models.some((model) => model.ref === draft.model)
  const custom = customSelected || !knownModel
  const disabled = !state.authenticated || pending
  const groups = [...new Set(state.models.map((model) => model.providerID))]
  const recommended = state.models.find((model) => model.ref === state.recommended)
  const fieldError = (name: string) =>
    state.error?.scope === "save" && state.error.message.startsWith(name)
      ? state.error.message
      : undefined

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to settings
      </a>
      <header className="app-header">
        <div className="app-header-inner">
          <a className="brand-link" href="/" aria-label="Aboiteau settings">
            <BrandLockup />
          </a>
          <div className="header-context">
            <span className="header-label">Workspace settings</span>
            <span id="meta">{state.saved ? "v" + state.saved.version : "Not connected"}</span>
          </div>
        </div>
      </header>
      <div className="app-layout">
        <nav className="section-nav" aria-label="Settings sections">
          <p className="nav-label">Configure</p>
          {sections.map((section) => (
            <a href={"#" + section.id} key={section.id} data-accent={section.accent}>
              <span className="section-nav-number" aria-hidden="true">
                {section.number}
              </span>
              {section.title}
            </a>
          ))}
          <a className="gallery-link" href="/onboarding/">
            Get started <span aria-hidden="true">↗</span>
          </a>
          <a className="gallery-link" href="/ui-kit/">
            Aboiteau UI kit <span aria-hidden="true">↗</span></a
          >
        </nav>
        <main className="settings-main" id="main">
          <div className="page-heading">
            <p className="eyebrow">Your workspace. Your rules.</p>
            <h1>Settings</h1>
            <p className="lead">Choose how your coding agent works.</p>
            <nav className="heading-spectrum" aria-label="Jump to a settings section">
              {sections.map((section) => (
                <a key={section.id} href={"#" + section.id} data-accent={section.accent}>
                  <span className="heading-spectrum-chip" aria-hidden="true">
                    {section.number}
                  </span>
                  <span>{section.title}</span>
                </a>
              ))}
            </nav>
          </div>
          <Section
            id="connection"
            accent="ultramarine"
            number="01"
            title="Connection"
            description="Load the current settings for your deployment."
          >
            <div className="connect-row">
              <Field>
                <FieldLabel htmlFor="token">API token</FieldLabel>
                <Input
                  id="token"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={state.token}
                  onChange={(event) => state.setToken(event.target.value)}
                  disabled={pending}
                  aria-describedby="token-description"
                />
              </Field>
              <Button
                id="load"
                variant="outline"
                onPress={() => void state.load()}
                pending={state.status === "loading"}
                pendingLabel="Loading…"
                isDisabled={pending || state.dirty || !state.token.trim()}
              >
                Load settings
              </Button>
            </div>
            <p className="connection-note" id="token-description">
              Your token is remembered in this browser after a successful connection. Use a trusted
              device.{state.dirty ? " Save your changes before loading settings again." : ""}
            </p>
            {!state.storageAvailable && (
              <p className="connection-note">
                Browser storage is unavailable. You’ll need to enter your token again next time.
              </p>
            )}
            {state.error?.scope === "load" && (
              <Alert variant="destructive" className="connection-feedback">
                <AlertTitle>Couldn’t load settings</AlertTitle>
                <AlertDescription>{state.error.message}</AlertDescription>
              </Alert>
            )}
          </Section>
          <form
            id="settings"
            onSubmit={(event) => {
              event.preventDefault()
              void state.save()
            }}
          >
            <fieldset
              className="settings-fieldset"
              disabled={disabled}
              aria-label="Agent settings"
              aria-busy={state.status === "loading"}
            >
              <Section
                id="workspace"
                accent="vermilion"
                number="02"
                title="Workspace"
                description="The repository and branch your agent starts from."
              >
                <div className="fields-grid">
                  <Field className="field-wide">
                    <FieldLabel htmlFor="workspaceRepo">Repository URL</FieldLabel>
                    <Input
                      id="workspaceRepo"
                      type="url"
                      placeholder="https://github.com/your-team/your-repo"
                      autoComplete="off"
                      spellCheck={false}
                      value={draft.workspaceRepo}
                      onChange={(event) => update("workspaceRepo", event.target.value)}
                      required
                      aria-invalid={!!fieldError("workspaceRepo")}
                      aria-describedby={fieldError("workspaceRepo") ? "repo-error" : undefined}
                    />
                    {fieldError("workspaceRepo") && (
                      <p className="field-error" id="repo-error">
                        {fieldError("workspaceRepo")}
                      </p>
                    )}
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="workspaceBranch">Branch</FieldLabel>
                    <Input
                      id="workspaceBranch"
                      placeholder="main"
                      autoComplete="off"
                      spellCheck={false}
                      value={draft.workspaceBranch}
                      onChange={(event) => update("workspaceBranch", event.target.value)}
                      required
                      aria-invalid={!!fieldError("workspaceBranch")}
                      aria-describedby={fieldError("workspaceBranch") ? "branch-error" : undefined}
                    />
                    {fieldError("workspaceBranch") && (
                      <p className="field-error" id="branch-error">
                        {fieldError("workspaceBranch")}
                      </p>
                    )}
                  </Field>
                </div>
              </Section>
              <Section
                id="model-runtime"
                accent="yellow"
                number="03"
                title="Model & runtime"
                description="Choose a model and how you receive its progress."
              >
                <div className="fields-grid">
                  {state.catalogueAvailable && (
                    <Field className="field-wide">
                      <FieldLabel htmlFor="modelSelect">Model</FieldLabel>
                      <NativeSelect
                        id="modelSelect"
                        value={custom ? "__custom" : draft.model}
                        aria-describedby="modelHint"
                        onChange={(event) => {
                          const value = event.target.value
                          setCustomSelected(value === "__custom")
                          if (value !== "__custom") update("model", value)
                        }}
                      >
                        {groups.map((provider) => (
                          <optgroup key={provider} label={provider}>
                            {state.models
                              .filter((model) => model.providerID === provider)
                              .map((model) => (
                                <option key={model.ref} value={model.ref}>
                                  {model.name}
                                  {model.tags.length ? " · " + model.tags.join(" · ") : ""}
                                </option>
                              ))}
                          </optgroup>
                        ))}
                        <option value="__custom">Custom…</option>
                      </NativeSelect>
                      <FieldDescription id="modelHint">
                        {recommended
                          ? "Recommended: " + recommended.name
                          : "Choose from the catalogue or enter a custom model."}
                      </FieldDescription>
                    </Field>
                  )}
                  {(!state.catalogueAvailable || custom) && (
                    <Field className="field-wide" id="modelCustomWrap">
                      <FieldLabel htmlFor="modelCustom">
                        {state.catalogueAvailable ? "Custom model reference" : "Model reference"}
                      </FieldLabel>
                      <Input
                        id="modelCustom"
                        placeholder="provider/model"
                        value={draft.model}
                        onChange={(event) => update("model", event.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                        required
                        aria-describedby="custom-model-hint"
                        aria-invalid={!!fieldError("model")}
                      />
                      <FieldDescription id="custom-model-hint">
                        {state.loaded && !state.catalogueAvailable
                          ? "Model catalogue unavailable. Enter provider/model or provider/model#variant."
                          : "Use provider/model or provider/model#variant."}
                      </FieldDescription>
                      {fieldError("model") && <p className="field-error">{fieldError("model")}</p>}
                    </Field>
                  )}
                </div>
                <div className="runtime-grid">
                  <Field>
                    <FieldLabel htmlFor="pollSeconds">Poll interval</FieldLabel>
                    <Input
                      id="pollSeconds"
                      type="number"
                      inputMode="numeric"
                      min={2}
                      max={60}
                      step={1}
                      value={draft.pollSeconds}
                      onChange={(event) => update("pollSeconds", event.target.value)}
                      aria-describedby={
                        fieldError("pollSeconds") ? "poll-hint poll-error" : "poll-hint"
                      }
                      aria-invalid={!!fieldError("pollSeconds")}
                      required
                    />
                    <FieldDescription id="poll-hint">2–60 seconds</FieldDescription>
                    {fieldError("pollSeconds") && (
                      <p className="field-error" id="poll-error">
                        {fieldError("pollSeconds")}
                      </p>
                    )}
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="dailyBudgetUSD">Daily budget</FieldLabel>
                    <Input
                      id="dailyBudgetUSD"
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="0.01"
                      value={draft.dailyBudgetUSD}
                      onChange={(event) => update("dailyBudgetUSD", event.target.value)}
                      aria-describedby="budget-hint"
                    />
                    <FieldDescription id="budget-hint">
                      USD per day. 0 disables the cap. New turns are rejected once it is reached.
                    </FieldDescription>
                  </Field>
                  <div className="streaming-field">
                    <Checkbox
                      id="streaming"
                      isSelected={draft.streaming}
                      isDisabled={disabled}
                      onChange={(value) => update("streaming", value)}
                      aria-describedby="streaming-hint"
                    >
                      Stream progress
                    </Checkbox>
                    <p id="streaming-hint" className="streaming-description">
                      Show updates as they arrive. Falls back to polling when streaming is
                      unavailable.
                    </p>
                  </div>
                </div>
              </Section>
              <Section
                id="permissions"
                accent="pink"
                number="04"
                title="Permissions"
                description="Decide what your agent can run. One shell pattern per line."
              >
                <div className="permissions-grid">
                  {(["allow", "ask", "deny"] as PermissionKind[]).map((kind) => (
                    <Field key={kind}>
                      <div className="permission-label">
                        <FieldLabel htmlFor={kind}>
                          {kind === "allow" ? "Allow" : kind === "ask" ? "Ask" : "Deny"}
                        </FieldLabel>
                        <span className="rule-count" aria-hidden="true">
                          {ruleLines(draft.permissions[kind]).length} rules
                        </span>
                      </div>
                      <FieldDescription id={kind + "-hint"}>
                        {kind === "allow"
                          ? "Run without asking"
                          : kind === "ask"
                            ? "Ask for your approval"
                            : "Always block"}
                      </FieldDescription>
                      <Textarea
                        id={kind}
                        value={draft.permissions[kind]}
                        onChange={(event) =>
                          update("permissions", {
                            ...draft.permissions,
                            [kind]: event.target.value,
                          })
                        }
                        aria-describedby={kind + "-hint"}
                        spellCheck={false}
                        autoComplete="off"
                      />
                    </Field>
                  ))}
                </div>
                <p className="permission-note">
                  Workspace reads and edits, and web access, are always allowed. Edits outside the
                  workspace ask for approval. Access to <code>.ssh</code> and <code>.env</code> is
                  denied.
                </p>
              </Section>
            </fieldset>
          </form>
        </main>
      </div>
      <footer className="save-footer">
        <div className="save-footer-inner">
          <div className="save-feedback" role="status" aria-live="polite" aria-atomic="true">
            <Status id="status" tone={tone} className={tone === "error" ? "error" : undefined}>
              {status}
            </Status>
            <span className="save-hint">
              {state.loaded
                ? "Changes apply on the next turn. Your workspace is restored."
                : "Connect with your API token to get started."}
            </span>
          </div>
          <Button
            id="save"
            type="submit"
            form="settings"
            pending={state.status === "saving"}
            pendingLabel="Saving…"
            isDisabled={disabled}
          >
            Save settings
          </Button>
        </div>
        {state.error?.scope === "save" && (
          <p id="errorDetail" className="save-error" role="alert">
            {state.error.message}
          </p>
        )}
      </footer>
    </>
  )
}
