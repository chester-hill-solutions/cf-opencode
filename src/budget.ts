/** Budget rules kept pure so their boundary semantics remain easy to test. */

/**
 * A daily cap of 0 (or less) disables enforcement. Spend equal to the cap
 * blocks the next turn, because the cap is a ceiling, not a target.
 */
export function budgetExceeded(spentUSD: number, budgetUSD: number): boolean {
  if (!Number.isFinite(budgetUSD) || budgetUSD <= 0) return false
  if (!Number.isFinite(spentUSD)) return false
  return spentUSD >= budgetUSD
}

/**
 * When a blocked turn may try again: just after the next UTC midnight, when the
 * daily ledger is keyed to a new date. A minute of slack avoids retrying inside
 * the last second of the old day.
 */
export function nextBudgetReset(now: number): number {
  const date = new Date(now)
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
  return Math.max(midnight + 60_000, now + 60_000)
}
