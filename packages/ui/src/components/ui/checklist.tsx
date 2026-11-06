import { CheckIcon, InfoIcon, XIcon } from "lucide-react"

import { cn } from "../../lib/utils"
import { useUiI18n } from "./i18n"

type ChecklistItemStatus = "pass" | "warn" | "fail" | "info"

type ChecklistItem = {
  id: string
  label: React.ReactNode
  status: ChecklistItemStatus
}

function ChecklistStatusIcon({ status }: { status: ChecklistItemStatus }) {
  const { t } = useUiI18n()
  const className = cn(
    "inline-flex size-5 shrink-0 items-center justify-center rounded-full",
    status === "pass" && "bg-success text-success-foreground",
    status === "warn" && "bg-warning text-warning-foreground",
    status === "fail" && "bg-destructive text-destructive-foreground",
    status === "info" && "bg-muted text-muted-foreground"
  )
  const label =
    status === "pass"
      ? t("passed")
      : status === "warn"
        ? t("warning")
        : status === "fail"
          ? t("failed")
          : t("info")

  return (
    <span className={className} role="img" aria-label={label}>
      {status === "pass" ? (
        <CheckIcon className="size-3" aria-hidden />
      ) : status === "warn" ? (
        <span className="text-[0.65rem] font-bold leading-none" aria-hidden>
          !
        </span>
      ) : status === "fail" ? (
        <XIcon className="size-3" aria-hidden />
      ) : (
        <InfoIcon className="size-3" aria-hidden />
      )}
    </span>
  )
}

function Checklist({
  className,
  title,
  items,
  showReady = true,
  ...props
}: React.ComponentProps<"section"> & {
  title?: React.ReactNode
  items: ChecklistItem[]
  showReady?: boolean
}) {
  const { t } = useUiI18n()
  const ready =
    items.length > 0 &&
    items.every((item) => item.status === "pass" || item.status === "info")

  return (
    <section
      data-slot="checklist"
      data-ready={ready || undefined}
      className={cn(
        "rounded-lg border border-border bg-card p-4 text-card-foreground shadow-sm",
        className
      )}
      {...props}
    >
      <h2
        data-slot="checklist-title"
        className="mb-3 flex items-center gap-2 text-sm font-semibold"
      >
        {title ?? t("checklist")}
        {showReady && ready ? (
          <>
            {" "}
            <span className="text-xs font-medium text-success">({t("ready")})</span>
          </>
        ) : null}
      </h2>
      <ul data-slot="checklist-list" className="m-0 list-none space-y-1 p-0">
        {items.map((item) => (
          <li
            key={item.id}
            data-slot="checklist-item"
            data-status={item.status}
            className="flex items-center gap-2 py-0.5 text-sm"
          >
            <ChecklistStatusIcon status={item.status} />
            <span>{item.label}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export { Checklist, type ChecklistItem, type ChecklistItemStatus }
