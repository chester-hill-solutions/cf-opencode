import { useId, type ComponentProps } from "react"
import { brandColors, logoBox, logoColourFields, logoPaths, logoViewBox } from "../brand"
import { cn } from "../lib/utils"

export type LogoVariant = "colour" | "mono"

/**
 * The mark prints in B3 squeegee colour by default. `mono` keeps `currentColor`
 * for small or already-coloured surfaces, where the colour fields would muddle.
 */
export function Logo({ className, variant = "colour", ...props }: ComponentProps<"svg"> & { variant?: LogoVariant }) {
  const clip = `abo-logo-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`
  if (variant === "mono") {
    return (
      <svg viewBox={logoViewBox} fill="currentColor" aria-hidden="true" className={cn("abo-logo", className)} {...props}>
        {logoPaths.map((path) => (
          <path key={path} d={path} />
        ))}
      </svg>
    )
  }
  return (
    <svg viewBox={logoViewBox} aria-hidden="true" className={cn("abo-logo", className)} {...props}>
      <defs>
        <clipPath id={clip} clipPathUnits="userSpaceOnUse">
          {logoPaths.map((path) => (
            <path key={path} d={path} />
          ))}
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <rect {...logoBox} fill={brandColors.ultramarine} />
        {logoColourFields.map((field) => (
          <path key={field.ink} d={field.d} fill={brandColors[field.ink]} />
        ))}
      </g>
    </svg>
  )
}

export function BrandLockup({ className, variant }: { className?: string; variant?: LogoVariant }) {
  return (
    <span className={cn("abo-brand", className)} role="img" aria-label="Aboiteau">
      <Logo variant={variant} />
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
