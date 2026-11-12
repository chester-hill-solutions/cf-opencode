import { beforeEach, describe, expect, it, vi } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { operatorQuiescenceDigest, type OperatorReconciliationProposal } from "../src/operator-reconciliation"

const settings = () => env.SETTINGS.getByName("global")
const today = () => new Date().toISOString().slice(0, 10)

async function post(path: string, body: unknown): Promise<Response> {
  return settings().fetch(`https://settings${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function reset(): Promise<void> {
  await runInDurableObject(settings(), async (_instance, state) => state.storage.deleteAll())
}

async function stored(key: string): Promise<any> {
  return runInDurableObject(settings(), async (_instance, state) => state.storage.get(key))
}

async function reserve(conversationID: string, reservationID: string, date = today()): Promise<void> {
  if (date === today()) {
    const response = await post("/usage/reserve", { conversationID, reservationID, costUSD: 0.1 })
    expect(response.ok).toBe(true)
    return
  }
  await runInDurableObject(settings(), async (_instance, state) => {
    await state.storage.put(`reservation:${conversationID}`, {
      conversationID, reservationID, date, costUSD: 0.1, updatedAt: Date.now(),
    })
  })
}

async function preview(conversationID: string, sessionID: string, reservationID: string): Promise<Record<string, any>> {
  const query = new URLSearchParams({ conversationID, sessionID, reservationID })
  const response = await settings().fetch(`https://settings/usage/reconciliation?${query}`)
  expect(response.status).toBe(200)
  return await response.json() as Record<string, any>
}

async function proposalFor(
  snapshot: Record<string, any>,
  patch: Partial<OperatorReconciliationProposal> = {},
): Promise<OperatorReconciliationProposal> {
  const quiescence = {
    sessionID: snapshot.sessionID as string,
    runtimeGeneration: "runtime-generation-test",
    contextDigest: "c".repeat(64),
    waited: true as const,
    inboxEmpty: true as const,
    permissionsEmpty: true as const,
    formsEmpty: true as const,
  }
  return {
    receiptID: "operator-receipt-1",
    conversationID: snapshot.conversationID,
    sessionID: snapshot.sessionID,
    reservationID: snapshot.reservationID,
    originDate: snapshot.originDate,
    usageDate: snapshot.originDate,
    expectedLedgerSnapshotID: snapshot.snapshotID,
    expectedLocalSnapshotID: "a".repeat(64),
    quiescence,
    quiescenceDigest: await operatorQuiescenceDigest(quiescence),
    kind: "observed_actual",
    actualCostUSD: 0.0017703,
    input: 5885,
    output: 4,
    assistantMessageID: "msg-observed-1",
    evidenceReference: "private://evidence/case-1",
    evidenceSHA256: "b".repeat(64),
    operator: "operator@example.test",
    approvalReference: "approval-1",
    ...patch,
  }
}

describe("operator usage reconciliation", () => {
  beforeEach(reset)

  it("imports exact observed actuals once, preserves receipt on lost-ack retry, and retires only its hold", async () => {
    const conversationID = "operator-observed"
    const sessionID = "session-observed"
    const reservationID = "reservation-observed"
    await reserve(conversationID, reservationID)
    const firstSnapshot = await preview(conversationID, sessionID, reservationID)
    expect(firstSnapshot).toMatchObject({
      hold: { conversationID, reservationID, date: today() },
      originDate: today(),
      sessionSources: [],
      projectedDayBasis: { date: today(), reservedUSD: 0.1 },
      currentBudgetBasis: { date: today(), actualUSD: 0, reservedUSD: 0.1, admittedUSD: 0.1 },
      blockers: [],
    })

    const proposal = await proposalFor(firstSnapshot)
    const badProof = await post("/usage/reconciliation", { ...proposal, quiescenceDigest: "f".repeat(64) })
    expect(badProof.status).toBe(400)
    expect(await stored(`reservation:${conversationID}`)).toBeDefined()
    const first = await post("/usage/reconciliation", proposal)
    expect(first.status).toBe(200)
    const accepted = await first.json() as { receipt: Record<string, unknown>; replayed: boolean }
    expect(accepted.replayed).toBe(false)
    expect(accepted.receipt).toMatchObject({
      receiptID: proposal.receiptID,
      kind: "observed_actual",
      actualCostUSD: 0.0017703,
      input: 5885,
      output: 4,
      requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(await stored(`usage:${today()}:${conversationID}`)).toMatchObject({
      costUSD: 0.0017703, input: 5885, output: 4, sourced: true,
    })
    expect(await stored(`reservation:${conversationID}`)).toBeUndefined()
    expect(await stored(`reservation-retired:${JSON.stringify([conversationID, reservationID])}`)).toMatchObject({
      reason: "released", released: true, operatorReceiptID: proposal.receiptID,
    })
    expect((await post("/usage/reserve", { conversationID, reservationID, costUSD: 0.1 })).status).toBe(409)

    const retry = await post("/usage/reconciliation", proposal)
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ ok: true, replayed: true, receipt: accepted.receipt })
    expect(await stored(`usage:${today()}:${conversationID}`)).toMatchObject({ costUSD: 0.0017703, input: 5885, output: 4 })
    const changedRetry = await post("/usage/reconciliation", { ...proposal, approvalReference: "different-approval" })
    expect(changedRetry.status).toBe(409)
  })

  it("records acknowledged unknown as null without a usage row and keeps the warning after UTC day rollover", async () => {
    const conversationID = "operator-unknown"
    const sessionID = "session-unknown"
    const reservationID = "reservation-unknown"
    await reserve(conversationID, reservationID)
    const snapshot = await preview(conversationID, sessionID, reservationID)
    const proposal = await proposalFor(snapshot, {
      receiptID: "operator-unknown-1",
      kind: "acknowledged_unknown",
      actualCostUSD: null,
      input: null,
      output: null,
      usageDate: null,
      assistantMessageID: undefined,
      acceptUnknownRisk: true,
    })
    const response = await post("/usage/reconciliation", proposal)
    expect(response.status).toBe(200)
    expect((await response.json() as { receipt: Record<string, unknown> }).receipt).toMatchObject({
      kind: "acknowledged_unknown", actualCostUSD: null, input: null, output: null, acceptUnknownRisk: true,
    })
    expect(await stored(`usage:${today()}:${conversationID}`)).toBeUndefined()
    expect(await stored(`usage-source:${JSON.stringify([conversationID, sessionID, `operator-reconciliation:${proposal.receiptID}`])}`)).toBeUndefined()

    const before = new Date()
    vi.setSystemTime(new Date(before.getTime() + 86_400_000))
    try {
      const usage = await (await settings().fetch("https://settings/usage/today")).json() as Record<string, unknown>
      expect(usage).toMatchObject({ historicalUsageUnreconciled: true, unknownReconciliationCount: 1 })
    } finally {
      vi.setSystemTime(before)
    }

    const laterActual = await post("/usage", {
      conversationID, sessionID, sourceID: "late-native-after-unknown", date: today(),
      costUSD: 0.25, input: 25, output: 2,
    })
    expect(laterActual.status).toBe(200)
    expect(await stored(`usage:${today()}:${conversationID}`)).toMatchObject({ costUSD: 0.25, input: 25, output: 2 })
  })

  it("rejects stale snapshots, wrong ownership, and observed imports over ambiguous session usage", async () => {
    const conversationID = "operator-stale"
    const sessionID = "session-stale"
    const reservationID = "reservation-stale"
    await reserve(conversationID, reservationID)
    const snapshot = await preview(conversationID, sessionID, reservationID)
    await runInDurableObject(settings(), async (_instance, state) => {
      await state.storage.put(`usage:${today()}:${conversationID}`, { costUSD: 0.4, input: 4, output: 1 })
    })
    const stale = await post("/usage/reconciliation", await proposalFor(snapshot))
    expect(stale.status).toBe(409)
    expect(await stored(`reservation:${conversationID}`)).toBeDefined()
    expect(await stored(`usage-cutover:${conversationID}`)).toBeUndefined()

    const fresh = await preview(conversationID, sessionID, reservationID)
    const wrongOwner = await post("/usage/reconciliation", await proposalFor(fresh, { reservationID: "other-reservation" }))
    expect(wrongOwner.status).toBe(409)
    expect(await stored(`reservation:${conversationID}`)).toMatchObject({ reservationID })

    const sourceID = "preexisting-session-source"
    await runInDurableObject(settings(), async (_instance, state) => {
      await state.storage.put(`usage-source:${JSON.stringify([conversationID, sessionID, sourceID])}`, {
        date: today(), costUSD: 0.1, input: 10, output: 1,
      })
    })
    const sourceSnapshot = await preview(conversationID, sessionID, reservationID)
    const ambiguous = await post("/usage/reconciliation", await proposalFor(sourceSnapshot, { receiptID: "operator-stale-2" }))
    expect(ambiguous.status).toBe(409)
    expect(await stored(`reservation:${conversationID}`)).toBeDefined()
  })

  it("links one late native source by assistant identity and accounts only positive excess", async () => {
    const conversationID = "operator-late-native"
    const sessionID = "session-late-native"
    const reservationID = "reservation-late-native"
    await reserve(conversationID, reservationID)
    const snapshot = await preview(conversationID, sessionID, reservationID)
    const proposal = await proposalFor(snapshot, {
      actualCostUSD: 0.01, input: 100, output: 10,
      assistantMessageID: "msg-late-native",
    })
    expect((await post("/usage/reconciliation", proposal)).status).toBe(200)

    const nativeReport = {
      conversationID, sessionID, sourceID: "native-step-1", date: today(),
      assistantMessageID: "msg-late-native", costUSD: 0.012, input: 105, output: 10,
    }
    expect((await post("/usage", nativeReport)).status).toBe(200)
    expect(await stored(`usage:${today()}:${conversationID}`)).toMatchObject({
      costUSD: 0.012, input: 105, output: 10,
    })
    expect((await post("/usage", nativeReport)).status).toBe(200)
    expect(await stored(`usage:${today()}:${conversationID}`)).toMatchObject({
      costUSD: 0.012, input: 105, output: 10,
    })
    expect((await post("/usage", { ...nativeReport, sourceID: "conflicting-native-step" })).status).toBe(409)
    expect(await stored(`usage:${today()}:${conversationID}`)).toMatchObject({
      costUSD: 0.012, input: 105, output: 10,
    })
  })

  it("keeps missing-identity native reports additive and flags possible overlap", async () => {
    const conversationID = "operator-overlap"
    const sessionID = "session-overlap"
    const reservationID = "reservation-overlap"
    await reserve(conversationID, reservationID)
    const snapshot = await preview(conversationID, sessionID, reservationID)
    expect((await post("/usage/reconciliation", await proposalFor(snapshot, { receiptID: "operator-overlap-1" }))).status).toBe(200)
    expect((await post("/usage", {
      conversationID, sessionID, sourceID: "native-without-message-id", date: today(),
      costUSD: 0.02, input: 200, output: 20,
    })).status).toBe(200)
    expect(await stored(`usage:${today()}:${conversationID}`)).toMatchObject({
      costUSD: 0.0217703, input: 6085, output: 24,
    })
    expect(await stored(`operator-reconciliation:overlap:${JSON.stringify([conversationID, sessionID])}`)).toBe(true)
    expect(await (await settings().fetch("https://settings/usage/today")).json()).toMatchObject({
      historicalUsageUnreconciled: true,
    })
  })

  it("keeps the existing cutover epoch guard ahead of operator application", async () => {
    const conversationID = "operator-existing-cutover"
    const sessionID = "session-existing-cutover"
    const reservationID = "reservation-existing-cutover"
    await reserve(conversationID, reservationID)
    await runInDurableObject(settings(), async (_instance, state) => {
      await state.storage.put(`usage-cutover:${conversationID}`, {
        cutoverID: "prior-cutover",
        sessionID,
        throughSeq: 8,
        expectedSnapshotID: "c".repeat(64),
        openingBalances: [],
        createdAt: Date.now(),
        historicalUsageUnreconciled: true,
      })
    })
    const snapshot = await preview(conversationID, sessionID, reservationID)
    expect(snapshot.blockers).toContain("existing_cutover_epoch")
    const proposal = await proposalFor(snapshot)
    const response = await post("/usage/reconciliation", proposal)
    expect(response.status).toBe(409)
    expect(await stored(`reservation:${conversationID}`)).toMatchObject({ reservationID })
    expect(await stored(`operator-reconciliation:receipt:${proposal.receiptID}`)).toBeUndefined()
  })

  it("stores observed usage on its measured UTC date while retiring the hold on its origin date", async () => {
    const original = new Date()
    vi.setSystemTime(new Date("2026-11-12T12:00:00.000Z"))
    try {
      const conversationID = "operator-cross-midnight"
      const sessionID = "session-cross-midnight"
      const reservationID = "reservation-cross-midnight"
      await reserve(conversationID, reservationID, "2026-11-11")
      const snapshot = await preview(conversationID, sessionID, reservationID)
      const proposal = await proposalFor(snapshot, {
        receiptID: "operator-cross-midnight-1",
        usageDate: "2026-11-12",
        assistantMessageID: "msg-cross-midnight",
      })
      const applied = await post("/usage/reconciliation", proposal)
      expect(applied.status).toBe(200)
      expect(await stored("usage:2026-11-12:operator-cross-midnight")).toMatchObject({
        costUSD: 0.0017703, input: 5885, output: 4, sourced: true,
      })
      expect(await stored("usage:2026-11-11:operator-cross-midnight")).toBeUndefined()
      expect(await stored(`reservation-retired:${JSON.stringify([conversationID, reservationID])}`)).toMatchObject({
        date: "2026-11-11", released: true,
      })

      const native = await post("/usage", {
        conversationID, sessionID, sourceID: "native-cross-midnight",
        date: "2026-11-12", costUSD: 0.0017703, input: 5885, output: 4,
        assistantMessageID: "msg-cross-midnight",
      })
      expect(native.status).toBe(200)
      expect(await stored("usage:2026-11-12:operator-cross-midnight")).toMatchObject({
        costUSD: 0.0017703, input: 5885, output: 4,
      })
    } finally {
      vi.setSystemTime(original)
    }
  })

  it("blocks cross-midnight imports when another retained day has uncorrelated legacy usage", async () => {
    const original = new Date()
    vi.setSystemTime(new Date("2026-11-12T12:00:00.000Z"))
    try {
      const conversationID = "operator-cross-midnight-ambiguous"
      const sessionID = "session-cross-midnight-ambiguous"
      const reservationID = "reservation-cross-midnight-ambiguous"
      await reserve(conversationID, reservationID, "2026-11-11")
      await runInDurableObject(settings(), async (_instance, state) => {
        await state.storage.put(`usage:2026-11-12:${conversationID}`, {
          costUSD: 0.25, input: 250, output: 25,
        })
      })

      const snapshot = await preview(conversationID, sessionID, reservationID)
      expect(snapshot.observedActualBlockers).toContain("uncorrelated_legacy_usage:2026-11-12")
      const proposal = await proposalFor(snapshot, {
        receiptID: "operator-cross-midnight-ambiguous-1",
        usageDate: "2026-11-12",
        assistantMessageID: "msg-cross-midnight-ambiguous",
      })
      const response = await post("/usage/reconciliation", proposal)
      expect(response.status).toBe(409)
      expect(await stored("usage:2026-11-12:operator-cross-midnight-ambiguous")).toMatchObject({
        costUSD: 0.25, input: 250, output: 25,
      })
      expect(await stored("usage:2026-11-11:operator-cross-midnight-ambiguous")).toBeUndefined()
      expect(await stored(`reservation:${conversationID}`)).toMatchObject({ reservationID, date: "2026-11-11" })
      expect(await stored(`reservation-retired:${JSON.stringify([conversationID, reservationID])}`)).toBeUndefined()
      expect(await stored(`operator-reconciliation:receipt:${proposal.receiptID}`)).toBeUndefined()
    } finally {
      vi.setSystemTime(original)
    }
  })

  it("separates historical origin attribution from current-day actuals and all outstanding holds", async () => {
    const original = new Date()
    vi.setSystemTime(new Date("2026-11-12T12:00:00.000Z"))
    try {
      const conversationID = "operator-current-budget-basis"
      const sessionID = "session-current-budget-basis"
      const reservationID = "reservation-current-budget-basis"
      await reserve(conversationID, reservationID, "2026-11-11")
      await runInDurableObject(settings(), async (_instance, state) => {
        await state.storage.put("reservation:other-old", {
          conversationID: "other-old", reservationID: "old-hold", date: "2026-11-10", costUSD: 0.25,
        })
        await state.storage.put("reservation:other-today", {
          conversationID: "other-today", reservationID: "today-hold", date: today(), costUSD: 0.2,
        })
        await state.storage.put("usage:2026-11-09:reserve:legacy", { costUSD: 0.3, reserved: true })
        await state.storage.put(`usage:${today()}:other-actual`, { costUSD: 0.04, input: 4, output: 1 })
      })

      const snapshot = await preview(conversationID, sessionID, reservationID)
      expect(snapshot.projectedDayBasis).toMatchObject({
        basis: "historical_origin_date_attribution",
        date: "2026-11-11",
        actualUSD: 0,
        reservedUSD: 0.1,
        attributedUSD: 0.1,
      })
      expect(snapshot.projectedDayBasis).not.toHaveProperty("budgetUSD")
      expect(snapshot.projectedDayBasis).not.toHaveProperty("remainingUSD")
      expect(snapshot.currentBudgetBasis.date).toBe("2026-11-12")
      expect(snapshot.currentBudgetBasis.actualUSD).toBeCloseTo(0.04)
      expect(snapshot.currentBudgetBasis.reservedUSD).toBeCloseTo(0.85)
      expect(snapshot.currentBudgetBasis.admittedUSD).toBeCloseTo(0.89)
      expect(snapshot.currentBudgetBasis.remainingUSD).toBeCloseTo(
        Math.max(0, snapshot.currentBudgetBasis.budgetUSD - 0.89),
      )
      const usageToday = await (await settings().fetch("https://settings/usage/today")).json() as Record<string, unknown>
      expect(usageToday.date).toBe("2026-11-12")
      expect(usageToday.costUSD).toBeCloseTo(0.04)
      expect(usageToday.reservedUSD).toBeCloseTo(0.85)
      expect(usageToday.admittedUSD).toBeCloseTo(0.89)
    } finally {
      vi.setSystemTime(original)
    }
  })

  it("rejects a preview when another conversation changes the current budget basis", async () => {
    const conversationID = "operator-current-basis-stale"
    const sessionID = "session-current-basis-stale"
    const reservationID = "reservation-current-basis-stale"
    await reserve(conversationID, reservationID)
    const snapshot = await preview(conversationID, sessionID, reservationID)
    await runInDurableObject(settings(), async (_instance, state) => {
      await state.storage.put(`usage:${today()}:unrelated-spend`, { costUSD: 0.2, input: 20, output: 2 })
    })

    const response = await post("/usage/reconciliation", await proposalFor(snapshot))
    expect(response.status).toBe(409)
    expect(await stored(`reservation:${conversationID}`)).toMatchObject({ reservationID })
    expect(await stored(`usage:${today()}:unrelated-spend`)).toMatchObject({ costUSD: 0.2 })
  })

  it("changes the bound current budget date at UTC rollover", async () => {
    const original = new Date()
    vi.setSystemTime(new Date("2026-11-11T23:59:00.000Z"))
    try {
      const conversationID = "operator-current-basis-rollover"
      const sessionID = "session-current-basis-rollover"
      const reservationID = "reservation-current-basis-rollover"
      await reserve(conversationID, reservationID)
      const snapshot = await preview(conversationID, sessionID, reservationID)
      expect(snapshot.currentBudgetBasis.date).toBe("2026-11-11")
      vi.setSystemTime(new Date("2026-11-12T00:01:00.000Z"))
      const response = await post("/usage/reconciliation", await proposalFor(snapshot))
      expect(response.status).toBe(409)
      expect(await stored(`reservation:${conversationID}`)).toMatchObject({ reservationID, date: "2026-11-11" })
      expect(await stored("usage:2026-11-12:operator-current-basis-rollover")).toBeUndefined()
    } finally {
      vi.setSystemTime(original)
    }
  })
})
