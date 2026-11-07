/**
 * Alert rules, kept pure so the scheduled check is testable without a DO.
 * Counters alert when they grow past the value already reported today.
 */

export interface AlertInput {
  metrics: Record<string, number>
  spendUSD: number
  budgetUSD: number
  leases: { cap: number; active: number }
  /** Highest counter (or spend) already alerted today, by alert name. */
  marks: Record<string, number>
}

export interface Alert {
  name: string
  message: string
  value: number
}

const COUNTERS: Array<[string, string]> = [
  ["capacity.rejected", "Container capacity rejections"],
  ["turn.failed", "Failed turns"],
  ["turn.timedout", "Timed-out turns"],
  ["checkpoint.failed", "Failed checkpoints"],
  ["snapshot.failed", "Failed snapshots"],
]

export function evaluateAlerts(input: AlertInput): Alert[] {
  const alerts: Alert[] = []
  for (const [name, label] of COUNTERS) {
    const value = input.metrics[name] ?? 0
    if (value > (input.marks[name] ?? 0)) {
      alerts.push({ name, message: `${label}: ${value} today`, value })
    }
  }

  // Warn once per new high-water mark at 80% of the daily budget.
  if (input.budgetUSD > 0) {
    const threshold = input.budgetUSD * 0.8
    if (input.spendUSD >= threshold && input.spendUSD > (input.marks.budget ?? 0)) {
      alerts.push({
        name: "budget",
        message: `Daily spend $${input.spendUSD.toFixed(4)} of $${input.budgetUSD}`,
        value: input.spendUSD,
      })
    }
  }

  return alerts
}
