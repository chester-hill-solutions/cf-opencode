import type { ReactNode, Ref } from "react"
import { MinusIcon, PlusIcon } from "lucide-react"
import {
  NumberField as AriaNumberField,
  Label,
  Text,
  FieldError,
  Group,
  type NumberFieldProps as AriaNumberFieldProps,
} from "react-aria-components"
import { cn } from "../../lib/utils"
import { Button } from "./button"
import { Input } from "./input"
import { useUiI18n } from "./i18n"

export type NumberFieldProps = Omit<
  AriaNumberFieldProps,
  "children" | "className"
> & {
  label?: ReactNode
  description?: ReactNode
  errorMessage?: ReactNode
  placeholder?: string
  incrementLabel?: string
  decrementLabel?: string
  className?: string
  inputRef?: Ref<HTMLInputElement>
  ref?: Ref<HTMLDivElement>
}

/** Locale parsing, formatting, range constraints and stepping come from React Aria. */
export function NumberField({
  label,
  description,
  errorMessage,
  placeholder,
  incrementLabel,
  decrementLabel,
  className,
  inputRef,
  ...props
}: NumberFieldProps) {
  const { t } = useUiI18n()
  return (
    <AriaNumberField
      data-slot="number-field"
      className={cn(
        "group flex min-w-0 flex-col gap-1.5 text-sm text-foreground",
        className
      )}
      {...props}
    >
      {({ state, isDisabled, isReadOnly }) => (
        <>
          {label && <Label className="font-medium">{label}</Label>}
          <Group className="flex min-h-8 min-w-0 items-center gap-1 rounded-md border border-input bg-background p-0.5 group-data-invalid:border-destructive focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40 pointer-coarse:min-h-11">
            <Button
              slot="decrement"
              variant="ghost"
              size="icon-sm"
              type="button"
              aria-label={decrementLabel ?? t("decrement")}
              isDisabled={isDisabled || isReadOnly || !state.canDecrement}
            >
              <MinusIcon aria-hidden />
            </Button>
            <Input
              ref={inputRef}
              placeholder={placeholder}
              className="min-w-0 flex-1 border-0 bg-transparent px-1 text-center tabular-nums focus-visible:ring-0"
            />
            <Button
              slot="increment"
              variant="ghost"
              size="icon-sm"
              type="button"
              aria-label={incrementLabel ?? t("increment")}
              isDisabled={isDisabled || isReadOnly || !state.canIncrement}
            >
              <PlusIcon aria-hidden />
            </Button>
          </Group>
          {description && (
            <Text slot="description" className="text-xs text-muted-foreground">
              {description}
            </Text>
          )}
          <FieldError className="text-xs text-destructive">
            {errorMessage}
          </FieldError>
        </>
      )}
    </AriaNumberField>
  )
}
