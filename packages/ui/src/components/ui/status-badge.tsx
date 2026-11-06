import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils"
import { Badge } from "./badge"

const statusToneVariants = cva("", {
  variants: {
    tone: {
      muted: "border-transparent bg-muted text-muted-foreground",
      ok: "border-transparent bg-success/15 text-success",
      warn: "border-transparent bg-warning/15 text-warning",
      danger: "border-transparent bg-destructive/15 text-destructive",
      action: "border-transparent bg-info/15 text-info",
      accent: "border-transparent bg-primary/15 text-primary",
    },
  },
  defaultVariants: {
    tone: "muted",
  },
})

type StatusTone = NonNullable<VariantProps<typeof statusToneVariants>["tone"]>

const DEFAULT_STATUS_TONES: Record<string, StatusTone> = {
  draft: "muted",
  planned: "action",
  provisioning: "warn",
  blocked: "danger",
  ready_for_handoff: "accent",
  launched: "ok",
  cancelled: "muted",
  pending: "warn",
  running: "action",
  completed: "ok",
  failed: "danger",
  open: "action",
  in_progress: "warn",
  done: "ok",
  pass: "ok",
  warn: "warn",
  fail: "danger",
  info: "muted",
}

function resolveTone(
  tone: StatusTone | undefined,
  status: string | undefined,
  statusMap: Record<string, StatusTone> | undefined
): StatusTone {
  if (tone) return tone
  if (!status) return "muted"
  const map = statusMap ?? DEFAULT_STATUS_TONES
  return map[status] ?? map[status.toLowerCase()] ?? "muted"
}

function formatStatusLabel(status: string): string {
  return status.replaceAll("_", " ")
}

function StatusBadge({
  className,
  tone,
  status,
  statusMap,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Badge>, "variant"> & {
  tone?: StatusTone
  status?: string
  statusMap?: Record<string, StatusTone>
}) {
  const resolved = resolveTone(tone, status, statusMap)
  const label = children ?? (status ? formatStatusLabel(status) : null)

  return (
    <Badge
      data-slot="status-badge"
      data-tone={resolved}
      data-status={status}
      variant="outline"
      className={cn(statusToneVariants({ tone: resolved }), className)}
      {...props}
    >
      {label}
    </Badge>
  )
}

export { StatusBadge, statusToneVariants, DEFAULT_STATUS_TONES, type StatusTone }
