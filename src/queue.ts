/**
 * Queue helpers, kept pure so capacity handling is testable without a
 * Durable Object.
 */

/** Error raised when the container lease cap has no free slot. */
export const CAPACITY_ERROR = "container capacity reached"

/** Retry cadence while the cap is full. Leases outlive a turn, so keep waiting. */
export const CAPACITY_RETRY_MS = 30_000

/**
 * Is this failure "no container slot right now" rather than a broken prompt?
 * Capacity pressure must not consume the bounded prompt-retry budget, or a
 * message can be dropped while a slot is still about to free up.
 */
export function isCapacityRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "")
  return message.includes(CAPACITY_ERROR)
}
