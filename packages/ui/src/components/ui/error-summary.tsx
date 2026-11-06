import { useId, type ComponentProps, type ReactNode } from "react"

import { cn } from "../../lib/utils"
import { useUiI18n } from "./i18n"

type ErrorSummaryItem = {
  id?: string
  message: ReactNode
  fieldId?: string
}
type ErrorSummaryProps = Omit<ComponentProps<"div">, "children" | "title"> & {
  errors: readonly ErrorSummaryItem[]
  title?: ReactNode
}

const focusable =
  'input, select, textarea, button, a[href], [tabindex], [contenteditable="true"]'

function availableField(field: HTMLElement) {
  if (field.matches(':disabled, [aria-disabled="true"], input[type="hidden"]'))
    return false
  for (
    let ancestor: HTMLElement | null = field;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    if (
      ancestor.matches(
        '[hidden], [inert], [aria-hidden="true"], [aria-disabled="true"]'
      )
    )
      return false
    const style = ancestor.ownerDocument.defaultView?.getComputedStyle(ancestor)
    if (
      style?.display === "none" ||
      style?.visibility === "hidden" ||
      style?.visibility === "collapse"
    )
      return false
  }
  return true
}

/** Hosts explicitly focus the summary ref after a failed submission, if needed. */
function ErrorSummary({
  errors,
  title,
  className,
  onClick,
  tabIndex = -1,
  ...props
}: ErrorSummaryProps) {
  const headingId = useId()
  const { t } = useUiI18n()
  if (!errors.length) return null
  return (
    // Native link clicks bubble for both pointer and keyboard activation.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions
    <div
      data-slot="error-summary"
      role="region"
      aria-labelledby={headingId}
      tabIndex={tabIndex}
      className={cn(
        "grid min-w-0 gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        className
      )}
      {...props}
      onClick={(event) => {
        onClick?.(event)
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return
        const element = event.target
        const view = event.currentTarget.ownerDocument.defaultView
        if (!view || !(element instanceof view.Element)) return
        const link = element.closest<HTMLAnchorElement>("a[data-error-field]")
        if (!link || !event.currentTarget.contains(link)) return
        event.preventDefault()
        const fieldId = link.dataset.errorField
        if (!fieldId) return
        const field = event.currentTarget.ownerDocument.getElementById(fieldId)
        if (!field) return
        const candidates = field.matches(focusable)
          ? [field]
          : Array.from(field.querySelectorAll<HTMLElement>(focusable))
        candidates.find(availableField)?.focus()
      }}
    >
      <h2 id={headingId} className="text-sm font-semibold text-destructive">
        {title ?? t("errorSummaryTitle")}
      </h2>
      <ul className="grid min-w-0 list-inside list-disc gap-1 text-sm">
        {errors.map((error, index) => (
          <li
            key={error.id ?? `${error.fieldId ?? "error"}-${index}`}
            className="break-words"
          >
            {error.fieldId ? (
              <a
                href={`#${encodeURIComponent(error.fieldId)}`}
                data-error-field={error.fieldId}
                className="rounded-sm underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                {error.message}
              </a>
            ) : (
              error.message
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

export { ErrorSummary }
export type { ErrorSummaryProps, ErrorSummaryItem }
