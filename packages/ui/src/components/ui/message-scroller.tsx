/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Scrollable content needs keyboard focus. */
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from "react"
import { cn } from "../../lib/utils"
import { Button } from "./button"
import { useUiI18n } from "./i18n"

export type MessageScrollerHandle = {
  scrollToLatest: () => void
  scrollToMessage: (id: string) => boolean
}
export type MessageScrollerProps<T> = Omit<
  ComponentProps<"section">,
  "children" | "ref"
> & {
  items: readonly T[]
  getKey: (item: T) => string
  renderMessage: (item: T) => ReactNode
  label?: string
  hasOlder?: boolean
  onLoadOlder?: () => void | Promise<void>
  initialMessageId?: string
  announceNewMessages?: boolean
  viewportClassName?: string
  ref?: Ref<MessageScrollerHandle>
}

type LayoutSnapshot = { first: string | undefined; firstTop: number }

/** Follow streamed content only while at the end; preserve position on prepends. */
export function MessageScroller<T>({
  items,
  getKey,
  renderMessage,
  label,
  hasOlder = false,
  onLoadOlder,
  initialMessageId,
  announceNewMessages = false,
  viewportClassName,
  className,
  ref,
  ...props
}: MessageScrollerProps<T>) {
  const { t } = useUiI18n()
  const viewport = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const snapshot = useRef<LayoutSnapshot | null>(null)
  const initialized = useRef(false)
  const [following, setFollowing] = useState(true)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  function scrollToLatest() {
    const element = viewport.current
    if (!element) return
    element.scrollTop = element.scrollHeight
    follow.current = true
    setFollowing(true)
  }
  function scrollToMessage(id: string) {
    const element = viewport.current
    const message = Array.from(content.current?.children ?? []).find(
      (child) => child.getAttribute("data-message-id") === id
    )
    if (!element || !(message instanceof HTMLElement)) return false
    element.scrollTop +=
      message.getBoundingClientRect().top - element.getBoundingClientRect().top
    follow.current = false
    setFollowing(false)
    return true
  }
  function firstTop() {
    return content.current?.firstElementChild?.getBoundingClientRect().top ?? 0
  }
  useImperativeHandle(ref, () => ({ scrollToLatest, scrollToMessage }))

  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    const keys = items.map(getKey)
    const previous = snapshot.current
    const prepended =
      previous?.first !== undefined && keys.indexOf(previous.first) > 0
    if (!initialized.current && items.length > 0) {
      initialized.current = true
      if (!initialMessageId || !scrollToMessage(initialMessageId))
        scrollToLatest()
    } else if (prepended) {
      const anchor = Array.from(content.current?.children ?? []).find(
        (child) => child.getAttribute("data-message-id") === previous.first
      )
      if (anchor)
        element.scrollTop +=
          anchor.getBoundingClientRect().top - previous.firstTop
    } else if (follow.current) {
      element.scrollTop = element.scrollHeight
    }
    snapshot.current = { first: keys[0], firstTop: firstTop() }
  }, [items, getKey, initialMessageId])

  useEffect(() => {
    const body = content.current
    if (!body || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => {
      const element = viewport.current
      if (!element) return
      if (follow.current) element.scrollTop = element.scrollHeight
      if (snapshot.current) snapshot.current.firstTop = firstTop()
    })
    observer.observe(body)
    return () => observer.disconnect()
  }, [])

  async function loadOlder() {
    if (!onLoadOlder || loading) return
    setLoading(true)
    setFailed(false)
    try {
      await onLoadOlder()
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <section
      data-slot="message-scroller"
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col rounded-lg border border-border bg-background",
        className
      )}
      {...props}
    >
      {hasOlder && onLoadOlder && (
        <div className="border-b border-border p-2 text-center">
          <Button
            variant="outline"
            size="sm"
            pending={loading}
            onPress={() => void loadOlder()}
          >
            {t("loadOlderMessages")}
          </Button>
          {failed && (
            <p role="alert" className="text-xs text-destructive">
              {t("loadMessagesFailed")}
            </p>
          )}
        </div>
      )}
      {/* Scrollable transcripts need a keyboard focus target. */}
      <div
        ref={viewport}
        data-slot="message-scroller-viewport"
        role="log"
        aria-label={label ?? t("conversation")}
        aria-live={announceNewMessages ? "polite" : "off"}
        aria-relevant="additions text"
        tabIndex={0}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 [overflow-anchor:none]",
          viewportClassName
        )}
        onScroll={() => {
          const element = viewport.current
          if (!element) return
          const next =
            element.scrollHeight - element.clientHeight - element.scrollTop <=
            32
          follow.current = next
          setFollowing(next)
          if (snapshot.current) snapshot.current.firstTop = firstTop()
        }}
      >
        <div ref={content} className="grid gap-4">
          {items.map((item) => (
            <div key={getKey(item)} data-message-id={getKey(item)}>
              {renderMessage(item)}
            </div>
          ))}
        </div>
      </div>
      {!following && (
        <div className="absolute end-3 bottom-3">
          <Button size="sm" variant="secondary" onPress={scrollToLatest}>
            {t("jumpToLatest")}
          </Button>
        </div>
      )}
    </section>
  )
}
