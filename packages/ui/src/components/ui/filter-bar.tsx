import {
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
} from "react"
import { XIcon } from "lucide-react"

import { cn } from "../../lib/utils"
import { Button } from "./button"
import { Toolbar } from "./toolbar"
import { useUiI18n } from "./i18n"

type ActiveFilter = { id: string; label: string }
type PendingFilterFocus = {
  ids: readonly string[]
  index: number
  trigger: Element
}
type FilterBarProps = Omit<
  ComponentProps<"div">,
  "children" | "onRemove" | "ref"
> & {
  activeFilters: readonly ActiveFilter[]
  onRemove: (id: string) => void
  onClear?: () => void
  controls?: ReactNode
  actions?: ReactNode
  isDisabled?: boolean
  label?: string
  clearLabel?: ReactNode
  removeLabel?: (filter: ActiveFilter) => string
}

/** Controlled filter presentation. The host owns query state and slot behavior. */
function FilterBar({
  activeFilters,
  onRemove,
  onClear,
  controls,
  actions,
  isDisabled = false,
  label,
  clearLabel,
  removeLabel,
  className,
  ...props
}: FilterBarProps) {
  const { t } = useUiI18n()
  const root = useRef<HTMLDivElement>(null)
  const controlsRoot = useRef<HTMLDivElement>(null)
  const clear = useRef<HTMLButtonElement>(null)
  const pendingFocus = useRef<PendingFilterFocus | null>(null)
  useLayoutEffect(() => {
    const pending = pendingFocus.current
    if (!pending) return
    const active = document.activeElement
    if (active && active !== document.body && active !== pending.trigger) {
      pendingFocus.current = null
      return
    }
    if (activeFilters.some((filter) => pending.ids.includes(filter.id))) return
    pendingFocus.current = null
    const removers = root.current?.querySelectorAll<HTMLButtonElement>(
      "[data-filter-remove]:not(:disabled)"
    )
    const next = removers?.[Math.min(pending.index, removers.length - 1)]
    const control = controlsRoot.current?.querySelector<HTMLElement>(
      "input:not(:disabled):not([type=hidden]), textarea:not(:disabled), select:not(:disabled), button:not(:disabled), a[href], [tabindex='0']:not([aria-disabled=true])"
    )
    ;(
      next ??
      (clear.current?.disabled ? null : clear.current) ??
      control ??
      root.current
    )?.focus()
  })
  return (
    <div
      ref={root}
      data-slot="filter-bar"
      role="group"
      aria-label={label ?? t("filters")}
      data-disabled={isDisabled || undefined}
      tabIndex={-1}
      className={cn(
        "grid min-w-0 gap-3 rounded-lg border bg-background p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        className
      )}
      {...props}
    >
      {(controls || actions) && (
        <div ref={controlsRoot}>
          <Toolbar actions={actions}>{controls}</Toolbar>
        </div>
      )}
      {(activeFilters.length > 0 || onClear) && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {activeFilters.length > 0 && (
            <ul
              data-slot="filter-bar-items"
              className="flex max-w-full min-w-0 flex-wrap gap-1.5"
            >
              {activeFilters.map((filter, index) => (
                <li
                  key={filter.id}
                  className="flex max-w-full min-w-0 items-center gap-1 rounded-md border bg-muted py-0.5 ps-2 text-sm"
                >
                  <span className="min-w-0 break-words">{filter.label}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="pointer-coarse:size-11"
                    data-filter-remove
                    aria-label={
                      removeLabel?.(filter) ??
                      t("removeFilter", { filter: filter.label })
                    }
                    isDisabled={isDisabled}
                    onPress={(event) => {
                      pendingFocus.current = {
                        ids: [filter.id],
                        index,
                        trigger: event.target,
                      }
                      onRemove(filter.id)
                    }}
                  >
                    <XIcon aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {onClear && (
            <Button
              ref={clear}
              variant="ghost"
              className="h-auto min-h-8 max-w-full whitespace-normal pointer-coarse:min-h-11"
              isDisabled={isDisabled || activeFilters.length === 0}
              onPress={(event) => {
                pendingFocus.current = {
                  ids: activeFilters.map((filter) => filter.id),
                  index: 0,
                  trigger: event.target,
                }
                onClear()
              }}
            >
              {clearLabel ?? t("clearFilters")}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

export { FilterBar, type ActiveFilter, type FilterBarProps }
