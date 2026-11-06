import type { ComponentProps, ReactNode } from "react"

import { cn } from "../../lib/utils"

type PageHeaderProps = Omit<ComponentProps<"header">, "title"> & {
  title: ReactNode
  description?: ReactNode
  eyebrow?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  back?: ReactNode
  headingLevel?: "h1" | "h2"
  density?: "default" | "compact"
}

function PageHeader({
  title,
  description,
  eyebrow,
  meta,
  actions,
  back,
  headingLevel: Heading = "h1",
  density = "default",
  className,
  children,
  ...props
}: PageHeaderProps) {
  return (
    <header
      data-slot="page-header"
      data-density={density}
      className={cn(
        "grid min-w-0 gap-3",
        density === "compact" && "gap-2",
        className
      )}
      {...props}
    >
      {back && <div data-slot="page-header-back">{back}</div>}
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="grid min-w-0 gap-1">
          {eyebrow && (
            <div
              data-slot="page-header-eyebrow"
              className="text-xs font-medium text-muted-foreground"
            >
              {eyebrow}
            </div>
          )}
          <Heading
            data-slot="page-header-title"
            className={cn(
              "text-2xl font-semibold tracking-tight break-words",
              density === "compact" && "text-lg"
            )}
          >
            {title}
          </Heading>
          {description && (
            <div
              data-slot="page-header-description"
              className="max-w-prose text-sm text-muted-foreground"
            >
              {description}
            </div>
          )}
          {meta && (
            <div
              data-slot="page-header-meta"
              className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
            >
              {meta}
            </div>
          )}
        </div>
        {actions && (
          <div
            data-slot="page-header-actions"
            className="flex min-w-0 flex-wrap items-center gap-2 [&>*]:max-w-full"
          >
            {actions}
          </div>
        )}
      </div>
      {children}
    </header>
  )
}

export { PageHeader, type PageHeaderProps }
