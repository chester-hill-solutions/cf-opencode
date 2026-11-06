import type { ComponentProps, ReactNode } from "react"

import { cn } from "../../lib/utils"

type ToolbarProps = ComponentProps<"div"> & {
  actions?: ReactNode
  variant?: "plain" | "muted"
}

function Toolbar({
  className,
  children,
  actions,
  variant = "plain",
  ...props
}: ToolbarProps) {
  return (
    <div
      data-slot="toolbar"
      role="group"
      data-variant={variant}
      className={cn(
        "flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:justify-between",
        variant === "muted" && "rounded-lg border bg-muted/30 p-3",
        className
      )}
      {...props}
    >
      <div
        data-slot="toolbar-content"
        className="flex min-w-0 flex-1 flex-wrap items-end gap-2 [&>*]:max-w-full"
      >
        {children}
      </div>
      {actions && (
        <div
          data-slot="toolbar-actions"
          className="flex min-w-0 flex-wrap items-center gap-2"
        >
          {actions}
        </div>
      )}
    </div>
  )
}

export { Toolbar, type ToolbarProps }
