import * as React from "react"
import { cn } from "../../lib/utils"
import { Button } from "./button"
import { useUiI18n } from "./i18n"

type QuestionnaireStep = {
  id: string
  title: React.ReactNode
  description?: React.ReactNode
  content: React.ReactNode
  isValid?: boolean
}
type QuestionnaireProps = Omit<
  React.ComponentProps<"form">,
  "onSubmit" | "onChange" | "children"
> & {
  steps: QuestionnaireStep[]
  value: string
  onValueChange: (id: string) => void
  onComplete: () => void
  isPending?: boolean
  previousLabel?: React.ReactNode
  nextLabel?: React.ReactNode
  submitLabel?: React.ReactNode
}

/** Controlled step navigation; hosts own answer state and validation policy. */
function Questionnaire({
  steps,
  value,
  onValueChange,
  onComplete,
  isPending = false,
  previousLabel,
  nextLabel,
  submitLabel,
  className,
  ...props
}: QuestionnaireProps) {
  const { t } = useUiI18n()
  const heading = React.useRef<HTMLHeadingElement>(null)
  const priorStep = React.useRef(value)
  const id = React.useId()
  const index = steps.findIndex((step) => step.id === value)
  const step = steps[index]
  React.useEffect(() => {
    if (priorStep.current !== value) heading.current?.focus()
    priorStep.current = value
  }, [value])
  if (!step) return null
  const isLast = index === steps.length - 1
  return (
    <form
      data-slot="questionnaire"
      aria-labelledby={`${id}-title`}
      className={cn("space-y-5", className)}
      {...props}
      onSubmit={(event) => {
        event.preventDefault()
        if (
          isPending ||
          step.isValid === false ||
          !event.currentTarget.reportValidity()
        )
          return
        if (isLast) onComplete()
        else onValueChange(steps[index + 1].id)
      }}
    >
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {t("questionnaireProgress", {
            current: index + 1,
            total: steps.length,
          })}
        </p>
        <h2
          id={`${id}-title`}
          ref={heading}
          tabIndex={-1}
          className="text-lg font-semibold outline-none"
        >
          {step.title}
        </h2>
        {step.description && (
          <p className="text-sm text-muted-foreground">{step.description}</p>
        )}
      </div>
      <fieldset
        key={step.id}
        disabled={isPending}
        className="min-w-0 space-y-4"
      >
        {step.content}
      </fieldset>
      <div className="flex flex-wrap justify-between gap-2">
        <Button
          variant="outline"
          isDisabled={index === 0 || isPending}
          onPress={() => onValueChange(steps[index - 1].id)}
        >
          {previousLabel ?? t("previous")}
        </Button>
        <Button
          type="submit"
          pending={isPending}
          isDisabled={step.isValid === false}
        >
          {isLast
            ? (submitLabel ?? t("questionnaireSubmit"))
            : (nextLabel ?? t("next"))}
        </Button>
      </div>
    </form>
  )
}

export { Questionnaire }
export type { QuestionnaireProps, QuestionnaireStep }
