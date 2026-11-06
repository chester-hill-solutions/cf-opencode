import type { ReactNode } from "react"
import { cn } from "@aboiteau/ui"

/** A titled band in the live gallery. Mirrors the settings page's section rhythm. */
export function GallerySection({
  id,
  title,
  description,
  children,
}: {
  id: string
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <section id={id} className="catalog-section" aria-labelledby={`${id}-title`}>
      <div className="catalog-section-heading">
        <h2 id={`${id}-title`}>{title}</h2>
        {description ? <p className="catalog-section-description">{description}</p> : null}
      </div>
      <div className="component-grid">{children}</div>
    </section>
  )
}

/** One named component with a quiet surface around its live specimen. */
export function Demo({
  name,
  note,
  children,
  wide,
  surface = true,
}: {
  name: string
  note?: ReactNode
  children: ReactNode
  wide?: boolean
  surface?: boolean
}) {
  return (
    <article className={cn("component-demo", wide && "component-demo-wide")}>
      <header className="component-demo-header">
        <h3>{name}</h3>
        {note ? <p>{note}</p> : null}
      </header>
      <div className={cn(surface && "component-demo-surface")}>{children}</div>
    </article>
  )
}

/** A horizontal group of specimens with consistent wrapping. */
export function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("specimen-row", className)}>{children}</div>
}

/** A stack for tall specimens such as sidebars and message lists. */
export function Stack({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("specimen-stack", className)}>{children}</div>
}
