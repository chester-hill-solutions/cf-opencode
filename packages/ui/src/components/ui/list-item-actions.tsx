import { ArrowDownIcon, ArrowUpIcon, XIcon } from "lucide-react"
import { useLayoutEffect, useRef } from "react"

import { Button } from "./button"
import { useUiI18n } from "./i18n"

type ListItemActionLabels = {
  moveUp?: (item: string) => string
  moveDown?: (item: string) => string
  remove?: (item: string) => string
}

type ListItemActionsProps = {
  label: string
  isFirst: boolean
  isLast: boolean
  isDisabled?: boolean
  canRemove?: boolean
  labels?: ListItemActionLabels
  onMove: (direction: -1 | 1) => void
  onRemove: () => void
}

function ListItemActions({
  label,
  isFirst,
  isLast,
  isDisabled,
  canRemove = true,
  labels,
  onMove,
  onRemove,
}: ListItemActionsProps) {
  const { t } = useUiI18n()
  const root = useRef<HTMLDivElement>(null)
  const moved = useRef(false)
  useLayoutEffect(() => {
    if (!moved.current) return
    moved.current = false
    const active = document.activeElement
    if (
      active instanceof HTMLButtonElement &&
      root.current?.contains(active) &&
      !active.disabled
    )
      return
    root.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus()
  })
  function move(direction: -1 | 1) {
    moved.current = true
    onMove(direction)
  }
  return (
    <div
      ref={root}
      data-slot="list-item-actions"
      className="flex shrink-0 flex-wrap gap-0.5"
    >
      <Button
        variant="ghost"
        size="icon"
        className="pointer-coarse:size-11"
        aria-label={labels?.moveUp?.(label) ?? t("moveItemUp", { item: label })}
        isDisabled={isDisabled || isFirst}
        onPress={() => move(-1)}
      >
        <ArrowUpIcon aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="pointer-coarse:size-11"
        aria-label={
          labels?.moveDown?.(label) ?? t("moveItemDown", { item: label })
        }
        isDisabled={isDisabled || isLast}
        onPress={() => move(1)}
      >
        <ArrowDownIcon aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="pointer-coarse:size-11"
        aria-label={labels?.remove?.(label) ?? t("removeItem", { item: label })}
        isDisabled={isDisabled || !canRemove}
        onPress={onRemove}
      >
        <XIcon aria-hidden />
      </Button>
    </div>
  )
}

export { ListItemActions, type ListItemActionLabels }
