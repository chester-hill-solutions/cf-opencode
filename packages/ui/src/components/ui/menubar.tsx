import type * as React from "react"
import { Menubar as MenubarPrimitive } from "@base-ui/react/menubar"
import { Menu } from "@base-ui/react/menu"
import { cn } from "../../lib/utils"

function Menubar({
  className,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive>) {
  return (
    <MenubarPrimitive
      data-slot="menubar"
      className={cn(
        "flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-border bg-background p-1",
        className
      )}
      {...props}
    />
  )
}
const MenubarMenu = Menu.Root
const MenubarGroup = Menu.Group
const MenubarSub = Menu.SubmenuRoot
function MenubarTrigger({
  className,
  ...props
}: React.ComponentProps<typeof Menu.Trigger>) {
  return (
    <Menu.Trigger
      data-slot="menubar-trigger"
      className={cn(
        "min-h-7 rounded px-2 py-1 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-muted pointer-coarse:min-h-11",
        className
      )}
      {...props}
    />
  )
}
function MenubarContent({
  className,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof Menu.Popup> &
  Pick<
    React.ComponentProps<typeof Menu.Positioner>,
    "side" | "align" | "sideOffset"
  >) {
  return (
    <Menu.Portal>
      <Menu.Positioner
        className="z-50"
        side={side}
        align={align}
        sideOffset={sideOffset}
      >
        <Menu.Popup
          data-slot="menubar-content"
          className={cn(
            "max-w-[calc(100vw-2rem)] min-w-44 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none",
            className
          )}
          {...props}
        />
      </Menu.Positioner>
    </Menu.Portal>
  )
}
function MenubarItem({
  className,
  ...props
}: React.ComponentProps<typeof Menu.Item>) {
  return (
    <Menu.Item
      data-slot="menubar-item"
      className={cn(
        "flex min-h-8 cursor-default items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground pointer-coarse:min-h-11 data-disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}
function MenubarSeparator({
  className,
  ...props
}: React.ComponentProps<typeof Menu.Separator>) {
  return (
    <Menu.Separator
      data-slot="menubar-separator"
      className={cn("my-1 h-px bg-border", className)}
      {...props}
    />
  )
}
function MenubarSubTrigger({
  className,
  ...props
}: React.ComponentProps<typeof Menu.SubmenuTrigger>) {
  return (
    <Menu.SubmenuTrigger
      data-slot="menubar-sub-trigger"
      className={cn(
        "flex min-h-8 w-full items-center rounded px-2 py-1.5 text-sm outline-none data-highlighted:bg-accent pointer-coarse:min-h-11",
        className
      )}
      {...props}
    />
  )
}

export {
  Menubar,
  MenubarMenu,
  MenubarGroup,
  MenubarTrigger,
  MenubarContent,
  MenubarItem,
  MenubarSeparator,
  MenubarSub,
  MenubarSubTrigger,
}
