/**
 * Usage arithmetic.
 *
 * OpenCode reports two shapes:
 *   - `session.usage.updated`: the session's cumulative step totals (replace).
 *   - `session.usage.recorded`: one auxiliary call (title/compaction) with its
 *     own event id, which must be added exactly once.
 *
 * The per-conversation/day ledger is the sum of the latest step totals and the
 * deduplicated auxiliary spend. Keeping them separate stops the settle-time
 * context sum from dropping title/compaction costs.
 */

export interface UsageTotals {
  date: string
  costUSD: number
  input: number
  output: number
}

export interface UsageAux extends UsageTotals {
  /** Auxiliary event ids already counted, oldest first. */
  seen: string[]
}

/** Cap the dedupe list; a day with more auxiliary calls than this is unusual. */
export const AUX_SEEN_LIMIT = 200

export function emptyUsage(date: string): UsageTotals {
  return { date, costUSD: 0, input: 0, output: 0 }
}

export function emptyAux(date: string): UsageAux {
  return { ...emptyUsage(date), seen: [] }
}

export function sumUsage(step: UsageTotals, aux: UsageTotals): UsageTotals {
  return {
    date: step.date,
    costUSD: step.costUSD + aux.costUSD,
    input: step.input + aux.input,
    output: step.output + aux.output,
  }
}

/**
 * Add one auxiliary event to the day's accumulator. Returns undefined when the
 * event id was already counted, so a replayed stream cannot double count.
 */
export function auxAfterEvent(
  aux: UsageAux,
  eventID: string | undefined,
  costUSD: number,
  input: number,
  output: number,
): UsageAux | undefined {
  if (eventID && aux.seen.includes(eventID)) return undefined
  return {
    date: aux.date,
    costUSD: aux.costUSD + costUSD,
    input: aux.input + input,
    output: aux.output + output,
    seen: eventID ? [...aux.seen, eventID].slice(-AUX_SEEN_LIMIT) : aux.seen,
  }
}
