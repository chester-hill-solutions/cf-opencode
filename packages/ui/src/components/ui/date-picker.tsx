import type * as React from "react"
import { CalendarIcon } from "lucide-react"
import {
  DatePicker as AriaDatePicker,
  DateRangePicker as AriaDateRangePicker,
  DateField as AriaDateField,
  TimeField as AriaTimeField,
  DateInput,
  DateSegment,
  Dialog,
  FieldError,
  Group,
  Label,
  Popover,
  Text,
  type DatePickerProps as AriaDatePickerProps,
  type DateRangePickerProps as AriaDateRangePickerProps,
  type DateFieldProps as AriaDateFieldProps,
  type TimeFieldProps as AriaTimeFieldProps,
  type DateValue,
  type TimeValue,
} from "react-aria-components"
import { cn } from "../../lib/utils"
import { Button } from "./button"
import { Calendar, RangeCalendar } from "./calendar"
import { useUiI18n } from "./i18n"

type FieldPresentation = {
  label?: React.ReactNode
  description?: React.ReactNode
  errorMessage?: React.ReactNode
  className?: string
}
const fieldClassName = "flex min-w-0 flex-col gap-1.5 text-sm text-foreground"
const inputClassName =
  "flex min-h-8 min-w-0 flex-wrap items-center rounded-md border border-input bg-background px-2 py-1 outline-none focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40 group-data-invalid:border-destructive pointer-coarse:min-h-11"

function SegmentedDateInput({ slot }: { slot?: "start" | "end" }) {
  return (
    <DateInput
      data-slot="date-input"
      slot={slot}
      className="flex min-w-0 flex-wrap items-center"
    >
      {(segment) => (
        <DateSegment
          data-slot="date-segment"
          segment={segment}
          className="rounded px-0.5 tabular-nums outline-none data-focused:bg-primary data-focused:text-primary-foreground data-placeholder:text-muted-foreground data-disabled:opacity-50"
        />
      )}
    </DateInput>
  )
}
function DateFieldFeedback({
  description,
  errorMessage,
}: Pick<FieldPresentation, "description" | "errorMessage">) {
  return (
    <>
      {description && (
        <Text slot="description" className="text-xs text-muted-foreground">
          {description}
        </Text>
      )}
      <FieldError className="text-xs text-destructive">
        {errorMessage}
      </FieldError>
    </>
  )
}
function DatePicker<T extends DateValue>({
  label,
  description,
  errorMessage,
  className,
  calendarLabel,
  ...props
}: Omit<AriaDatePickerProps<T>, "children" | "className"> &
  FieldPresentation & { calendarLabel?: string }) {
  const { t } = useUiI18n()
  return (
    <AriaDatePicker
      data-slot="date-picker"
      className={cn("group", fieldClassName, className)}
      {...props}
    >
      {label && <Label className="font-medium">{label}</Label>}
      <Group
        data-slot="date-field-group"
        className={cn(inputClassName, "gap-2")}
      >
        <SegmentedDateInput />
        <Button
          variant="ghost"
          size="icon-sm"
          className="ms-auto"
          isDisabled={props.isDisabled || props.isReadOnly}
          aria-label={calendarLabel ?? t("chooseDate")}
        >
          <CalendarIcon aria-hidden />
        </Button>
      </Group>
      <DateFieldFeedback
        description={description}
        errorMessage={errorMessage}
      />
      <Popover
        data-slot="date-picker-popover"
        placement="bottom start"
        className="z-50 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
      >
        <Dialog className="outline-none">
          <Calendar />
        </Dialog>
      </Popover>
    </AriaDatePicker>
  )
}
function DateRangePicker<T extends DateValue>({
  label,
  description,
  errorMessage,
  className,
  calendarLabel,
  ...props
}: Omit<AriaDateRangePickerProps<T>, "children" | "className"> &
  FieldPresentation & { calendarLabel?: string }) {
  const { t } = useUiI18n()
  return (
    <AriaDateRangePicker
      data-slot="date-range-picker"
      className={cn("group", fieldClassName, className)}
      {...props}
    >
      {label && <Label className="font-medium">{label}</Label>}
      <Group
        data-slot="date-field-group"
        className={cn(inputClassName, "gap-2")}
      >
        <SegmentedDateInput slot="start" />
        <span aria-hidden>–</span>
        <SegmentedDateInput slot="end" />
        <Button
          variant="ghost"
          size="icon-sm"
          className="ms-auto"
          isDisabled={props.isDisabled || props.isReadOnly}
          aria-label={calendarLabel ?? t("chooseDateRange")}
        >
          <CalendarIcon aria-hidden />
        </Button>
      </Group>
      <DateFieldFeedback
        description={description}
        errorMessage={errorMessage}
      />
      <Popover
        data-slot="date-picker-popover"
        placement="bottom start"
        className="z-50 max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
      >
        <Dialog className="outline-none">
          <RangeCalendar />
        </Dialog>
      </Popover>
    </AriaDateRangePicker>
  )
}
function DateField<T extends DateValue>({
  label,
  description,
  errorMessage,
  className,
  ...props
}: Omit<AriaDateFieldProps<T>, "children" | "className"> & FieldPresentation) {
  return (
    <AriaDateField
      data-slot="date-field"
      className={cn("group", fieldClassName, className)}
      {...props}
    >
      {label && <Label className="font-medium">{label}</Label>}
      <div data-slot="date-field-group" className={inputClassName}>
        <SegmentedDateInput />
      </div>
      <DateFieldFeedback
        description={description}
        errorMessage={errorMessage}
      />
    </AriaDateField>
  )
}
function TimeField<T extends TimeValue>({
  label,
  description,
  errorMessage,
  className,
  ...props
}: Omit<AriaTimeFieldProps<T>, "children" | "className"> & FieldPresentation) {
  return (
    <AriaTimeField
      data-slot="time-field"
      className={cn("group", fieldClassName, className)}
      {...props}
    >
      {label && <Label className="font-medium">{label}</Label>}
      <div data-slot="date-field-group" className={inputClassName}>
        <SegmentedDateInput />
      </div>
      <DateFieldFeedback
        description={description}
        errorMessage={errorMessage}
      />
    </AriaTimeField>
  )
}

export { DatePicker, DateRangePicker, DateField, TimeField }
