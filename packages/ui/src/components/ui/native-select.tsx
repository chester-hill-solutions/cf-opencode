import type * as React from "react"
import { ChevronDownIcon } from "lucide-react"
import { cn } from "../../lib/utils"

/** Native select semantics, including form submission and platform pickers. */
function NativeSelect({
  className,
  wrapperClassName,
  children,
  ...props
}: React.ComponentProps<"select"> & { wrapperClassName?: string }) {
  return (
    <span
      data-slot="native-select-wrapper"
      className={cn(
        "relative inline-flex w-full max-w-full min-w-0",
        wrapperClassName
      )}
    >
      <select
        data-slot="native-select"
        className={cn(
          "min-h-8 w-full min-w-0 appearance-none rounded-md border border-input bg-background py-1.5 ps-3 pe-9 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50 aria-invalid:border-destructive pointer-coarse:min-h-11",
          props.multiple && "appearance-auto pe-3",
          className
        )}
        {...props}
      >
        {children}
      </select>
      {!props.multiple && (
        <ChevronDownIcon
          aria-hidden
          className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
      )}
    </span>
  )
}

export { NativeSelect }
