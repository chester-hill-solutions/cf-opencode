import { useId, useState } from "react"
import {
  Button,
  Calendar,
  Checkbox,
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  DateField,
  DatePicker,
  DateRangePicker,
  ErrorSummary,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FileUpload,
  FilterBar,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
  NativeSelect,
  NumberField,
  OrderedSelection,
  PasswordField,
  Questionnaire,
  RadioGroup,
  RadioGroupItem,
  RangeCalendar,
  RepeatableField,
  SearchField,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SelectionPicker,
  Slider,
  Switch,
  TagInput,
  Textarea,
  TimeField,
  type ActiveFilter,
  type ErrorSummaryItem,
  type FileUploadRejection,
  type SelectionOption,
} from "@aboiteau/ui"
import { Demo, GallerySection, Row, Stack } from "./shared"

const permissionOptions: SelectionOption[] = [
  {
    id: "contacts:read",
    label: "Read contacts",
    description: "View contact profiles and history.",
    group: "Contacts",
  },
  {
    id: "contacts:write",
    label: "Update contacts",
    description: "Edit contact information.",
    group: "Contacts",
  },
  {
    id: "contacts:delete",
    label: "Delete contacts",
    description: "Requires administrator access.",
    group: "Contacts",
    isDisabled: true,
  },
  {
    id: "events:read",
    label: "Read events",
    description: "View upcoming and previous events.",
    group: "Events",
  },
  {
    id: "events:write",
    label: "Manage events",
    description: "Create and update events.",
    group: "Events",
  },
]

export function Inputs() {
  const [selected, setSelected] = useState(true)
  const [tagValue, setTagValue] = useState(["rules", "release"])
  const [files, setFiles] = useState<File[]>([])
  const [rejected, setRejected] = useState<FileUploadRejection[]>([])
  const [links, setLinks] = useState([
    { id: "home", label: "Home", url: "/" },
    { id: "about", label: "About", url: "/about" },
  ])
  const [permissions, setPermissions] = useState(["contacts:read"])
  const [order, setOrder] = useState(["events:read", "contacts:read"])
  const statusId = useId()
  const [status, setStatus] = useState("active")
  const [assigned, setAssigned] = useState(true)
  const [step, setStep] = useState("details")
  const [complete, setComplete] = useState(false)
  const [errors] = useState<ErrorSummaryItem[]>([
    { id: "name", message: "Enter a contact name.", fieldId: "gallery-error-name" },
    { id: "email", message: "Enter an email address.", fieldId: "gallery-error-email" },
  ])

  const filters: ActiveFilter[] = [
    ...(status === "all" ? [] : [{ id: "status", label: `Status: ${status}` }]),
    ...(assigned ? [{ id: "owner", label: "Assigned to me" }] : []),
  ]

  return (
    <GallerySection
      id="inputs"
      number="05"
      accent="vermilion"
      title="Forms & controls"
      description="Native validation, React Aria behaviour and Aboiteau surfaces. Labels stay visible, help sits beside the field it explains and drafts survive an error."
    >
      <Demo name="Input & textarea">
        <Field>
          <FieldLabel htmlFor="gallery-repository">Repository URL</FieldLabel>
          <Input id="gallery-repository" type="url" placeholder="https://github.com/team/repo" />
          <FieldDescription>Used for the workspace checkout.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="gallery-rules">Shell patterns</FieldLabel>
          <Textarea id="gallery-rules" defaultValue={"git status *\nbun test *"} spellCheck={false} />
        </Field>
      </Demo>

      <Demo name="Native select">
        <Field>
          <FieldLabel htmlFor="gallery-density">Density</FieldLabel>
          <NativeSelect id="gallery-density" defaultValue="default">
            <option value="compact">Compact</option>
            <option value="default">Default</option>
            <option value="touch">Touch</option>
          </NativeSelect>
        </Field>
      </Demo>

      <Demo name="Checkbox, switch & radio">
        <Stack>
          <Checkbox isSelected={selected} onChange={setSelected}>
            Stream progress
          </Checkbox>
          <Checkbox isDisabled>Unavailable option</Checkbox>
          <Switch defaultSelected>Live reload</Switch>
          <Switch size="sm">Strict validation</Switch>
          <RadioGroup defaultValue="staging" aria-label="Deploy target">
            <RadioGroupItem value="production" className="w-auto gap-2 text-sm">
              Production
            </RadioGroupItem>
            <RadioGroupItem value="staging" className="w-auto gap-2 text-sm">
              Staging
            </RadioGroupItem>
            <RadioGroupItem value="preview" className="w-auto gap-2 text-sm">
              Preview
            </RadioGroupItem>
          </RadioGroup>
        </Stack>
      </Demo>

      <Demo name="Validation" note="The message sits below the field; the field stays populated.">
        <Field>
          <FieldLabel htmlFor="gallery-error">Model reference</FieldLabel>
          <Input
            id="gallery-error"
            defaultValue="missing-provider"
            aria-invalid="true"
            aria-describedby="gallery-error-message"
          />
          <FieldError id="gallery-error-message">
            Enter a reference in provider/model format.
          </FieldError>
        </Field>
      </Demo>

      <Demo name="Slider & number field">
        <Stack>
          <Slider defaultValue={50} aria-label="Poll interval" />
          <NumberField label="Retries" defaultValue={2} minValue={0} maxValue={10} />
        </Stack>
      </Demo>

      <Demo name="Input OTP">
        <InputOTP maxLength={6} aria-label="One-time password">
          <InputOTPGroup>
            <InputOTPSlot index={0} />
            <InputOTPSlot index={1} />
            <InputOTPSlot index={2} />
          </InputOTPGroup>
          <InputOTPSeparator />
          <InputOTPGroup>
            <InputOTPSlot index={3} />
            <InputOTPSlot index={4} />
            <InputOTPSlot index={5} />
          </InputOTPGroup>
        </InputOTP>
      </Demo>

      <Demo name="Input group, search & password">
        <Stack>
          <InputGroup>
            <InputGroupInput placeholder="api.example.com" />
            <InputGroupAddon align="inline-end">
              <InputGroupButton variant="ghost">Check</InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <SearchField label="Search settings" placeholder="Search settings" />
          <PasswordField label="API token" placeholder="Paste a token" />
        </Stack>
      </Demo>

      <Demo name="Tag input">
        <TagInput label="Labels" value={tagValue} onChange={setTagValue} placeholder="Add a label" />
      </Demo>

      <Demo name="File upload" note={`${files.length} accepted, ${rejected.length} rejected in the last selection.`}>
        <FileUpload
          label="Supporting documents"
          description="Up to three files, 2 MB each."
          value={files}
          onChange={(next) => {
            setFiles(next)
            setRejected([])
          }}
          onReject={setRejected}
          multiple
          accept=".csv,application/pdf,image/*"
          maxFiles={3}
          maxFileSize={2 * 1024 * 1024}
        />
      </Demo>

      <Demo name="Repeatable field" wide>
        <RepeatableField
          label="Navigation links"
          description="Keep between one and five links, in display order."
          value={links}
          onChange={setLinks}
          minItems={1}
          maxItems={5}
          addLabel="Add link"
          getItemKey={(item) => item.id}
          getItemLabel={(item, index) => item.label || `Link ${index + 1}`}
          createItem={() => ({ id: crypto.randomUUID(), label: "", url: "" })}
          renderItem={({ item, onChange, isDisabled }) => (
            <div className="grid w-full gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`${item.id}-label`}>Label</FieldLabel>
                <Input
                  id={`${item.id}-label`}
                  value={item.label}
                  disabled={isDisabled}
                  onChange={(event) => onChange({ ...item, label: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${item.id}-url`}>URL</FieldLabel>
                <Input
                  id={`${item.id}-url`}
                  value={item.url}
                  disabled={isDisabled}
                  onChange={(event) => onChange({ ...item, url: event.target.value })}
                />
              </Field>
            </div>
          )}
        />
      </Demo>

      <Demo name="Selection picker & ordered selection" wide>
        <div className="grid w-full gap-6 lg:grid-cols-2">
          <SelectionPicker
            label="API permissions"
            description="Choose the access available to this integration."
            options={permissionOptions}
            value={permissions}
            onChange={setPermissions}
          />
          <Stack>
            <OrderedSelection
              label="Display order"
              options={permissionOptions}
              value={order}
              onChange={setOrder}
            />
            <p className="catalog-note" style={{ margin: 0 }}>
              {permissions.length} permissions selected
            </p>
          </Stack>
        </div>
      </Demo>

      <Demo name="Filter bar" wide>
        <FilterBar
          activeFilters={filters}
          onRemove={(id) => {
            if (id === "status") setStatus("all")
            if (id === "owner") setAssigned(false)
          }}
          onClear={() => {
            setStatus("all")
            setAssigned(false)
          }}
          controls={
            <>
              <label htmlFor={statusId} className="grid gap-1.5 text-sm">
                Status
                <NativeSelect
                  id={statusId}
                  value={status}
                  onChange={(event) => setStatus(event.target.value)}
                >
                  <option value="all">All statuses</option>
                  <option value="active">Active</option>
                  <option value="archived">Archived</option>
                </NativeSelect>
              </label>
              <Checkbox isSelected={assigned} onChange={setAssigned}>
                Assigned to me
              </Checkbox>
            </>
          }
          actions={<Button variant="outline">Save view</Button>}
        />
      </Demo>

      <Demo name="Error summary" wide>
        <Stack>
          <ErrorSummary errors={errors} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="gallery-error-name">Contact name</FieldLabel>
              <Input id="gallery-error-name" aria-invalid="true" />
            </Field>
            <Field>
              <FieldLabel htmlFor="gallery-error-email">Email address</FieldLabel>
              <Input id="gallery-error-email" aria-invalid="true" type="email" />
            </Field>
          </div>
        </Stack>
      </Demo>

      <Demo name="Questionnaire" wide>
        {complete ? (
          <p role="status" className="catalog-note" style={{ margin: 0 }}>
            Step complete. Continue in the host application.
          </p>
        ) : (
          <Questionnaire
            value={step}
            onValueChange={setStep}
            onComplete={() => setComplete(true)}
            steps={[
              {
                id: "details",
                title: "Your details",
                description: "Tell us who is joining.",
                content: (
                  <Field>
                    <FieldLabel htmlFor="gallery-questionnaire-name">Name</FieldLabel>
                    <Input id="gallery-questionnaire-name" required name="name" />
                  </Field>
                ),
              },
              {
                id: "region",
                title: "Choose a region",
                content: (
                  <Field>
                    <FieldLabel htmlFor="gallery-questionnaire-region">Region</FieldLabel>
                    <NativeSelect id="gallery-questionnaire-region" name="region" defaultValue="on">
                      <option value="on">Ontario</option>
                      <option value="qc">Québec</option>
                    </NativeSelect>
                  </Field>
                ),
              },
            ]}
          />
        )}
      </Demo>

      <Demo name="Select">
        <Field>
          <FieldLabel>Density</FieldLabel>
          <Select placeholder="Choose density" defaultSelectedKey="compact">
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem id="compact">Compact</SelectItem>
              <SelectItem id="comfortable">Comfortable</SelectItem>
              <SelectItem id="spacious">Spacious</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </Demo>

      <Demo name="Combobox">
        <Combobox aria-label="Environment">
          <ComboboxInput placeholder="Select environment" />
          <ComboboxContent>
            <ComboboxList
              renderEmptyState={() => <ComboboxEmpty>No matching environments</ComboboxEmpty>}
            >
              <ComboboxGroup>
                <ComboboxLabel>Stable</ComboboxLabel>
                <ComboboxItem id="production">Production</ComboboxItem>
                <ComboboxItem id="staging">Staging</ComboboxItem>
              </ComboboxGroup>
              <ComboboxGroup>
                <ComboboxLabel>Ephemeral</ComboboxLabel>
                <ComboboxItem id="preview">Preview</ComboboxItem>
                <ComboboxItem id="local">Local</ComboboxItem>
              </ComboboxGroup>
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </Demo>

      <Demo name="Calendar" wide>
        <Row>
          <Calendar aria-label="Release date" />
          <RangeCalendar aria-label="Deploy freeze window" />
        </Row>
      </Demo>

      <Demo name="Date & time fields" wide>
        <div className="grid w-full gap-6 sm:grid-cols-2">
          <DatePicker label="Launch date" description="Type a date or choose it in the calendar." />
          <DateRangePicker label="Reporting window" />
          <DateField label="Anniversary" />
          <TimeField label="Start time" />
        </div>
      </Demo>
    </GallerySection>
  )
}
