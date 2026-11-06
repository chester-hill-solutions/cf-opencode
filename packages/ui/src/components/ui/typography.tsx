import type * as React from "react"
import { cn } from "../../lib/utils"

type TypographyTag =
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "p"
  | "span"
  | "div"
  | "blockquote"
  | "code"
  | "small"
  | "strong"
const typographyStyles = {
  display:
    "font-heading text-[length:var(--ui-type-display)] leading-[var(--ui-leading-heading)] font-semibold tracking-tight text-balance",
  title:
    "font-heading text-[length:var(--ui-type-title)] leading-[var(--ui-leading-heading)] font-semibold tracking-tight text-balance",
  heading:
    "font-heading text-[length:var(--ui-type-heading)] leading-[var(--ui-leading-heading)] font-semibold tracking-tight",
  body: "max-w-[var(--ui-measure)] text-[length:var(--ui-type-body)] leading-[var(--ui-leading-body)]",
  lead: "max-w-[50ch] text-[length:var(--ui-type-lead)] leading-[var(--ui-leading-body)] text-muted-foreground",
  caption:
    "text-[length:var(--ui-type-caption)] leading-[var(--ui-leading-label)] text-muted-foreground",
  code: "rounded bg-muted px-1 py-0.5 font-mono text-sm",
  quote: "border-s-2 border-border ps-4 italic",
} as const
type TypographyProps = React.HTMLAttributes<HTMLElement> & {
  as?: TypographyTag
  variant?: keyof typeof typographyStyles
}

/** Choose document semantics separately from visual hierarchy. */
function Typography({
  as: Tag = "p",
  variant = "body",
  className,
  ...props
}: TypographyProps) {
  return (
    <Tag
      data-slot="typography"
      data-variant={variant}
      className={cn("break-words", typographyStyles[variant], className)}
      {...props}
    />
  )
}

export { Typography, typographyStyles }
export type { TypographyProps, TypographyTag }
