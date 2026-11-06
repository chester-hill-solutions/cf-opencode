import { createContext, useContext, type ReactNode } from "react"
import { DirectionProvider } from "@base-ui/react/direction-provider"
import { I18nProvider, useLocale } from "react-aria-components"

export const defaultUiMessages = {
  clear: "Clear",
  close: "Close",
  loading: "Loading",
  toggleSidebar: "Toggle Sidebar",
  sidebarTitle: "Sidebar",
  sidebarDescription: "Displays the mobile sidebar.",
  search: "Search",
  commandTitle: "Command Palette",
  commandDescription: "Search for a command to run...",
  primaryNavigation: "Primary",
  breadcrumb: "breadcrumb",
  more: "More",
  pagination: "pagination",
  previous: "Previous",
  previousPage: "Go to previous page",
  next: "Next",
  nextPage: "Go to next page",
  morePages: "More pages",
  previousSlide: "Previous slide",
  nextSlide: "Next slide",
  checklist: "Checklist",
  ready: "Ready",
  passed: "Passed",
  warning: "Warning",
  failed: "Failed",
  info: "Info",
  chooseDate: "Choose date",
  chooseDateRange: "Choose date range",
  noResults: "No results.",
  tableLoading: "Loading…",
  questionnaireSubmit: "Submit",
  questionnaireProgress: "Step {current} of {total}",
  removeItem: "Remove {item}",
  moveItemUp: "Move {item} up",
  moveItemDown: "Move {item} down",
  addItem: "Add item",
  noItems: "No items yet",
  noItemsSelected: "No items selected",
  unavailableItem: "Unavailable item",
  searchItems: "Search items",
  onlySelected: "Selected items",
  selectMatching: "Select matching items",
  unsavedChanges: "You have unsaved changes",
  saveChanges: "Save changes",
  saving: "Saving…",
  discardChanges: "Discard changes",
  copyCode: "Copy code",
  code: "Code",
  terminalOutput: "Terminal output",
  codeDiff: "Code diff",
  copied: "Copied",
  copyFailed: "Could not copy. Select the text to copy it.",
  removeAttachment: "Remove attachment",
  uploading: "Uploading",
  uploadFailed: "Upload failed",
  downloadAttachment: "Download attachment",
  showMore: "Show more",
  showLess: "Show less",
  conversation: "Conversation",
  loadOlderMessages: "Load earlier messages",
  loadMessagesFailed: "Could not load earlier messages",
  jumpToLatest: "Jump to latest",
  trace: "Activity",
  tracePending: "Pending",
  traceRunning: "Running",
  traceComplete: "Complete",
  traceError: "Failed",
  traceCancelled: "Stopped",
  clearSearch: "Clear search",
  increment: "Increase value",
  decrement: "Decrease value",
  showPassword: "Show password",
  hidePassword: "Hide password",
  chooseFiles: "Choose files",
  dropFiles: "Drop files here or choose files",
  fileTypeRejected: "{file} has an unsupported file type",
  fileSizeRejected: "{file} exceeds the file size limit",
  fileCountRejected: "{file} exceeds the file count limit",
  removeFile: "Remove {file}",
  errorSummaryTitle: "There is a problem",
  filters: "Filters",
  clearFilters: "Clear filters",
  removeFilter: "Remove filter: {filter}",
  selectedCount: "{count} selected",
  clearSelection: "Clear selection",
  bulkActions: "Bulk actions",
} as const

export type UiMessageKey = keyof typeof defaultUiMessages
export type UiMessages = Partial<Record<UiMessageKey, string>>
export type UiMessageValues = Record<string, string | number>
export type UiTranslate = (
  key: UiMessageKey,
  fallback: string,
  values?: UiMessageValues
) => string | undefined
export type UiI18n = {
  locale: string
  direction: "ltr" | "rtl"
  t: (key: UiMessageKey, values?: UiMessageValues) => string
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string
  formatDate: (
    value: Date | number,
    options?: Intl.DateTimeFormatOptions
  ) => string
}

type UiI18nOptions = {
  messages?: UiMessages
  translate?: UiTranslate
  timeZone?: string
}

const UiI18nContext = createContext<UiI18nOptions>({})

/** Locale behavior comes from React Aria; hosts own their translation catalogs. */
export function UiI18nProvider({
  locale,
  messages,
  translate,
  timeZone,
  children,
}: UiI18nOptions & { locale?: string; children: ReactNode }) {
  return (
    <I18nProvider locale={locale}>
      <UiI18nContext.Provider value={{ messages, translate, timeZone }}>
        <LocaleDirection>{children}</LocaleDirection>
      </UiI18nContext.Provider>
    </I18nProvider>
  )
}

function LocaleDirection({ children }: { children: ReactNode }) {
  const { direction } = useLocale()
  return <DirectionProvider direction={direction}>{children}</DirectionProvider>
}

export function useUiI18n(): UiI18n {
  const { locale, direction } = useLocale()
  const { messages, translate, timeZone } = useContext(UiI18nContext)
  return {
    locale,
    direction,
    t: (key: UiMessageKey, values?: UiMessageValues): string => {
      const fallback = messages?.[key] ?? defaultUiMessages[key]
      const message = translate?.(key, fallback, values) ?? fallback
      return message.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
        values?.[name] === undefined ? placeholder : String(values[name])
      )
    },
    formatNumber: (value: number, options?: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat(locale, options).format(value),
    formatDate: (value: Date | number, options?: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(locale, { timeZone, ...options }).format(value),
  }
}
