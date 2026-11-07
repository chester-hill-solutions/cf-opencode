/** Message-shape helpers shared by the reply pump and its tests. */

export interface MessageInfo {
  /** Stable message id; used to find the start of the current turn. */
  id?: string
  type?: string
  content?: Array<{ type?: string; text?: string }>
  time?: { created?: number; completed?: number }
  finish?: string
  /** Provider/runtime failure attached to a terminal `idle` message. */
  error?: { type?: string; message?: string } | string
}

/**
 * Assistant finishes that mean the turn is over. `tool-calls` is deliberately
 * absent: an assistant step that hands off to tools is followed by another
 * assistant step, so settling on it would cut a multi-step turn short.
 */
const TERMINAL_FINISH = new Set(["stop", "length", "content-filter", "error", "unknown"])

/**
 * The messages that belong to the current turn. When the caller knows the last
 * assistant message from before the prompt, everything after it is this turn.
 * Otherwise fall back to everything after the latest user message.
 */
export function turnMessages(messages: MessageInfo[], afterID?: string): MessageInfo[] {
  if (afterID) {
    const index = messages.findIndex((message) => message.id === afterID)
    if (index >= 0) return messages.slice(index + 1)
  }
  let lastUser = -1
  for (let i = 0; i < messages.length; i++) if (messages[i]?.type === "user") lastUser = i
  return messages.slice(lastUser + 1)
}

/** All assistant text emitted during the current turn. */
export function latestAssistantReply(messages: MessageInfo[], afterID?: string): string {
  return turnMessages(messages, afterID)
    .filter((message) => message.type === "assistant")
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n\n")
    .trim()
}

/** A run is settled once the current turn's latest assistant step completed. */
export function isSettled(messages: MessageInfo[], afterID?: string): boolean {
  const assistant = turnMessages(messages, afterID)
    .filter((message) => message.type === "assistant")
    .at(-1)
  if (!assistant) return false
  const completed = Boolean(assistant.time?.completed)
  if (!completed && !assistant.finish) return false
  return assistant.finish ? TERMINAL_FINISH.has(assistant.finish) : completed
}

export interface TurnFailure {
  message: string
  /** Creation time of the failing message, for at-most-once delivery. */
  at?: number
}

/**
 * A turn can also end without an assistant message: a provider that cannot
 * route the model (or a runtime fault) ends the session with a terminal `idle`
 * message carrying an `error`. Settlement has to accept that too, otherwise the
 * conversation stays `running` forever.
 *
 * `runStartedAt` scopes the check to the current run: an `idle` message can sit
 * after the baseline assistant of the previous turn, so a timestamp guard keeps
 * a stale failure from settling the next turn.
 */
export function turnFailure(
  messages: MessageInfo[],
  afterID?: string,
  runStartedAt?: number,
): TurnFailure | undefined {
  const turn = turnMessages(messages, afterID)

  // A step that failed still produces a terminal assistant message with an
  // empty body, so settlement succeeds with nothing to deliver. Surface the
  // attached error instead of going quiet.
  const assistant = turn
    .filter((message) => message.type === "assistant" && message.error)
    .at(-1)
  if (assistant?.error) {
    const at = assistant.time?.created
    if (!runStartedAt || typeof at !== "number" || at >= runStartedAt) {
      return { message: errorText(assistant.error), at }
    }
  }

  const idle = turn.filter((message) => message.type === "idle" && message.error).at(-1)
  if (!idle?.error) return undefined
  const at = idle.time?.created
  if (runStartedAt && typeof at === "number" && at < runStartedAt) return undefined
  return { message: errorText(idle.error), at }
}

function errorText(error: NonNullable<MessageInfo["error"]>): string {
  const message =
    typeof error === "string" ? error : (error.message ?? error.type ?? "run failed")
  return message || "run failed"
}

/** Stable identity for a failure, so a redelivered poll does not repeat it. */
export function failureKey(failure: TurnFailure): string {
  return `${failure.at ?? "unknown"}:${failure.message}`
}
