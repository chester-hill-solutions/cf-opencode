import { createRoot } from "react-dom/client"
import { useState } from "react"
import {
  BrandLockup,
  InkField,
  Logo,
  brandColors,
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
} from "@aboiteau/ui"

function UiKit() {
  const [selected, setSelected] = useState(true)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState("Ready to try")
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to UI kit
      </a>
      <header className="app-header">
        <div className="app-header-inner">
          <a className="brand-link" href="/" aria-label="Aboiteau settings">
            <BrandLockup />
          </a>
          <a href="/">Back to settings</a>
        </div>
      </header>
      <main className="catalog" id="main">
        <p className="eyebrow">Aboiteau / UI kit / 0.1</p>
        <h1>Room to build.</h1>
        <p className="catalog-intro">
          A warm, expressive identity with a clear working surface. The same components, tokens and
          brand assets used by the settings page live here.
        </p>
        <section className="catalog-section" aria-labelledby="identity-title">
          <h2 id="identity-title">Identity</h2>
          <div className="specimen-grid">
            <div className="logo-specimen">
              <BrandLockup />
            </div>
            <div className="logo-specimen reversed">
              <BrandLockup />
            </div>
          </div>
          <div className="specimen-row" style={{ marginTop: "1.5rem" }}>
            <Logo style={{ width: "4.5rem", height: "4rem" }} />
            <Logo style={{ width: "2rem", height: "1.75rem" }} />
            <Logo style={{ width: "1.5rem", height: "1.3125rem" }} />
            <p className="catalog-note">
              One mark, in one ink. Keep the open diagonal cut clear at every size.
            </p>
          </div>
          <div className="catalog-art">
            <InkField />
          </div>
          <p className="catalog-note">
            Broad ink fields for expressive surfaces. Yellow is a swatch. Keep reading and controls
            on quiet, solid surfaces.
          </p>
        </section>
        <section className="catalog-section" aria-labelledby="color-title">
          <h2 id="color-title">Colour</h2>
          <div className="swatch-grid">
            {Object.entries(brandColors).map(([name, value]) => (
              <div key={name}>
                <div className="swatch-block" style={{ background: value }} />
                <div className="swatch-name">{name}</div>
                <div className="swatch-hex">{value}</div>
              </div>
            ))}
          </div>
          <p className="catalog-note">
            Ultramarine carries actions. Ink carries reading. Vermilion, yellow and pink belong to
            the art; semantic success and error colours remain separate.
          </p>
        </section>
        <section className="catalog-section" aria-labelledby="type-title">
          <h2 id="type-title">Typography</h2>
          <p
            style={{
              fontSize: "clamp(2rem, 5vw, 3.5rem)",
              fontWeight: 800,
              letterSpacing: "-.055em",
              lineHeight: 1.1,
            }}
          >
            Coding agents. On your terms.
          </p>
          <p style={{ maxWidth: "40rem", marginTop: "1.25rem" }}>
            DM Sans is the working type family: confident headings, open labels and comfortable
            reading. Monospace is reserved for code, references and small technical details.
          </p>
          <p className="catalog-note">
            Self-hosted variable font, weights 100–1000. Source and licence are included with the
            build.
          </p>
        </section>
        <section className="catalog-section" aria-labelledby="action-title">
          <h2 id="action-title">Actions</h2>
          <div className="specimen-row">
            <Button onPress={() => setMessage("Primary action selected")}>Primary action</Button>
            <Button variant="outline" onPress={() => setMessage("Secondary action selected")}>
              Secondary action
            </Button>
            <Button variant="ghost" onPress={() => setMessage("Quiet action selected")}>
              Quiet action
            </Button>
            <Button isDisabled>Unavailable</Button>
            <Button
              pending={pending}
              pendingLabel="Saving…"
              onPress={() => {
                setPending(true)
                setMessage("Saving example…")
                window.setTimeout(() => {
                  setPending(false)
                  setMessage("Example saved")
                }, 1200)
              }}
            >
              Try pending state
            </Button>
          </div>
          <p className="catalog-note" role="status" aria-live="polite">
            {message}
          </p>
        </section>
        <section className="catalog-section" aria-labelledby="form-title">
          <h2 id="form-title">Fields & controls</h2>
          <div className="specimen-grid">
            <Field>
              <FieldLabel htmlFor="example-repository">Repository URL</FieldLabel>
              <Input
                id="example-repository"
                placeholder="https://github.com/your-team/your-repo"
                aria-describedby="example-description"
              />
              <FieldDescription id="example-description">
                Labels stay visible. Help sits beside the field it explains.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="example-select">Model</FieldLabel>
              <NativeSelect id="example-select">
                <option>Recommended model</option>
                <option>Another model</option>
                <option>Custom…</option>
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="example-rules">Shell patterns</FieldLabel>
              <Textarea
                id="example-rules"
                defaultValue={"git status *\nbun test *"}
                spellCheck={false}
              />
            </Field>
            <div>
              <Checkbox isSelected={selected} onChange={setSelected}>
                Stream progress
              </Checkbox>
              <Checkbox isDisabled>Unavailable option</Checkbox>
              <Field style={{ marginTop: "1rem" }}>
                <FieldLabel htmlFor="example-error">Model reference</FieldLabel>
                <Input
                  id="example-error"
                  defaultValue="missing-provider"
                  aria-invalid="true"
                  aria-describedby="example-error-message"
                />
                <p id="example-error-message" className="field-error">
                  Enter a reference in provider/model format.
                </p>
              </Field>
            </div>
          </div>
        </section>
        <section className="catalog-section" aria-labelledby="status-title">
          <h2 id="status-title">Status & feedback</h2>
          <div className="specimen-row">
            <Status>Not loaded</Status>
            <Status tone="success">Saved</Status>
            <Status tone="warning">Unsaved changes</Status>
            <Status tone="busy">Saving…</Status>
            <Status tone="error">Save failed</Status>
          </div>
          <div className="specimen-grid" style={{ marginTop: "1.5rem" }}>
            <Alert variant="info" role="note">
              <AlertTitle>Changes apply on the next turn</AlertTitle>
              <AlertDescription>
                Your workspace is restored when the container restarts.
              </AlertDescription>
            </Alert>
            <Alert variant="destructive" role="note">
              <AlertTitle>Couldn’t save settings</AlertTitle>
              <AlertDescription>
                Your changes are still here. Check the connection and try again.
              </AlertDescription>
            </Alert>
          </div>
          <p className="catalog-note">
            Status is always written out. Colour supports the label; it never replaces it.
          </p>
        </section>
      </main>
    </>
  )
}

createRoot(document.getElementById("root")!).render(<UiKit />)
