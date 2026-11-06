import { useEffect, type ReactNode } from "react"

import { cn } from "../../lib/utils"
import { Button } from "./button"
import { useUiI18n } from "./i18n"

type SaveBarProps = {
  isDirty: boolean
  isPending?: boolean
  onSave: () => void
  onReset?: () => void
  shortcut?: boolean
  placement?: "inline" | "top" | "bottom"
  message?: ReactNode
  saveLabel?: ReactNode
  pendingLabel?: ReactNode
  resetLabel?: ReactNode
  className?: string
}

function SaveBar({
  isDirty,
  isPending = false,
  onSave,
  onReset,
  shortcut = false,
  placement = "inline",
  message,
  saveLabel,
  pendingLabel,
  resetLabel,
  className,
}: SaveBarProps) {
  const { t } = useUiI18n()
  useEffect(() => {
    if (!shortcut || !isDirty || isPending) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "s" &&
        !event.isComposing
      ) {
        event.preventDefault()
        if (!event.repeat) onSave()
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [shortcut, isDirty, isPending, onSave])
  if (!isDirty && !isPending) return null
  return (
    <div
      data-slot="save-bar"
      data-placement={placement}
      aria-busy={isPending}
      className={cn(
        "flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border bg-background p-3",
        placement === "top" && "sticky top-0 z-20",
        placement === "bottom" &&
          "sticky bottom-0 z-20 pb-[max(0.75rem,env(safe-area-inset-bottom))]",
        className
      )}
    >
      <div role="status" className="min-w-0 text-sm">
        {isPending
          ? (pendingLabel ?? t("saving"))
          : (message ?? t("unsavedChanges"))}
      </div>
      <div className="flex w-full min-w-0 flex-wrap gap-2 sm:w-auto">
        {onReset && (
          <Button
            variant="ghost"
            className="h-auto min-h-8 max-w-full whitespace-normal pointer-coarse:min-h-11"
            isDisabled={isPending}
            onPress={onReset}
          >
            {resetLabel ?? t("discardChanges")}
          </Button>
        )}
        <Button
          className="h-auto min-h-8 max-w-full whitespace-normal pointer-coarse:min-h-11"
          pending={isPending}
          pendingLabel={pendingLabel ?? t("saving")}
          isDisabled={!isDirty || isPending}
          onPress={onSave}
        >
          {saveLabel ?? t("saveChanges")}
        </Button>
      </div>
    </div>
  )
}

export { SaveBar, type SaveBarProps }
