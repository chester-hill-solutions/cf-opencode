/**
 * Queue helpers, kept pure so capacity handling is testable without a
 * Durable Object.
 */

/** Error raised when the container lease cap has no free slot. */
export const CAPACITY_ERROR = "container capacity reached"

/** Retry cadence while the cap is full. Leases outlive a turn, so keep waiting. */
export const CAPACITY_RETRY_MS = 30_000

/** Maximum configurable FIFO depth; invalid values fall back to the default. */
export const DEFAULT_QUEUE_CAPACITY = 10
export const MAX_QUEUE_CAPACITY = 100

export function queueCapacity(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_QUEUE_CAPACITY
  const value = typeof raw === "number" ? raw : Number(raw)
  return Number.isInteger(value) && value >= 1 && value <= MAX_QUEUE_CAPACITY
    ? value
    : DEFAULT_QUEUE_CAPACITY
}

/**
 * Is this failure "no container slot right now" rather than a broken prompt?
 * Capacity pressure must not consume the bounded prompt-retry budget, or a
 * message can be dropped while a slot is still about to free up.
 */
export function isCapacityRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "")
  return message.includes(CAPACITY_ERROR)
}
