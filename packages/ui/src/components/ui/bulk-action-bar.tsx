import type { ComponentProps, ReactNode } from "react"

import { cn } from "../../lib/utils"
import { Button } from "./button"
import { useUiI18n } from "./i18n"

type BulkActionBarProps = Omit<ComponentProps<"div">, "children"> & {
  count: number
  actions?: ReactNode
  onClear?: () => void
  isPending?: boolean
  isDisabled?: boolean
  hideWhenEmpty?: boolean
  label?: string
  countLabel?: (count: number) => ReactNode
  clearLabel?: ReactNode
}

/** Hosts own selection and must pass pending/disabled state into their action slots. */
function BulkActionBar({
  count,
  actions,
  onClear,
  isPending = false,
  isDisabled = false,
  hideWhenEmpty = true,
  label,
  countLabel,
  clearLabel,
  className,
  ...props
}: BulkActionBarProps) {
  const { t, formatNumber } = useUiI18n()
  if (hideWhenEmpty && count <= 0) return null
  return (
    <div
      data-slot="bulk-action-bar"
      role="group"
      aria-label={label ?? t("bulkActions")}
      aria-busy={isPending || undefined}
      data-disabled={isDisabled || undefined}
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-3 rounded-lg border bg-muted/40 p-3",
        className
      )}
      {...props}
    >
      <div
        data-slot="bulk-action-bar-count"
        role="status"
        aria-atomic="true"
        className="min-w-0 text-sm font-medium break-words"
      >
        {countLabel?.(count) ??
          t("selectedCount", { count: formatNumber(count) })}
      </div>
      <div
        data-slot="bulk-action-bar-actions"
        className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:ms-auto sm:w-auto [&>*]:max-w-full"
      >
        {actions}
        {onClear && (
          <Button
            variant="ghost"
            className="h-auto min-h-8 max-w-full whitespace-normal pointer-coarse:min-h-11"
            isDisabled={isDisabled || isPending || count <= 0}
            onPress={onClear}
          >
            {clearLabel ?? t("clearSelection")}
          </Button>
        )}
      </div>
    </div>
  )
}

export { BulkActionBar, type BulkActionBarProps }
