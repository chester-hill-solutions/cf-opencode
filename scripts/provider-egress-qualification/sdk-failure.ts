import { turnMessages, type MessageInfo } from "../../src/messages"

const KNOWN_FAILURES: ReadonlySet<string> = new Set([
  "compaction.unavailable",
  "compaction.failed",
  "provider.auth",
  "provider.no-route",
  "provider.unsupported-operation",
  "provider.unknown",
  "provider.content-filter",
  "unknown",
] as const)

/** Return only a fixed SDK error code; never expose provider text or arbitrary types. */
export function sdkTerminalFailure(messages: MessageInfo[]): string {
  let classified: string | undefined
  for (const message of turnMessages(messages)) {
    if (message.error === undefined) continue
    if (typeof message.error === "string" || !message.error || typeof message.error !== "object") {
      return "terminal_error"
    }
    const type = message.error.type
    if (typeof type !== "string" || !KNOWN_FAILURES.has(type)) {
      return "terminal_error"
    }
    classified = type
  }
  return classified ?? "terminal_error"
}
