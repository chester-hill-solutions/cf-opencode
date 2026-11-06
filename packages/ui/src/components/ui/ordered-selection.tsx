import { useLayoutEffect, useRef, type ReactNode } from "react"

import { cn } from "../../lib/utils"
import { ListItemActions, type ListItemActionLabels } from "./list-item-actions"
import type { SelectionOption } from "./selection-picker"
import { useUiI18n } from "./i18n"

type OrderedSelectionProps = {
  label: string
  options: readonly SelectionOption[]
  value: readonly string[]
  onChange: (value: string[]) => void
  emptyLabel?: ReactNode
  unavailableLabel?: ReactNode
  actionLabels?: ListItemActionLabels
  name?: string
  isDisabled?: boolean
  className?: string
}

function OrderedSelection({
  label,
  options,
  value,
  onChange,
  emptyLabel,
  unavailableLabel,
  actionLabels,
  name,
  isDisabled,
  className,
}: OrderedSelectionProps) {
  const { t, formatNumber } = useUiI18n()
  const root = useRef<HTMLOListElement>(null)
  const removedIndex = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (removedIndex.current === null) return
    const index = removedIndex.current
    removedIndex.current = null
    const rows = root.current?.querySelectorAll<HTMLElement>(
      "[data-slot=ordered-selection-item]"
    )
    const row = rows?.[Math.min(index, rows.length - 1)]
    const target = row?.querySelector<HTMLButtonElement>(
      "[data-slot=list-item-actions] button:last-child:not(:disabled)"
    )
    ;(target ?? root.current)?.focus()
  })
  const selected = [...new Set(value)]
  const byId = new Map(options.map((option) => [option.id, option]))
  function move(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= selected.length) return
    const next = [...selected]
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }
  return (
    <ol
      ref={root}
      tabIndex={-1}
      data-slot="ordered-selection"
      aria-label={label}
      className={cn("grid min-w-0 gap-2", className)}
    >
      {selected.map((id, index) => {
        const option = byId.get(id)
        const title = option?.label ?? id
        return (
          <li
            key={id}
            data-slot="ordered-selection-item"
            className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border bg-card p-2 text-card-foreground"
          >
            <span
              aria-hidden
              className="w-6 shrink-0 text-center text-xs text-muted-foreground tabular-nums"
            >
              {formatNumber(index + 1)}
            </span>
            <div className="grid min-w-0 flex-1 gap-0.5">
              <span className="text-sm font-medium break-words">{title}</span>
              {option?.description && (
                <span className="text-xs text-muted-foreground">
                  {option.description}
                </span>
              )}
              {!option && (
                <span className="text-xs text-muted-foreground">
                  {unavailableLabel ?? t("unavailableItem")}
                </span>
              )}
            </div>
            <ListItemActions
              label={title}
              labels={actionLabels}
              isFirst={index === 0}
              isLast={index === selected.length - 1}
              isDisabled={isDisabled}
              onMove={(direction) => move(index, direction)}
              onRemove={() => {
                removedIndex.current = index
                onChange(selected.filter((current) => current !== id))
              }}
            />
            {name && (
              <input
                type="hidden"
                name={name}
                value={id}
                disabled={isDisabled}
              />
            )}
          </li>
        )
      })}
      {!selected.length && (
        <li className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          {emptyLabel ?? t("noItemsSelected")}
        </li>
      )}
    </ol>
  )
}

export { OrderedSelection, type OrderedSelectionProps }
