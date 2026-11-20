import { describe, expect, test } from "bun:test"
import { evaluateAlerts } from "../src/alerts"

const base = {
  metrics: {} as Record<string, number>,
  spendUSD: 0,
  budgetUSD: 0,
  leases: { cap: 2, active: 0 },
  marks: {} as Record<string, number>,
}

describe("evaluateAlerts", () => {
  test("is quiet when nothing happened", () => {
    expect(evaluateAlerts(base)).toEqual([])
  })

  test("alerts once per new counter value", () => {
    const first = evaluateAlerts({ ...base, metrics: { "turn.failed": 1 } })
    expect(first.map((alert) => alert.name)).toEqual(["turn.failed"])

    const same = evaluateAlerts({
      ...base,
      metrics: { "turn.failed": 1 },
      marks: { "turn.failed": 1 },
    })
    expect(same).toEqual([])

    const grown = evaluateAlerts({
      ...base,
      metrics: { "turn.failed": 2 },
      marks: { "turn.failed": 1 },
    })
    expect(grown[0]?.message).toContain("2 today")
  })

  test("reports capacity rejections and checkpoint failures", () => {
    const alerts = evaluateAlerts({
      ...base,
      metrics: { "capacity.rejected": 2, "checkpoint.failed": 1 },
    })
    expect(alerts.map((alert) => alert.name).sort()).toEqual([
      "capacity.rejected",
      "checkpoint.failed",
    ])
  })

  test("warns at 80% of the daily budget and only on a new high", () => {
    const at = evaluateAlerts({ ...base, spendUSD: 4, budgetUSD: 5 })
    expect(at.map((alert) => alert.name)).toEqual(["budget"])

    const again = evaluateAlerts({
      ...base,
      spendUSD: 4,
      budgetUSD: 5,
      marks: { budget: 4 },
    })
    expect(again).toEqual([])
  })

  test("does not warn without a budget", () => {
    expect(evaluateAlerts({ ...base, spendUSD: 100 })).toEqual([])
  })

  test("alerts on the first paused settlement and failed question delivery", () => {
    const metrics = { "settlement.paused": 1, "slack.form.failed": 1 }
    expect(evaluateAlerts({ ...base, metrics }).map((alert) => alert.name)).toEqual([
      "settlement.paused", "slack.form.failed",
    ])
    expect(evaluateAlerts({ ...base, metrics, marks: metrics })).toEqual([])
  })

  test("routes human-needed signals to the escalation channel only", () => {
    const alerts = evaluateAlerts({
      ...base,
      metrics: {
        "turn.timedout": 1,
        "settlement.paused": 1,
        "checkpoint.failed": 1,
        "capacity.rejected": 1,
        "turn.failed": 1,
      },
    })
    const byName = Object.fromEntries(alerts.map((alert) => [alert.name, alert.severity]))
    expect(byName).toEqual({
      "turn.timedout": "escalation",
      "settlement.paused": "escalation",
      "checkpoint.failed": "escalation",
      "capacity.rejected": "notice",
      "turn.failed": "notice",
    })
  })

  test("treats budget pressure as an escalation", () => {
    const alerts = evaluateAlerts({ ...base, spendUSD: 9, budgetUSD: 10 })
    expect(alerts.find((alert) => alert.name === "budget")?.severity).toBe("escalation")
  })
})
