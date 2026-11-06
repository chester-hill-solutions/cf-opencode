/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Scrollable content needs keyboard focus. */
import { useState, type ComponentProps } from "react"
import {
  CheckIcon,
  CodeIcon,
  CopyIcon,
  FileDiffIcon,
  TerminalIcon,
} from "lucide-react"
import { cn } from "../../lib/utils"
import { Button } from "./button"
import { useUiI18n } from "./i18n"

export type CodeBlockProps = Omit<
  ComponentProps<"figure">,
  "children" | "onCopy"
> & {
  code: string
  language?: string
  title?: string
  variant?: "code" | "terminal" | "diff"
  showLineNumbers?: boolean
  onCopy?: (code: string) => void | Promise<void>
}

export function CodeBlock({
  code,
  language,
  title,
  variant = "code",
  showLineNumbers = false,
  onCopy,
  className,
  ...props
}: CodeBlockProps) {
  const { t } = useUiI18n()
  const [copiedCode, setCopiedCode] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [pending, setPending] = useState(false)
  const copied = copiedCode === code
  const lines = code.split("\n")
  const caption =
    title ??
    language ??
    t(
      variant === "terminal"
        ? "terminalOutput"
        : variant === "diff"
          ? "codeDiff"
          : "code"
    )
  const Icon =
    variant === "terminal"
      ? TerminalIcon
      : variant === "diff"
        ? FileDiffIcon
        : CodeIcon
  async function copy() {
    setError(false)
    setPending(true)
    try {
      if (onCopy) await onCopy(code)
      else await navigator.clipboard.writeText(code)
      setCopiedCode(code)
    } catch {
      setError(true)
    } finally {
      setPending(false)
    }
  }
  return (
    <figure
      data-slot="code-block"
      data-variant={variant}
      className={cn(
        "min-w-0 overflow-hidden rounded-lg border border-border bg-card text-card-foreground",
        className
      )}
      {...props}
    >
      <figcaption
        data-slot="code-block-header"
        className="flex min-w-0 items-center justify-between gap-3 border-b border-border px-3 py-2 text-xs"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Icon aria-hidden className="size-4 shrink-0" />
          <span
            data-slot="code-block-title"
            className="min-w-0 font-medium break-words"
          >
            {caption}
          </span>
          {title && language && (
            <span
              data-slot="code-block-language"
              className="shrink-0 text-muted-foreground"
            >
              {language}
            </span>
          )}
        </span>
        <Button
          size="sm"
          variant="outline"
          pending={pending}
          onPress={() => void copy()}
          aria-label={copied ? t("copied") : t("copyCode")}
        >
          {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
          {copied ? t("copied") : t("copyCode")}
        </Button>
      </figcaption>
      {/* Focus allows keyboard users to scroll long lines. */}
      <pre
        data-slot="code-block-viewport"
        className="m-0 overflow-x-auto p-3 text-xs leading-6"
        tabIndex={0}
        aria-label={caption}
      >
        <code data-language={language} className="block min-w-max">
          {lines.map((line, index) => {
            const change =
              variant === "diff" &&
              line.startsWith("+") &&
              !line.startsWith("+++")
                ? "added"
                : variant === "diff" &&
                    line.startsWith("-") &&
                    !line.startsWith("---")
                  ? "removed"
                  : undefined
            return (
              <span
                key={index}
                data-slot="code-block-line"
                data-change={change}
                className={cn(
                  "block min-h-6",
                  change === "added" && "bg-success/10",
                  change === "removed" && "bg-destructive/10"
                )}
              >
                {showLineNumbers && (
                  <span
                    data-slot="code-block-line-number"
                    aria-hidden="true"
                    className="me-4 inline-block w-6 text-end text-muted-foreground select-none"
                  >
                    {index + 1}
                  </span>
                )}
                {line}
                {index < lines.length - 1 ? "\n" : ""}
              </span>
            )
          })}
        </code>
      </pre>
      <span role="status" className="sr-only">
        {copied ? t("copied") : ""}
      </span>
      {error && (
        <p role="alert" className="m-0 px-3 pb-3 text-xs text-destructive">
          {t("copyFailed")}
        </p>
      )}
    </figure>
  )
}
