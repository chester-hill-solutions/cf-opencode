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
  /**
   * Human-needed signals go to the escalation channel only; everything else is
   * a notice for the routine channel.
   */
  severity: "escalation" | "notice"
}

const COUNTERS: Array<[string, string, Alert["severity"]]> = [
  ["capacity.rejected", "Container capacity rejections", "notice"],
  ["turn.failed", "Failed turns", "notice"],
  ["turn.timedout", "Timed-out turns", "escalation"],
  ["settlement.paused", "Paused settlements (inspect conversation settlementError; holds remain reserved)", "escalation"],
  ["settlement.expired", "Turns closed with unmeasured spend (retry or abandon the retained reservation)", "escalation"],
  ["pump.latch_expired", "Observations that stopped answering (inspect the conversation for a wedged runtime)", "escalation"],
  ["turn.session_missing", "Turns closed because the runtime lost their session", "notice"],
  ["turn.session_missing.runtime_retained", "Lost-session turns whose container could not be stopped", "escalation"],
  ["container.recycled", "Container recycles", "notice"],
  ["slack.form.failed", "Failed Slack question deliveries (check bot scopes and channel access)", "escalation"],
  ["checkpoint.failed", "Failed checkpoints", "escalation"],
  ["snapshot.failed", "Failed snapshots", "escalation"],
]

export function evaluateAlerts(input: AlertInput): Alert[] {
  const alerts: Alert[] = []
  for (const [name, label, severity] of COUNTERS) {
    const value = input.metrics[name] ?? 0
    if (value > (input.marks[name] ?? 0)) {
      alerts.push({ name, message: `${label}: ${value} today`, value, severity })
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
        severity: "escalation",
      })
    }
  }

  return alerts
}
