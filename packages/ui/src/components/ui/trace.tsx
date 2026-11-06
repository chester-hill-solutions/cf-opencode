import type { ComponentProps, ReactNode } from "react"
import {
  CheckIcon,
  ChevronRightIcon,
  CircleIcon,
  Loader2Icon,
  SquareIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { cn } from "../../lib/utils"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible"
import { useUiI18n } from "./i18n"

export type TraceStep = {
  id: string
  label: ReactNode
  status: "pending" | "running" | "complete" | "error" | "cancelled"
  description?: ReactNode
  meta?: ReactNode
  children?: ReactNode
}
export type TraceProps = Omit<ComponentProps<"section">, "children"> & {
  steps: readonly TraceStep[]
  label?: string
}

export function Trace({ steps, label, className, ...props }: TraceProps) {
  const { t } = useUiI18n()
  return (
    <section
      data-slot="trace"
      aria-label={label ?? t("trace")}
      className={cn(
        "min-w-0 rounded-lg border border-border bg-card text-card-foreground",
        className
      )}
      {...props}
    >
      <ol className="m-0 list-none divide-y divide-border p-0">
        {steps.map((step) => {
          const Icon =
            step.status === "running"
              ? Loader2Icon
              : step.status === "complete"
                ? CheckIcon
                : step.status === "error"
                  ? TriangleAlertIcon
                  : step.status === "cancelled"
                    ? SquareIcon
                    : CircleIcon
          const status = t(
            step.status === "running"
              ? "traceRunning"
              : step.status === "complete"
                ? "traceComplete"
                : step.status === "error"
                  ? "traceError"
                  : step.status === "cancelled"
                    ? "traceCancelled"
                    : "tracePending"
          )
          const heading = (
            <>
              <Icon
                className={cn(
                  "size-4 shrink-0",
                  step.status === "running" && "animate-spin",
                  step.status === "error" && "text-destructive"
                )}
                aria-hidden
              />
              <span
                data-slot="trace-heading"
                className="min-w-0 flex-1 text-start break-words"
              >
                <span data-slot="trace-label">{step.label}</span>{" "}
                {step.description && (
                  <span
                    data-slot="trace-description"
                    className="block text-xs text-muted-foreground"
                  >
                    {step.description}
                  </span>
                )}
              </span>{" "}
              {step.meta && (
                <span
                  data-slot="trace-meta"
                  className="shrink-0 text-xs text-muted-foreground"
                >
                  {step.meta}
                </span>
              )}{" "}
              <span
                data-slot="trace-status"
                className="shrink-0 text-xs text-muted-foreground"
              >
                {status}
              </span>
            </>
          )
          return (
            <li key={step.id} data-status={step.status}>
              {step.children ? (
                <Collapsible>
                  <CollapsibleTrigger
                    data-slot="trace-trigger"
                    className="group flex w-full items-center gap-2 px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {heading}
                    <ChevronRightIcon
                      className="size-3 shrink-0 transition-transform group-aria-expanded:rotate-90 rtl:rotate-180"
                      aria-hidden
                    />
                  </CollapsibleTrigger>
                  <CollapsibleContent
                    data-slot="trace-content"
                    className="px-3 pb-3 text-sm"
                  >
                    {step.children}
                  </CollapsibleContent>
                </Collapsible>
              ) : (
                <div className="flex items-center gap-2 px-3 py-2 text-sm">
                  {heading}
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}
