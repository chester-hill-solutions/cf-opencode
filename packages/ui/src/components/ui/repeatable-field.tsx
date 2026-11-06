import { useId, useLayoutEffect, useRef, type Key, type ReactNode } from "react"
import { PlusIcon } from "lucide-react"

import { cn } from "../../lib/utils"
import { Button } from "./button"
import { ListItemActions, type ListItemActionLabels } from "./list-item-actions"
import { useUiI18n } from "./i18n"

type RepeatableFieldItemProps<T> = {
  item: T
  index: number
  onChange: (item: T) => void
  isDisabled: boolean
}
type RepeatableFieldProps<T> = {
  label: string
  description?: ReactNode
  value: readonly T[]
  onChange: (value: T[]) => void
  createItem: () => T
  getItemKey: (item: T) => Key
  getItemLabel: (item: T, index: number) => string
  renderItem: (props: RepeatableFieldItemProps<T>) => ReactNode
  addLabel?: ReactNode
  emptyLabel?: ReactNode
  actionLabels?: ListItemActionLabels
  minItems?: number
  maxItems?: number
  isDisabled?: boolean
  className?: string
}

function RepeatableField<T>({
  label,
  description,
  value,
  onChange,
  createItem,
  getItemKey,
  getItemLabel,
  renderItem,
  addLabel,
  emptyLabel,
  actionLabels,
  minItems = 0,
  maxItems,
  isDisabled = false,
  className,
}: RepeatableFieldProps<T>) {
  const { t } = useUiI18n()
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLOListElement>(null)
  const add = useRef<HTMLButtonElement>(null)
  const removedIndex = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (removedIndex.current === null) return
    const index = removedIndex.current
    removedIndex.current = null
    const rows = list.current?.children
    const row = rows?.[Math.min(index, rows.length - 1)]
    const target =
      row?.querySelector<HTMLElement>(
        "input:not(:disabled):not([type=hidden]), textarea:not(:disabled), select:not(:disabled), [tabindex='0']:not(button):not([aria-disabled=true])"
      ) ?? row?.querySelector<HTMLButtonElement>("button:not(:disabled)")
    ;(target ?? (add.current?.disabled ? root.current : add.current))?.focus()
  })
  function move(index: number, direction: -1 | 1) {
    const target = index + direction
    if (target < 0 || target >= value.length) return
    const next = [...value]
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }
  return (
    <div
      ref={root}
      tabIndex={-1}
      data-slot="repeatable-field"
      role="group"
      aria-labelledby={`${id}-label`}
      aria-describedby={description ? `${id}-description` : undefined}
      className={cn("grid min-w-0 gap-3", className)}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <div id={`${id}-label`} className="text-sm font-medium">
            {label}
          </div>
          {description && (
            <div
              id={`${id}-description`}
              className="text-sm text-muted-foreground"
            >
              {description}
            </div>
          )}
        </div>
        <Button
          ref={add}
          variant="outline"
          className="h-auto min-h-8 max-w-full whitespace-normal pointer-coarse:min-h-11"
          isDisabled={
            isDisabled || (maxItems !== undefined && value.length >= maxItems)
          }
          onPress={() => onChange([...value, createItem()])}
        >
          <PlusIcon aria-hidden />
          {addLabel ?? t("addItem")}
        </Button>
      </div>
      <ol ref={list} className="grid min-w-0 gap-3">
        {value.map((item, index) => {
          const title = getItemLabel(item, index)
          return (
            <li
              key={getItemKey(item)}
              data-slot="repeatable-field-item"
              className="min-w-0 rounded-lg border bg-card p-3 text-card-foreground"
            >
              <fieldset className="grid min-w-0 gap-3" disabled={isDisabled}>
                <legend className="sr-only">{title}</legend>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span
                    aria-hidden
                    className="min-w-0 text-sm font-medium break-words"
                  >
                    {title}
                  </span>
                  <ListItemActions
                    label={title}
                    isFirst={index === 0}
                    isLast={index === value.length - 1}
                    isDisabled={isDisabled}
                    canRemove={value.length > minItems}
                    labels={actionLabels}
                    onMove={(direction) => move(index, direction)}
                    onRemove={() => {
                      removedIndex.current = index
                      onChange(
                        value.filter((_, position) => position !== index)
                      )
                    }}
                  />
                </div>
                {renderItem({
                  item,
                  index,
                  isDisabled,
                  onChange: (next) =>
                    onChange(
                      value.map((current, position) =>
                        position === index ? next : current
                      )
                    ),
                })}
              </fieldset>
            </li>
          )
        })}
      </ol>
      {!value.length && (
        <div
          data-slot="repeatable-field-empty"
          className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground"
        >
          {emptyLabel ?? t("noItems")}
        </div>
      )}
    </div>
  )
}

export {
  RepeatableField,
  type RepeatableFieldProps,
  type RepeatableFieldItemProps,
}
