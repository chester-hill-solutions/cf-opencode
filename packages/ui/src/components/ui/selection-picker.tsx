import { useId, useRef, useState, type ReactNode } from "react"

import { cn } from "../../lib/utils"
import { Checkbox } from "./checkbox"
import { Input } from "./input"
import { useUiI18n } from "./i18n"

type SelectionOption = {
  id: string
  label: string
  description?: string
  group?: string
  isDisabled?: boolean
}
type SelectionPickerLabels = {
  search?: string
  searchPlaceholder?: string
  onlySelected?: string
  selectMatching?: string
  empty?: ReactNode
}
type SelectionPickerProps = {
  label: string
  description?: ReactNode
  options: readonly SelectionOption[]
  value: readonly string[]
  onChange: (value: string[]) => void
  labels?: SelectionPickerLabels
  name?: string
  isDisabled?: boolean
  className?: string
}

function SelectionPicker({
  label,
  description,
  options,
  value,
  onChange,
  labels,
  name,
  isDisabled,
  className,
}: SelectionPickerProps) {
  const { t, locale } = useUiI18n()
  const id = useId()
  const search = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  const [onlySelected, setOnlySelected] = useState(false)
  const selected = new Set(value)
  const normalized = query.trim().toLocaleLowerCase(locale)
  const visible = options.filter(
    (option) =>
      (!onlySelected || selected.has(option.id)) &&
      `${option.label} ${option.description ?? ""} ${option.group ?? ""}`
        .toLocaleLowerCase(locale)
        .includes(normalized)
  )
  const selectable = visible.filter((option) => !option.isDisabled)
  const selectedCount = selectable.filter((option) =>
    selected.has(option.id)
  ).length
  const groups = new Map<string, SelectionOption[]>()
  for (const option of visible) {
    const group = option.group ?? ""
    groups.set(group, [...(groups.get(group) ?? []), option])
  }
  function toggle(id: string, checked: boolean) {
    onChange(
      checked
        ? [...new Set([...value, id])]
        : value.filter((current) => current !== id)
    )
  }
  return (
    <fieldset
      data-slot="selection-picker"
      disabled={isDisabled}
      className={cn("grid min-w-0 gap-3", className)}
      aria-describedby={description ? `${id}-description` : undefined}
    >
      <legend className="mb-2 text-sm font-medium">{label}</legend>
      {description && (
        <div id={`${id}-description`} className="text-sm text-muted-foreground">
          {description}
        </div>
      )}
      <div className="grid gap-1.5">
        <label htmlFor={`${id}-search`} className="text-sm font-medium">
          {labels?.search ?? t("searchItems")}
        </label>
        <Input
          ref={search}
          id={`${id}-search`}
          type="search"
          value={query}
          disabled={isDisabled}
          placeholder={labels?.searchPlaceholder}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        <Checkbox
          isSelected={onlySelected}
          isDisabled={isDisabled}
          onChange={setOnlySelected}
        >
          {labels?.onlySelected ?? t("onlySelected")}
        </Checkbox>
        <Checkbox
          isSelected={
            selectable.length > 0 && selectedCount === selectable.length
          }
          isIndeterminate={
            selectedCount > 0 && selectedCount < selectable.length
          }
          isDisabled={isDisabled || !selectable.length}
          onChange={(checked) => {
            const ids = new Set(selectable.map((option) => option.id))
            onChange(
              checked
                ? [...new Set([...value, ...ids])]
                : value.filter((current) => !ids.has(current))
            )
          }}
        >
          {labels?.selectMatching ?? t("selectMatching")}
        </Checkbox>
      </div>
      <div
        data-slot="selection-picker-options"
        className="max-h-80 overflow-y-auto rounded-lg border"
      >
        {[...groups].map(([group, items]) => (
          <fieldset
            key={group}
            className="grid min-w-0 gap-1 border-b p-2 last:border-b-0"
          >
            {group && (
              <legend className="px-1 text-xs font-medium text-muted-foreground">
                {group}
              </legend>
            )}
            {items.map((option) => (
              <Checkbox
                key={option.id}
                aria-label={option.label}
                aria-describedby={
                  option.description
                    ? `${id}-${encodeURIComponent(option.id)}-description`
                    : undefined
                }
                isSelected={selected.has(option.id)}
                isDisabled={isDisabled || option.isDisabled}
                onChange={(checked) => {
                  if (onlySelected && !checked) search.current?.focus()
                  toggle(option.id, checked)
                }}
                className="w-full items-start rounded-md px-2 py-2 hover:bg-muted/50 pointer-coarse:min-h-11"
              >
                <span className="grid min-w-0 gap-0.5">
                  <span className="break-words">{option.label}</span>
                  {option.description && (
                    <span
                      id={`${id}-${encodeURIComponent(option.id)}-description`}
                      className="text-xs text-muted-foreground"
                    >
                      {option.description}
                    </span>
                  )}
                </span>
              </Checkbox>
            ))}
          </fieldset>
        ))}
        {!visible.length && (
          <div
            data-slot="selection-picker-empty"
            className="p-4 text-sm text-muted-foreground"
          >
            {labels?.empty ?? t("noResults")}
          </div>
        )}
      </div>
      {name &&
        value.map((item) => (
          <input
            key={item}
            type="hidden"
            name={name}
            value={item}
            disabled={isDisabled}
          />
        ))}
    </fieldset>
  )
}

export {
  SelectionPicker,
  type SelectionPickerProps,
  type SelectionPickerLabels,
  type SelectionOption,
}
