import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils"

const metricCardVariants = cva(
  "flex flex-col gap-1 rounded-lg border border-border bg-card p-3 text-card-foreground shadow-sm",
  {
    variants: {
      tone: {
        muted: "border-t-[3px] border-t-muted-foreground/40",
        ok: "border-t-[3px] border-t-success",
        warn: "border-t-[3px] border-t-warning",
        danger: "border-t-[3px] border-t-destructive",
        action: "border-t-[3px] border-t-info",
      },
    },
    defaultVariants: {
      tone: "muted",
    },
  }
)

type MetricTone = NonNullable<VariantProps<typeof metricCardVariants>["tone"]>

function MetricCard({
  className,
  tone = "muted",
  label,
  value,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof metricCardVariants> & {
    label: React.ReactNode
    value: React.ReactNode
  }) {
  return (
    <div
      data-slot="metric-card"
      data-tone={tone}
      className={cn(metricCardVariants({ tone }), className)}
      {...props}
    >
      <div
        data-slot="metric-card-value"
        className="text-2xl font-semibold tracking-tight tabular-nums"
      >
        {value}
      </div>
      <div
        data-slot="metric-card-label"
        className="text-xs text-muted-foreground"
      >
        {label}
      </div>
    </div>
  )
}

export { MetricCard, metricCardVariants, type MetricTone }
