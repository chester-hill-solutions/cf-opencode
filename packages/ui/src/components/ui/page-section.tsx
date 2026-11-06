import { useId, type ComponentProps, type ReactNode } from "react"

import { cn } from "../../lib/utils"

type PageSectionProps = Omit<ComponentProps<"section">, "title"> & {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  headingLevel?: "h2" | "h3" | "h4"
  variant?: "plain" | "card" | "divided"
}

function PageSection({
  title,
  description,
  actions,
  headingLevel: Heading = "h2",
  variant = "plain",
  className,
  children,
  ...props
}: PageSectionProps) {
  const headingId = useId()
  return (
    <section
      data-slot="page-section"
      data-variant={variant}
      aria-labelledby={title ? headingId : undefined}
      className={cn(
        "grid min-w-0 gap-4",
        variant === "card" &&
          "rounded-lg border bg-card p-4 text-card-foreground",
        variant === "divided" && "border-b pb-6 last:border-b-0",
        className
      )}
      {...props}
    >
      {(title || description || actions) && (
        <header
          data-slot="page-section-header"
          className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
        >
          <div className="grid min-w-0 gap-1">
            {title && (
              <Heading
                id={headingId}
                data-slot="page-section-title"
                className="text-sm font-semibold break-words"
              >
                {title}
              </Heading>
            )}
            {description && (
              <div
                data-slot="page-section-description"
                className="max-w-prose text-sm text-muted-foreground"
              >
                {description}
              </div>
            )}
          </div>
          {actions && (
            <div
              data-slot="page-section-actions"
              className="flex min-w-0 flex-wrap items-center gap-2"
            >
              {actions}
            </div>
          )}
        </header>
      )}
      {children}
    </section>
  )
}

export { PageSection, type PageSectionProps }
