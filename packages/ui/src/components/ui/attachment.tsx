import type { ComponentProps, ReactNode } from "react"
import { FileIcon, XIcon } from "lucide-react"
import { cn } from "../../lib/utils"
import { Button } from "./button"
import { Progress } from "./progress"
import { useUiI18n } from "./i18n"

export type AttachmentProps = Omit<ComponentProps<"article">, "children"> & {
  filename: string
  size?: number
  mediaType?: string
  preview?: ReactNode
  href?: string
  status?: "ready" | "uploading" | "error"
  progress?: number
  onRemove?: () => void
  actions?: ReactNode
}

export function Attachment({
  filename,
  size,
  mediaType,
  preview,
  href,
  status = "ready",
  progress,
  onRemove,
  actions,
  className,
  ...props
}: AttachmentProps) {
  const { t, formatNumber } = useUiI18n()
  const unit =
    size !== undefined && size >= 1048576
      ? "MB"
      : size !== undefined && size >= 1024
        ? "KB"
        : "B"
  const divisor = unit === "MB" ? 1048576 : unit === "KB" ? 1024 : 1
  return (
    <article
      data-slot="attachment"
      data-status={status}
      className={cn(
        "flex min-w-0 items-start gap-3 rounded-lg border border-border bg-card p-3 text-card-foreground",
        className
      )}
      {...props}
    >
      <div
        data-slot="attachment-preview"
        className="size-10 shrink-0 overflow-hidden rounded-md bg-muted [&_img]:size-full [&_img]:object-cover"
      >
        {preview ?? (
          <FileIcon className="m-2 size-6 text-muted-foreground" aria-hidden />
        )}
      </div>
      <div data-slot="attachment-content" className="min-w-0 flex-1 space-y-1">
        {href && status === "ready" ? (
          <a
            href={href}
            download
            className="text-sm font-medium break-all underline underline-offset-2"
          >
            {filename}
          </a>
        ) : (
          <p className="m-0 text-sm font-medium break-all">{filename}</p>
        )}
        <p
          data-slot="attachment-meta"
          className="m-0 text-xs text-muted-foreground"
        >
          {[
            mediaType,
            size === undefined
              ? undefined
              : `${formatNumber(size / divisor, { maximumFractionDigits: 1 })} ${unit}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {status === "uploading" && (
          <Progress
            aria-label={`${t("uploading")}: ${filename}`}
            value={
              progress === undefined
                ? undefined
                : Math.max(0, Math.min(100, progress))
            }
            isIndeterminate={progress === undefined}
          />
        )}
        {status === "error" && (
          <p role="alert" className="m-0 text-xs text-destructive">
            {t("uploadFailed")}
          </p>
        )}
      </div>
      {(actions || onRemove) && (
        <div
          data-slot="attachment-actions"
          className="flex shrink-0 flex-wrap items-center justify-end gap-1"
        >
          {actions}
          {onRemove && (
            <Button
              size="icon-sm"
              variant="outline"
              onPress={onRemove}
              aria-label={`${t("removeAttachment")}: ${filename}`}
            >
              <XIcon aria-hidden />
            </Button>
          )}
        </div>
      )}
    </article>
  )
}
