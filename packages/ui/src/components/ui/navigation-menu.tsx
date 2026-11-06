import type * as React from "react"
import { NavigationMenu as Primitive } from "@base-ui/react/navigation-menu"
import { cn } from "../../lib/utils"

function NavigationMenu({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.Root>) {
  return (
    <Primitive.Root
      data-slot="navigation-menu"
      className={cn("relative w-fit max-w-full", className)}
      {...props}
    >
      {children}
      <Primitive.Portal>
        <Primitive.Positioner sideOffset={6} className="z-50">
          <Primitive.Popup className="max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover text-popover-foreground shadow-lg outline-none">
            <Primitive.Viewport />
          </Primitive.Popup>
        </Primitive.Positioner>
      </Primitive.Portal>
    </Primitive.Root>
  )
}
function NavigationMenuList({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.List>) {
  return (
    <Primitive.List
      data-slot="navigation-menu-list"
      className={cn("flex flex-wrap items-center gap-1", className)}
      {...props}
    />
  )
}
const NavigationMenuItem = Primitive.Item
function NavigationMenuTrigger({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Trigger>) {
  return (
    <Primitive.Trigger
      data-slot="navigation-menu-trigger"
      className={cn(
        "min-h-8 rounded-md px-3 py-1.5 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-muted pointer-coarse:min-h-11",
        className
      )}
      {...props}
    />
  )
}
function NavigationMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Content
      data-slot="navigation-menu-content"
      className={cn("grid w-80 max-w-full gap-1 p-2", className)}
      {...props}
    />
  )
}
function NavigationMenuLink({
  className,
  ...props
}: React.ComponentProps<typeof Primitive.Link>) {
  return (
    <Primitive.Link
      data-slot="navigation-menu-link"
      className={cn(
        "block min-h-8 rounded-md px-3 py-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 data-active:bg-accent",
        className
      )}
      {...props}
    />
  )
}

export {
  NavigationMenu,
  NavigationMenuList,
  NavigationMenuItem,
  NavigationMenuTrigger,
  NavigationMenuContent,
  NavigationMenuLink,
}
