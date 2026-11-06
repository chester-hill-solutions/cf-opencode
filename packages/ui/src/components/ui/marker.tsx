import type { ComponentProps, ReactNode } from "react"
import { cn } from "../../lib/utils"

export type MarkerProps = ComponentProps<"div"> & {
  variant?: "note" | "status" | "separator" | "bordered"
  icon?: ReactNode
}

export function Marker({
  variant = "note",
  icon,
  children,
  className,
  ...props
}: MarkerProps) {
  return (
    <div
      data-slot="marker"
      data-variant={variant}
      role={variant === "status" ? "status" : undefined}
      className={cn(
        "flex min-w-0 items-center gap-2 py-2 text-xs text-muted-foreground",
        variant === "bordered" && "rounded-md border border-border px-3",
        variant === "separator" &&
          "before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border",
        className
      )}
      {...props}
    >
      {icon && (
        <span aria-hidden="true" className="shrink-0">
          {icon}
        </span>
      )}
      <span className="break-words">{children}</span>
    </div>
  )
}
