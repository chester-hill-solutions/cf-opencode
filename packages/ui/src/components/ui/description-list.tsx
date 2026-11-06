import type { ComponentProps } from "react"

import { cn } from "../../lib/utils"

type DescriptionListProps = ComponentProps<"dl"> & {
  orientation?: "vertical" | "horizontal" | "responsive"
}
type DescriptionItemProps = ComponentProps<"div">
type DescriptionTermProps = ComponentProps<"dt">
type DescriptionDetailsProps = ComponentProps<"dd">

function DescriptionList({
  orientation = "responsive",
  className,
  ...props
}: DescriptionListProps) {
  return (
    <dl
      data-slot="description-list"
      data-orientation={orientation}
      className={cn("group/description-list grid min-w-0 gap-4", className)}
      {...props}
    />
  )
}

function DescriptionItem({ className, ...props }: DescriptionItemProps) {
  return (
    <div
      data-slot="description-item"
      className={cn(
        "grid min-w-0 gap-x-6 gap-y-1 group-data-[orientation=horizontal]/description-list:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:group-data-[orientation=responsive]/description-list:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]",
        className
      )}
      {...props}
    />
  )
}

function DescriptionTerm({ className, ...props }: DescriptionTermProps) {
  return (
    <dt
      data-slot="description-term"
      className={cn(
        "min-w-0 text-sm font-medium break-words text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function DescriptionDetails({ className, ...props }: DescriptionDetailsProps) {
  return (
    <dd
      data-slot="description-details"
      className={cn("min-w-0 text-sm break-words text-foreground", className)}
      {...props}
    />
  )
}

export {
  DescriptionList,
  DescriptionItem,
  DescriptionTerm,
  DescriptionDetails,
  type DescriptionListProps,
  type DescriptionItemProps,
  type DescriptionTermProps,
  type DescriptionDetailsProps,
}
