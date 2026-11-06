import type { ComponentProps } from "react"
import { Badge } from "./ui/badge"

export type StatusTone = "neutral" | "success" | "warning" | "error" | "busy"

/** Status always includes text; colour is a supporting cue. */
export function Status({
  tone = "neutral",
  children,
  ...props
}: ComponentProps<"span"> & { tone?: StatusTone }) {
  return (
    <Badge variant="outline" data-tone={tone} data-slot="status" {...props}>
      {children}
    </Badge>
  )
}
