import { createRoot } from "react-dom/client"
import { BrandLockup, UiI18nProvider } from "@aboiteau/ui"
import { Actions } from "./ui-kit/actions"
import { DataDisplay } from "./ui-kit/data"
import { Foundations } from "./ui-kit/foundations"
import { Inputs } from "./ui-kit/forms"
import { Navigation } from "./ui-kit/navigation"
import { Overlays } from "./ui-kit/overlays"
import { Structure } from "./ui-kit/structure"
import type { BrandAccent } from "@aboiteau/ui"

const sections: ReadonlyArray<{ id: string; number: string; label: string; accent: BrandAccent }> = [
  { id: "identity", number: "01", label: "Identity", accent: "ultramarine" },
  { id: "colour", number: "02", label: "Colour", accent: "pink" },
  { id: "typography", number: "03", label: "Typography", accent: "ink" },
  { id: "actions", number: "04", label: "Actions", accent: "ultramarine" },
  { id: "inputs", number: "05", label: "Forms", accent: "vermilion" },
  { id: "navigation", number: "06", label: "Navigation", accent: "yellow" },
  { id: "overlays", number: "07", label: "Overlays", accent: "pink" },
  { id: "data", number: "08", label: "Data", accent: "vermilion" },
  { id: "structure", number: "09", label: "Structure", accent: "ink" },
]

function UiKit() {
  return (
    <UiI18nProvider locale="en-CA">
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
        <p className="eyebrow">Aboiteau / UI kit / 0.4</p>
        <h1>Room to build.</h1>
        <p className="catalog-intro">
          A warm, expressive identity with a clear working surface. Every component, token and brand
          asset from <code>@aboiteau/ui</code> lives here, so the settings page, the onboarding wizard
          and this gallery cannot drift apart.
        </p>
        <nav className="catalog-nav" aria-label="UI kit sections">
          {sections.map((section) => (
            <a key={section.id} href={`#${section.id}`} data-accent={section.accent}>
              <span aria-hidden="true">{section.number}</span>
              {section.label}
            </a>
          ))}
        </nav>
        <Foundations />
        <Actions />
        <Inputs />
        <Navigation />
        <Overlays />
        <DataDisplay />
        <Structure />
      </main>
    </UiI18nProvider>
  )
}

createRoot(document.getElementById("root")!).render(<UiKit />)
