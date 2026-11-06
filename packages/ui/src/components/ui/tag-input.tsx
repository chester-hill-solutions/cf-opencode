import { useId, useRef, useState, type ReactNode } from "react"
import { XIcon } from "lucide-react"

import { cn } from "../../lib/utils"
import { Button } from "./button"
import { Input } from "./input"
import { useUiI18n } from "./i18n"

type TagInputProps = {
  label: string
  value: readonly string[]
  onChange: (value: string[]) => void
  description?: ReactNode
  error?: ReactNode
  placeholder?: string
  name?: string
  maxItems?: number
  isDisabled?: boolean
  className?: string
  removeLabel?: (tag: string) => string
}

function TagInput({
  label,
  value,
  onChange,
  description,
  error,
  placeholder,
  name,
  maxItems,
  isDisabled,
  className,
  removeLabel,
}: TagInputProps) {
  const { t } = useUiI18n()
  const id = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState("")
  const atLimit = maxItems !== undefined && value.length >= maxItems
  function commit(text: string) {
    const next = [...value]
    for (const part of text.split(/[,\n\r]+/)) {
      const tag = part.trim()
      if (
        tag &&
        !next.includes(tag) &&
        (maxItems === undefined || next.length < maxItems)
      )
        next.push(tag)
    }
    if (next.length !== value.length) onChange(next)
    setDraft("")
  }
  return (
    <div
      data-slot="tag-input"
      data-disabled={isDisabled || undefined}
      className={cn("grid min-w-0 gap-2", className)}
    >
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {description && (
        <div id={`${id}-description`} className="text-sm text-muted-foreground">
          {description}
        </div>
      )}
      {value.length > 0 && (
        <ul className="flex min-w-0 flex-wrap gap-1.5" aria-label={label}>
          {value.map((tag) => (
            <li
              key={tag}
              data-slot="tag-input-tag"
              className="flex max-w-full items-center gap-1 rounded-md border bg-muted py-0.5 ps-2 font-mono text-sm"
            >
              <span className="min-w-0 break-words">{tag}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="pointer-coarse:size-11"
                aria-label={
                  removeLabel?.(tag) ?? t("removeItem", { item: tag })
                }
                isDisabled={isDisabled}
                onPress={() => {
                  onChange(value.filter((current) => current !== tag))
                  inputRef.current?.focus()
                }}
              >
                <XIcon aria-hidden />
              </Button>
              {name && (
                <input
                  type="hidden"
                  name={name}
                  value={tag}
                  disabled={isDisabled}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <Input
        ref={inputRef}
        id={id}
        value={draft}
        placeholder={placeholder}
        disabled={isDisabled}
        readOnly={atLimit}
        aria-invalid={!!error || undefined}
        aria-describedby={
          [description && `${id}-description`, error && `${id}-error`]
            .filter(Boolean)
            .join(" ") || undefined
        }
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault()
            if (!atLimit) commit(draft)
          } else if (event.key === "Backspace" && !draft && value.length) {
            event.preventDefault()
            onChange(value.slice(0, -1))
          }
        }}
        onPaste={(event) => {
          const text = event.clipboardData.getData("text")
          if (/[,\n\r]/.test(text) && !atLimit) {
            event.preventDefault()
            commit(draft + text)
          }
        }}
      />
      {error && (
        <div
          id={`${id}-error`}
          role="alert"
          className="text-sm text-destructive"
        >
          {error}
        </div>
      )}
    </div>
  )
}

export { TagInput, type TagInputProps }
