import { cn } from "../../lib/utils"
import { Separator } from "./separator"
import { useUiI18n } from "./i18n"

type AppShellNavItem = {
  href: string
  label: React.ReactNode
  active?: boolean
}

type AppShellNavLinkProps = {
  href: string
  "aria-current"?: "page"
  "data-active"?: true
  className: string
  children: React.ReactNode
}

function AppShell({
  className,
  brand,
  nav,
  actions,
  children,
  renderNavLink,
  ...props
}: React.ComponentProps<"div"> & {
  brand: React.ReactNode
  nav?: AppShellNavItem[]
  actions?: React.ReactNode
  renderNavLink?: (
    item: AppShellNavItem,
    props: AppShellNavLinkProps
  ) => React.ReactNode
}) {
  const { t } = useUiI18n()
  return (
    <div
      data-slot="app-shell"
      className={cn(
        "flex min-h-svh flex-col bg-background text-foreground",
        className
      )}
      {...props}
    >
      <header
        data-slot="app-shell-header"
        className="sticky top-0 z-40 border-b border-border bg-card/95 backdrop-blur supports-backdrop-filter:bg-card/80"
      >
        <div
          data-slot="app-shell-header-inner"
          className="mx-auto flex min-h-14 w-full max-w-6xl flex-wrap items-center gap-4 px-4 py-3"
        >
          <div
            data-slot="app-shell-brand"
            className="shrink-0 font-heading text-lg font-semibold tracking-tight"
          >
            {brand}
          </div>
          {nav && nav.length > 0 ? (
            <>
              <Separator
                data-slot="app-shell-divider"
                orientation="vertical"
                className="hidden h-6 md:block"
              />
              <nav
                data-slot="app-shell-nav"
                aria-label={t("primaryNavigation")}
                className="order-3 flex w-full min-w-0 items-center gap-1 overflow-x-auto md:order-none md:w-auto md:flex-1"
              >
                {nav.map((item) => {
                  const linkProps: AppShellNavLinkProps = {
                    href: item.href,
                    "data-active": item.active || undefined,
                    "aria-current": item.active ? "page" : undefined,
                    className: cn(
                      "rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors",
                      item.active
                        ? "bg-primary/10 font-medium text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    ),
                    children: item.label,
                  }
                  if (renderNavLink) {
                    return (
                      <span key={item.href} className="contents">
                        {renderNavLink(item, linkProps)}
                      </span>
                    )
                  }
                  return (
                    <a key={item.href} {...linkProps}>
                      {item.label}
                    </a>
                  )
                })}
              </nav>
            </>
          ) : (
            <div className="flex-1" />
          )}
          {actions ? (
            <div
              data-slot="app-shell-actions"
              className="ml-auto flex shrink-0 items-center gap-2"
            >
              {actions}
            </div>
          ) : null}
        </div>
      </header>
      <main
        data-slot="app-shell-main"
        className="mx-auto w-full max-w-6xl flex-1 px-4 py-6"
      >
        {children}
      </main>
    </div>
  )
}

export { AppShell, type AppShellNavItem, type AppShellNavLinkProps }
