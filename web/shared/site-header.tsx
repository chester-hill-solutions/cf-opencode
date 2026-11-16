import { BrandLockup } from "@aboiteau/ui"
import type { ReactNode } from "react"

export type Page = "home" | "workspace" | "onboarding" | "settings" | "ui-kit"

const pages = [
  { id: "home", href: "/", label: "Overview" },
  { id: "workspace", href: "/workspace/", label: "Workspace" },
  { id: "onboarding", href: "/onboarding/", label: "Get started" },
  { id: "settings", href: "/settings/", label: "Settings" },
] as const

export function SiteHeader({ page, children }: { page: Page; children?: ReactNode }) {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <div className="app-header-inner">
          <a className="brand-link" href="/" aria-label="Aboiteau home">
            <BrandLockup />
          </a>
          <nav className="primary-nav" aria-label="Primary">
            {pages.map(({ id, href, label }) => (
              <a key={id} href={href} aria-current={page === id ? "page" : undefined}>
                {label}
              </a>
            ))}
          </nav>
          {children ? <div className="header-context">{children}</div> : null}
        </div>
      </header>
    </>
  )
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <a href="/" className="brand-link">
        <BrandLockup />
      </a>
      <p>A persistent workspace for the work ahead.</p>
      <nav aria-label="Resources">
        <a href="/onboarding/">Get started</a>
        <a href="/ui-kit/">Design system</a>
        <a href="https://github.com/chester-hill-solutions/cf-opencode">Source & documentation ↗</a>
      </nav>
    </footer>
  )
}
