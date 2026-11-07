/**
 * Container lease arithmetic, kept pure so the cap can be tested without a
 * Durable Object. The Settings DO owns the storage; this decides the outcome.
 */

export interface Lease {
  id: string
  expiresAt: number
}

export type LeaseDecision =
  | { grant: true; expiresAt: number; active: number; refreshed: boolean }
  | { grant: false; active: number; retryAt: number }

export interface LeaseRequest {
  /** All stored leases, including expired ones. */
  leases: Lease[]
  id: string
  now: number
  ttlMs: number
  cap: number
}

/**
 * Refresh a lease the caller already holds, grant one when a slot is free, or
 * refuse with the earliest expiry so the caller knows when to retry.
 */
export function decideLease(request: LeaseRequest): LeaseDecision {
  const { id, now, ttlMs } = request
  const cap = Math.max(1, request.cap)
  const active = request.leases.filter((lease) => lease.expiresAt > now)

  const held = active.find((lease) => lease.id === id)
  if (held) return { grant: true, expiresAt: now + ttlMs, active: active.length, refreshed: true }

  if (active.length >= cap) {
    const retryAt = Math.min(...active.map((lease) => lease.expiresAt))
    return { grant: false, active: active.length, retryAt }
  }

  return { grant: true, expiresAt: now + ttlMs, active: active.length + 1, refreshed: false }
}
