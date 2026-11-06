import type * as React from "react"
import { PreviewCard } from "@base-ui/react/preview-card"
import { cn } from "../../lib/utils"

const HoverCard = PreviewCard.Root
function HoverCardTrigger({
  className,
  ...props
}: React.ComponentProps<typeof PreviewCard.Trigger>) {
  return (
    <PreviewCard.Trigger
      data-slot="hover-card-trigger"
      className={cn(
        "rounded-sm text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      {...props}
    />
  )
}
function HoverCardContent({
  className,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof PreviewCard.Popup> &
  Pick<
    React.ComponentProps<typeof PreviewCard.Positioner>,
    "side" | "align" | "sideOffset"
  >) {
  return (
    <PreviewCard.Portal>
      <PreviewCard.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        className="z-50"
      >
        <PreviewCard.Popup
          data-slot="hover-card-content"
          className={cn(
            "w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover p-4 text-sm text-popover-foreground shadow-lg outline-none",
            className
          )}
          {...props}
        />
      </PreviewCard.Positioner>
    </PreviewCard.Portal>
  )
}

export { HoverCard, HoverCardTrigger, HoverCardContent }
