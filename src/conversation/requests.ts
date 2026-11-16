import type { SlackEventEnvelope } from "../adapters/slack"
import type { SlackTarget, Transport } from "../state"

export interface MessageRequest {
  text: string
  delivery?: "queue" | "steer" | "interrupt"
  replaceQueue?: boolean
  user?: string
  transport?: Transport
  slack?: SlackTarget
  /** Optional client key; a retry with the same key is not a second turn. */
  idempotencyKey?: string
}

export interface SlackEventRequest {
  eventID?: string
  replyTs?: string
  appUrl?: string
  event: NonNullable<SlackEventEnvelope["event"]>
}
