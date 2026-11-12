import { describe, expect, test } from "bun:test"
import {
  canonicalOperatorReconciliationProposal,
  operatorReconciliationDigest,
  operatorQuiescenceDigest,
  parseOperatorReconciliationProposal,
} from "../src/operator-reconciliation"

const common = {
  receiptID: "receipt-1",
  conversationID: "conversation-1",
  sessionID: "session-1",
  reservationID: "reservation-1",
  originDate: "2026-11-11",
  usageDate: "2026-11-11",
  expectedLedgerSnapshotID: "a".repeat(64),
  expectedLocalSnapshotID: "b".repeat(64),
  quiescence: {
    sessionID: "session-1",
    runtimeGeneration: "runtime-generation-test",
    contextDigest: "d".repeat(64),
    waited: true as const,
    inboxEmpty: true as const,
    permissionsEmpty: true as const,
    formsEmpty: true as const,
  },
  quiescenceDigest: "e".repeat(64),
  evidenceReference: "private://evidence/1",
  evidenceSHA256: "c".repeat(64),
  operator: "operator@example.test",
  approvalReference: "approval-1",
}

describe("operator reconciliation contract", () => {
  test("requires null totals and explicit risk acceptance for unknown actuals", () => {
    const valid = parseOperatorReconciliationProposal({
      ...common,
      kind: "acknowledged_unknown",
      actualCostUSD: null,
      input: null,
      output: null,
      usageDate: null,
      acceptUnknownRisk: true,
    })
    expect(valid.ok).toBe(true)

    expect(parseOperatorReconciliationProposal({
      ...common,
      kind: "acknowledged_unknown",
      actualCostUSD: 0,
      input: null,
      output: null,
      usageDate: null,
      acceptUnknownRisk: true,
    }).ok).toBe(false)
    expect(parseOperatorReconciliationProposal({
      ...common,
      kind: "acknowledged_unknown",
      actualCostUSD: null,
      input: null,
      output: null,
      usageDate: null,
    }).ok).toBe(false)
  })

  test("requires assistant identity for observed actuals and rejects fields outside the closed DTO", () => {
    expect(parseOperatorReconciliationProposal({
      ...common,
      kind: "observed_actual",
      actualCostUSD: 0,
      input: 0,
      output: 0,
    }).ok).toBe(false)
    expect(parseOperatorReconciliationProposal({
      ...common,
      kind: "observed_actual",
      actualCostUSD: 0,
      input: 0,
      output: 0,
      assistantMessageID: "message-1",
      internalFlag: true,
    }).ok).toBe(false)
    expect(parseOperatorReconciliationProposal({
      ...common,
      kind: "observed_actual",
      actualCostUSD: 0,
      input: 0,
      output: 0,
      assistantMessageID: "message-1",
      quiescence: { ...common.quiescence, runtimeGeneration: "" },
    }).ok).toBe(false)
  })

  test("canonical digest is stable across input key ordering and binds decision fields", async () => {
    const evidence = { ...common, quiescenceDigest: await operatorQuiescenceDigest(common.quiescence) }
    const proposal = parseOperatorReconciliationProposal({
      ...evidence,
      kind: "observed_actual",
      actualCostUSD: 0.123456,
      input: 10,
      output: 3,
      assistantMessageID: "message-1",
    })
    expect(proposal.ok).toBe(true)
    if (!proposal.ok) return
    const reordered = parseOperatorReconciliationProposal(Object.fromEntries(
      Object.entries({
        ...evidence,
        kind: "observed_actual",
        actualCostUSD: 0.123456,
        input: 10,
        output: 3,
        assistantMessageID: "message-1",
      }).reverse(),
    ))
    expect(reordered.ok).toBe(true)
    if (!reordered.ok) return
    expect(canonicalOperatorReconciliationProposal(proposal.value))
      .toBe(canonicalOperatorReconciliationProposal(reordered.value))
    expect(await operatorReconciliationDigest(proposal.value))
      .toBe(await operatorReconciliationDigest(reordered.value))
    const changed = parseOperatorReconciliationProposal({
      ...evidence,
      kind: "observed_actual",
      actualCostUSD: 0.123457,
      input: 10,
      output: 3,
      assistantMessageID: "message-1",
    })
    expect(changed.ok).toBe(true)
    if (changed.ok) expect(await operatorReconciliationDigest(changed.value))
      .not.toBe(await operatorReconciliationDigest(proposal.value))
  })
})
