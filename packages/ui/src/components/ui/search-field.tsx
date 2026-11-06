import type { ReactNode, Ref } from "react"
import { SearchIcon, XIcon } from "lucide-react"
import {
  SearchField as AriaSearchField,
  Label,
  Text,
  FieldError,
  type SearchFieldProps as AriaSearchFieldProps,
} from "react-aria-components"
import { cn } from "../../lib/utils"
import { Button } from "./button"
import { Input } from "./input"
import { useUiI18n } from "./i18n"

export type SearchFieldProps = Omit<
  AriaSearchFieldProps,
  "children" | "className"
> & {
  label?: ReactNode
  description?: ReactNode
  errorMessage?: ReactNode
  placeholder?: string
  clearLabel?: string
  className?: string
  inputRef?: Ref<HTMLInputElement>
  ref?: Ref<HTMLDivElement>
}

/** Search values, clearing and Enter submission follow React Aria's field contract. */
export function SearchField({
  label,
  description,
  errorMessage,
  placeholder,
  clearLabel,
  className,
  inputRef,
  ...props
}: SearchFieldProps) {
  const { t } = useUiI18n()
  return (
    <AriaSearchField
      data-slot="search-field"
      className={cn(
        "group flex min-w-0 flex-col gap-1.5 text-sm text-foreground",
        className
      )}
      {...props}
    >
      {({ isEmpty, isDisabled, isReadOnly }) => (
        <>
          {label && <Label className="font-medium">{label}</Label>}
          <div className="flex min-h-8 min-w-0 items-center gap-1 rounded-md border border-input bg-background ps-2 pe-1 group-data-invalid:border-destructive focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40 pointer-coarse:min-h-11">
            <SearchIcon
              aria-hidden
              className="size-4 shrink-0 text-muted-foreground"
            />
            <Input
              ref={inputRef}
              placeholder={placeholder}
              className="min-w-0 flex-1 border-0 bg-transparent px-1.5 focus-visible:ring-0 [&::-webkit-search-cancel-button]:appearance-none"
            />
            {!isEmpty && (
              <Button
                variant="ghost"
                size="icon-sm"
                type="button"
                aria-label={clearLabel ?? t("clearSearch")}
                isDisabled={isDisabled || isReadOnly}
              >
                <XIcon aria-hidden />
              </Button>
            )}
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
    </AriaSearchField>
  )
}
