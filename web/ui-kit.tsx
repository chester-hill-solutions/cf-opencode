import { createRoot } from "react-dom/client"
import { BrandLockup, UiI18nProvider } from "@aboiteau/ui"
import { Actions } from "./ui-kit/actions"
import { DataDisplay } from "./ui-kit/data"
import { Foundations } from "./ui-kit/foundations"
import { Inputs } from "./ui-kit/forms"
import { Navigation } from "./ui-kit/navigation"
import { Overlays } from "./ui-kit/overlays"
import { Structure } from "./ui-kit/structure"

const sections = [
  ["identity", "Identity"],
  ["colour", "Colour"],
  ["typography", "Typography"],
  ["actions", "Actions"],
  ["inputs", "Forms"],
  ["navigation", "Navigation"],
  ["overlays", "Overlays"],
  ["data", "Data"],
  ["structure", "Structure"],
] as const

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
          {sections.map(([id, label]) => (
            <a key={id} href={`#${id}`}>
              {label}
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
