"use client"

import {
  DisclosurePanel as CollapsibleContentPrimitive,
  Disclosure as CollapsiblePrimitive,
  Button as CollapsibleTriggerPrimitive,
  type ButtonProps,
  type DisclosurePanelProps,
  type DisclosureProps,
} from "react-aria-components"

import { cn } from "../../lib/utils"

function Collapsible({ ...props }: DisclosureProps) {
  return <CollapsiblePrimitive data-slot="collapsible" {...props} />
}

function CollapsibleTrigger({ ...props }: ButtonProps) {
  return (
    <CollapsibleTriggerPrimitive
      slot="trigger"
      data-slot="collapsible-trigger"
      {...props}
    />
  )
}

function CollapsibleContent({ className, ...props }: DisclosurePanelProps) {
  return (
    <CollapsibleContentPrimitive
      data-slot="collapsible-content"
      // When closed, RAC keeps the panel in the DOM with hidden="until-found",
      // which hides content but still paints the panel's own border/padding.
      className={cn(
        "[&[hidden]]:m-0 [&[hidden]]:border-0 [&[hidden]]:p-0 [&[hidden]]:shadow-none",
        className
      )}
      {...props}
    />
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
