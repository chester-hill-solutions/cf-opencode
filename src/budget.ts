/** Budget rules, kept pure so the admission gate is testable without a DO. */

/**
 * A daily cap of 0 (or less) disables enforcement. Spend equal to the cap
 * blocks the next turn, because the cap is a ceiling, not a target.
 */
export function budgetExceeded(spentUSD: number, budgetUSD: number): boolean {
  if (!Number.isFinite(budgetUSD) || budgetUSD <= 0) return false
  if (!Number.isFinite(spentUSD)) return false
  return spentUSD >= budgetUSD
}
