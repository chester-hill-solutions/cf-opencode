import type { ComponentProps, ReactNode } from "react"
import { cn } from "../../lib/utils"

export type MessageProps = ComponentProps<"article"> & {
  author: ReactNode
  avatar?: ReactNode
  timestamp?: ReactNode
  footer?: ReactNode
  align?: "start" | "end"
}

export function Message({
  author,
  avatar,
  timestamp,
  footer,
  align = "start",
  children,
  className,
  ...props
}: MessageProps) {
  return (
    <article
      data-slot="message"
      data-align={align}
      className={cn(
        "flex min-w-0 gap-3",
        align === "end" && "flex-row-reverse",
        className
      )}
      {...props}
    >
      {avatar && (
        <div data-slot="message-avatar" className="shrink-0">
          {avatar}
        </div>
      )}
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col gap-1",
          align === "end" && "items-end"
        )}
      >
        <header
          data-slot="message-header"
          className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-xs"
        >
          <span className="font-semibold break-words">{author}</span>
          {timestamp && (
            <span className="text-muted-foreground">{timestamp}</span>
          )}
        </header>
        <div
          data-slot="message-content"
          className="max-w-full min-w-0 text-sm break-words"
        >
          {children}
        </div>
        {footer && (
          <footer
            data-slot="message-footer"
            className="flex flex-wrap gap-2 text-xs text-muted-foreground"
          >
            {footer}
          </footer>
        )}
      </div>
    </article>
  )
}
