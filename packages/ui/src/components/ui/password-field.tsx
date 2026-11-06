import { useId, useState, type ReactNode, type Ref } from "react"
import { EyeIcon, EyeOffIcon } from "lucide-react"
import {
  TextField,
  Label,
  Text,
  FieldError,
  type TextFieldProps,
} from "react-aria-components"
import { cn } from "../../lib/utils"
import { Button } from "./button"
import { Input } from "./input"
import { useUiI18n } from "./i18n"

export type PasswordFieldProps = Omit<
  TextFieldProps,
  "children" | "className" | "type"
> & {
  label?: ReactNode
  description?: ReactNode
  errorMessage?: ReactNode
  placeholder?: string
  showLabel?: string
  hideLabel?: string
  isRevealed?: boolean
  defaultRevealed?: boolean
  onRevealedChange?: (isRevealed: boolean) => void
  className?: string
  inputRef?: Ref<HTMLInputElement>
  ref?: Ref<HTMLDivElement>
}

/** Password visibility is presentation state; validation and password policy stay with the host. */
export function PasswordField({
  label,
  description,
  errorMessage,
  placeholder,
  showLabel,
  hideLabel,
  isRevealed,
  defaultRevealed = false,
  onRevealedChange,
  className,
  inputRef,
  autoComplete = "current-password",
  ...props
}: PasswordFieldProps) {
  const { t } = useUiI18n()
  const generatedId = useId()
  const inputId = props.id ?? generatedId
  const [uncontrolledRevealed, setUncontrolledRevealed] =
    useState(defaultRevealed)
  const revealed = isRevealed ?? uncontrolledRevealed
  const Icon = revealed ? EyeOffIcon : EyeIcon
  function changeVisibility() {
    const next = !revealed
    if (isRevealed === undefined) setUncontrolledRevealed(next)
    onRevealedChange?.(next)
  }
  return (
    <TextField
      data-slot="password-field"
      className={cn(
        "group flex min-w-0 flex-col gap-1.5 text-sm text-foreground",
        className
      )}
      {...props}
      id={inputId}
      type={revealed ? "text" : "password"}
      autoComplete={autoComplete}
    >
      {({ isDisabled, isReadOnly }) => (
        <>
          {label && <Label className="font-medium">{label}</Label>}
          <div className="flex min-h-8 min-w-0 items-center gap-1 rounded-md border border-input bg-background ps-1 pe-1 group-data-invalid:border-destructive focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40 pointer-coarse:min-h-11">
            <Input
              ref={inputRef}
              type={revealed ? "text" : "password"}
              placeholder={placeholder}
              className="min-w-0 flex-1 border-0 bg-transparent focus-visible:ring-0"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={
                revealed
                  ? (hideLabel ?? t("hidePassword"))
                  : (showLabel ?? t("showPassword"))
              }
              aria-pressed={revealed}
              aria-controls={inputId}
              isDisabled={isDisabled || isReadOnly}
              onPress={changeVisibility}
            >
              <Icon aria-hidden />
            </Button>
          </div>
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
    </TextField>
  )
}
