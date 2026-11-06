import type * as React from "react"
import { cn } from "../../lib/utils"
import { Button } from "./button"
import { useUiI18n } from "./i18n"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./table"
import type { Key, SortDescriptor } from "react-aria-components"

type DataTableColumn<T> = {
  id: string
  header: React.ReactNode
  cell: (item: T) => React.ReactNode
  isRowHeader?: boolean
  allowsSorting?: boolean
  className?: string
}
type DataTableProps<T> = {
  "aria-label": string
  items: T[]
  columns: DataTableColumn<T>[]
  getRowId: (item: T) => Key
  isLoading?: boolean
  loadingContent?: React.ReactNode
  emptyContent?: React.ReactNode
  toolbar?: React.ReactNode
  footer?: React.ReactNode
  className?: string
  sortDescriptor?: SortDescriptor
  onSortChange?: (descriptor: SortDescriptor) => void
  onRowAction?: (key: Key) => void
}

/** A controlled presentation layer. The host owns filtering, sorting and paging. */
function DataTable<T>({
  items,
  columns,
  getRowId,
  isLoading,
  loadingContent,
  emptyContent,
  toolbar,
  footer,
  className,
  ...props
}: DataTableProps<T>) {
  const { t } = useUiI18n()
  return (
    <div data-slot="data-table" className={cn("min-w-0 space-y-3", className)}>
      {toolbar}
      {isLoading && (
        <div role="status" className="text-sm text-muted-foreground">
          {loadingContent ?? t("tableLoading")}
        </div>
      )}
      <div
        data-slot="data-table-frame"
        aria-busy={isLoading || undefined}
        className="rounded-md border border-border"
      >
        <Table {...props}>
          <TableHeader>
            {columns.map((column, index) => (
              <TableHead
                key={column.id}
                id={column.id}
                isRowHeader={column.isRowHeader ?? index === 0}
                allowsSorting={column.allowsSorting}
                className={column.className}
              >
                {({ sortDirection }) => (
                  <span className="inline-flex items-center gap-1">
                    {column.header}
                    {sortDirection && (
                      <span aria-hidden>
                        {sortDirection === "ascending" ? "↑" : "↓"}
                      </span>
                    )}
                  </span>
                )}
              </TableHead>
            ))}
          </TableHeader>
          <TableBody
            items={items}
            renderEmptyState={() =>
              isLoading
                ? (loadingContent ?? t("tableLoading"))
                : (emptyContent ?? t("noResults"))
            }
          >
            {(item) => (
              <TableRow id={getRowId(item)}>
                {columns.map((column) => (
                  <TableCell key={column.id} className={column.className}>
                    {column.cell(item)}
                  </TableCell>
                ))}
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {footer}
    </div>
  )
}
function DataTablePagination({
  hasPreviousPage,
  hasNextPage,
  onPreviousPage,
  onNextPage,
  children,
  className,
  isDisabled,
}: {
  hasPreviousPage: boolean
  hasNextPage: boolean
  onPreviousPage: () => void
  onNextPage: () => void
  children?: React.ReactNode
  className?: string
  isDisabled?: boolean
}) {
  const { t } = useUiI18n()
  return (
    <div
      data-slot="data-table-pagination"
      className={cn(
        "flex flex-wrap items-center justify-end gap-2 text-sm",
        className
      )}
    >
      <div className="me-auto text-muted-foreground" aria-live="polite">
        {children}
      </div>
      <Button
        variant="outline"
        isDisabled={isDisabled || !hasPreviousPage}
        onPress={onPreviousPage}
      >
        {t("previous")}
      </Button>
      <Button
        variant="outline"
        isDisabled={isDisabled || !hasNextPage}
        onPress={onNextPage}
      >
        {t("next")}
      </Button>
    </div>
  )
}

export { DataTable, DataTablePagination }
export type { DataTableProps, DataTableColumn }
