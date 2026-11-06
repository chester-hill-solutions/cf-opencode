import type { ComponentProps } from "react"
import { logoPaths, logoViewBox } from "../brand"
import { cn } from "../lib/utils"

export function Logo({ className, ...props }: ComponentProps<"svg">) {
  return (
    <svg
      viewBox={logoViewBox}
      fill="currentColor"
      aria-hidden="true"
      className={cn("abo-logo", className)}
      {...props}
    >
      {logoPaths.map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  )
}

export function BrandLockup({ className }: { className?: string }) {
  return (
    <span className={cn("abo-brand", className)} role="img" aria-label="Aboiteau">
      <Logo />
      <span className="abo-wordmark" aria-hidden="true">
        aboiteau
      </span>
    </span>
  )
}

export function InkField({ className }: { className?: string }) {
  return (
    <img
      className={cn("abo-ink-field", className)}
      src="/brand/ink-field.png"
      alt=""
      aria-hidden="true"
    />
  )
}
