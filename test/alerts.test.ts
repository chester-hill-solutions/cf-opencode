import { describe, expect, it } from "vitest"
import { evaluateAlerts, type AlertInput } from "../src/alerts"

/**
 * The harness now closes what it cannot settle and expires what it cannot pump.
 * Both are safe behaviour and both are human-needed events: without these rules
 * an operator learns about unmeasured spend by reading telemetry, not from Slack.
 */

const quiet: AlertInput = { metrics: {}, spendUSD: 0, budgetUSD: 0, leases: { cap: 3, active: 0 }, marks: {} }

function names(input: Partial<AlertInput>): string[] {
  return evaluateAlerts({ ...quiet, ...input }).map((alert) => alert.name)
}

describe("alert rules", () => {
  it("escalates a turn closed with unmeasured spend", () => {
    expect(names({ metrics: { "settlement.expired": 1 } })).toContain("settlement.expired")
    const alert = evaluateAlerts({ ...quiet, metrics: { "settlement.expired": 2 } })
      .find((candidate) => candidate.name === "settlement.expired")
    expect(alert?.severity).toBe("escalation")
    expect(alert?.message).toMatch(/retained reservation/)
  })

  it("escalates an expired pump latch and a container that would not stop", () => {
    expect(names({ metrics: { "pump.latch_expired": 1, "turn.session_missing.runtime_retained": 1 } }))
      .toEqual(expect.arrayContaining(["pump.latch_expired", "turn.session_missing.runtime_retained"]))
  })

  it("notices self-healing without waking anyone", () => {
    const alerts = evaluateAlerts({
      ...quiet,
      metrics: { "turn.session_missing": 3, "container.recycled": 4 },
    })
    expect(alerts.map((alert) => alert.name)).toEqual(expect.arrayContaining(["turn.session_missing", "container.recycled"]))
    expect(alerts.every((alert) => alert.name === "turn.session_missing" || alert.name === "container.recycled"
      ? alert.severity === "notice" : true)).toBe(true)
  })

  it("alerts once per new high-water mark, not once per observation", () => {
    expect(names({ metrics: { "settlement.expired": 2 }, marks: { "settlement.expired": 2 } })).not.toContain("settlement.expired")
    expect(names({ metrics: { "settlement.expired": 3 }, marks: { "settlement.expired": 2 } })).toContain("settlement.expired")
  })
})
