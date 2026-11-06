import { useId, useState, type ComponentProps, type ReactNode } from "react"
import { cn } from "../../lib/utils"
import { Button } from "./button"
import { useUiI18n } from "./i18n"

export type BubbleProps = ComponentProps<"div"> & {
  variant?: "default" | "accent" | "muted"
  align?: "start" | "end"
  group?: "single" | "first" | "middle" | "last"
  reactions?: ReactNode
  details?: ReactNode
}

export function Bubble({
  variant = "default",
  align = "start",
  group = "single",
  reactions,
  details,
  children,
  className,
  ...props
}: BubbleProps) {
  const { t } = useUiI18n()
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()
  return (
    <div
      data-slot="bubble-group"
      data-align={align}
      className={cn(
        "flex min-w-0 flex-col gap-1",
        align === "end" ? "items-end" : "items-start"
      )}
    >
      <div
        data-slot="bubble"
        data-variant={variant}
        data-group={group}
        className={cn(
          "max-w-full rounded-lg border border-border px-3 py-2 text-sm leading-relaxed break-words",
          variant === "accent"
            ? "border-transparent bg-primary text-primary-foreground"
            : variant === "muted"
              ? "bg-muted text-muted-foreground"
              : "bg-card text-card-foreground",
          group !== "single" &&
            (align === "end" ? "rounded-e-sm" : "rounded-s-sm"),
          className
        )}
        {...props}
      >
        {children}
        {details && (
          <>
            <Button
              variant="link"
              size="sm"
              className="mt-1 text-inherit"
              onPress={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
              aria-controls={detailsId}
            >
              {expanded ? t("showLess") : t("showMore")}
            </Button>
            <div id={detailsId} hidden={!expanded} className="mt-2">
              {details}
            </div>
          </>
        )}
      </div>
      {reactions && (
        <div data-slot="bubble-reactions" className="flex flex-wrap gap-1">
          {reactions}
        </div>
      )}
    </div>
  )
}
