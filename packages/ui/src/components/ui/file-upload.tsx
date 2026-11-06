import { useId, useRef, useState, type ReactNode } from "react"
import { FileIcon, UploadIcon, XIcon } from "lucide-react"

import { cn } from "../../lib/utils"
import { Button, buttonVariants } from "./button"
import { useUiI18n } from "./i18n"

type FileUploadRejectionReason = "type" | "size" | "count"
type FileUploadRejection = { file: File; reason: FileUploadRejectionReason }
type FileUploadProps = {
  id?: string
  label: string
  value: readonly File[]
  onChange: (files: File[]) => void
  onReject?: (rejections: FileUploadRejection[]) => void
  description?: ReactNode
  error?: ReactNode
  accept?: string
  maxFileSize?: number
  maxFiles?: number
  multiple?: boolean
  isDisabled?: boolean
  className?: string
}

function acceptsFile(file: File, accept: string | undefined) {
  const tokens = accept
    ?.split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
  if (!tokens?.length) return true
  const name = file.name.toLowerCase()
  const type = file.type.toLowerCase()
  return tokens.some((token) => {
    if (token === "*/*") return true
    if (token.startsWith(".")) return name.endsWith(token)
    if (token.endsWith("/*")) return type.startsWith(token.slice(0, -1))
    return type === token
  })
}

/** Local file selection only. The host owns uploading and server validation. */
function FileUpload({
  id: providedId,
  label,
  value,
  onChange,
  onReject,
  description,
  error,
  accept,
  maxFileSize,
  maxFiles,
  multiple = false,
  isDisabled = false,
  className,
}: FileUploadProps) {
  const generatedId = useId()
  const id = providedId ?? generatedId
  const inputRef = useRef<HTMLInputElement>(null)
  const [rejections, setRejections] = useState<FileUploadRejection[]>([])
  const [dragging, setDragging] = useState(false)
  const { t } = useUiI18n()
  const capacity = Math.min(multiple ? Infinity : 1, maxFiles ?? Infinity)
  const hasError = !!error || rejections.length > 0
  const describedBy = [
    `${id}-instructions`,
    description && `${id}-description`,
    hasError && `${id}-error`,
  ]
    .filter(Boolean)
    .join(" ")

  function selectFiles(files: File[]) {
    if (isDisabled || !files.length) return
    const accepted: File[] = []
    const rejected: FileUploadRejection[] = []
    for (const file of files) {
      const reason = !acceptsFile(file, accept)
        ? "type"
        : maxFileSize !== undefined && file.size > maxFileSize
          ? "size"
          : value.length + accepted.length >= capacity
            ? "count"
            : undefined
      if (reason) rejected.push({ file, reason })
      else accepted.push(file)
    }
    setRejections(rejected)
    if (accepted.length) onChange([...value, ...accepted])
    if (rejected.length) onReject?.(rejected)
  }

  return (
    <div
      data-slot="file-upload"
      data-disabled={isDisabled || undefined}
      className={cn("grid min-w-0 gap-2", className)}
    >
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {description && (
        <div id={`${id}-description`} className="text-sm text-muted-foreground">
          {description}
        </div>
      )}
      <div
        data-slot="file-upload-dropzone"
        data-dragging={dragging || undefined}
        className={cn(
          "relative grid min-w-0 justify-items-center gap-3 rounded-lg border border-dashed border-border bg-muted/30 p-5 text-center focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40",
          dragging && !isDisabled && "border-primary bg-primary/5",
          isDisabled && "opacity-50"
        )}
        onDragOver={(event) => {
          event.preventDefault()
          event.dataTransfer.dropEffect = isDisabled ? "none" : "copy"
          if (!isDisabled) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          selectFiles(Array.from(event.dataTransfer.files))
        }}
      >
        <UploadIcon aria-hidden className="size-5 text-muted-foreground" />
        <span
          aria-hidden
          className={cn(
            buttonVariants({ variant: "outline" }),
            "h-auto min-h-8 max-w-full py-1.5 break-words whitespace-normal"
          )}
        >
          {t("chooseFiles")}
        </span>
        <span
          id={`${id}-instructions`}
          className="text-sm text-muted-foreground"
        >
          {t("dropFiles")}
        </span>
        <input
          ref={inputRef}
          id={id}
          type="file"
          accept={accept}
          multiple={multiple}
          disabled={isDisabled}
          aria-invalid={hasError || undefined}
          aria-describedby={describedBy}
          className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? [])
            // Clearing the native picker permits choosing the same file again.
            event.currentTarget.value = ""
            selectFiles(files)
          }}
        />
      </div>
      {value.length > 0 && (
        <ul className="grid min-w-0 gap-2" aria-label={label}>
          {value.map((file, index) => (
            <li
              key={`${file.name}-${file.lastModified}-${index}`}
              className="flex min-w-0 items-center gap-2 rounded-md border bg-card p-2 text-card-foreground"
            >
              <FileIcon
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 flex-1 text-sm break-all">
                {file.name}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                className="pointer-coarse:size-11"
                isDisabled={isDisabled}
                aria-label={t("removeFile", { file: file.name })}
                onPress={() => {
                  if (isDisabled) return
                  setRejections([])
                  onChange(value.filter((_, fileIndex) => fileIndex !== index))
                  inputRef.current?.focus()
                }}
              >
                <XIcon aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {hasError && (
        <div
          id={`${id}-error`}
          role="alert"
          className="grid gap-1 text-sm text-destructive"
        >
          {error}
          {rejections.length > 0 && (
            <ul className="list-inside list-disc">
              {rejections.map(({ file, reason }, index) => (
                <li
                  key={`${file.name}-${reason}-${index}`}
                  className="break-words"
                >
                  {t(
                    reason === "type"
                      ? "fileTypeRejected"
                      : reason === "size"
                        ? "fileSizeRejected"
                        : "fileCountRejected",
                    { file: file.name }
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

export { FileUpload }
export type { FileUploadProps, FileUploadRejection, FileUploadRejectionReason }
