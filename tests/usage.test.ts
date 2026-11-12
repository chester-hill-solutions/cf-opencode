import { describe, expect, test } from "bun:test"
import { durableUsageEvent } from "../src/usage"

const event = (overrides: Record<string, unknown> = {}) => ({
  id: "evt-1",
  type: "session.step.ended",
  created: Date.UTC(2026, 10, 11),
  durable: { seq: 4 },
  data: {
    sessionID: "ses_1",
    assistantMessageID: "msg_1",
    cost: 0,
    tokens: { input: 0, output: 0 },
  },
  ...overrides,
})

describe("durable usage events", () => {
  test("converts real durable usage, preserving explicit zero totals", () => {
    expect(durableUsageEvent(event(), "ses_1")).toEqual({
      sourceID: "evt-1",
      sessionID: "ses_1",
      date: "2026-11-11",
      costUSD: 0,
      input: 0,
      output: 0,
      seq: 4,
      assistantMessageID: "msg_1",
    })
  })

  test("ignores cumulative usage snapshots", () => {
    expect(durableUsageEvent({ type: "session.usage.updated" }, "ses_1")).toBeUndefined()
  })

  test("returns undefined for nonusage durable rows", () => {
    expect(durableUsageEvent({
      type: "session.execution.succeeded",
      durable: { seq: 2 },
      data: { sessionID: "ses_1" },
    }, "ses_1")).toBeUndefined()
  })

  test("rejects malformed identity, sequence, or totals", () => {
    expect(() => durableUsageEvent(event({ id: "" }), "ses_1")).toThrow()
    expect(() => durableUsageEvent(event({ durable: { seq: 0 } }), "ses_1")).toThrow()
    expect(() => durableUsageEvent(event({ data: { ...event().data, cost: Number.NaN } }), "ses_1")).toThrow()
    expect(() => durableUsageEvent(event(), "ses_other")).toThrow()
  })
})
