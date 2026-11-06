import type * as React from "react"
import { DirectionProvider as BaseDirectionProvider } from "@base-ui/react/direction-provider"
import { I18nProvider } from "react-aria-components"
import { useUiI18n } from "./i18n"

type DirectionProps = Omit<React.ComponentProps<"div">, "dir"> & {
  locale?: string
}

/** Locale drives both DOM direction and keyboard behavior in both primitive libraries. */
function Direction({ locale, children, ...props }: DirectionProps) {
  const { locale: inheritedLocale } = useUiI18n()
  return (
    <I18nProvider locale={locale ?? inheritedLocale}>
      <DirectionBoundary {...props}>{children}</DirectionBoundary>
    </I18nProvider>
  )
}
function DirectionBoundary({
  children,
  ...props
}: React.ComponentProps<"div">) {
  const { locale, direction } = useUiI18n()
  return (
    <BaseDirectionProvider direction={direction}>
      <div data-slot="direction" lang={locale} dir={direction} {...props}>
        {children}
      </div>
    </BaseDirectionProvider>
  )
}

export { Direction }
export type { DirectionProps }
