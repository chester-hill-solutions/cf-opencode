import { beforeEach, describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"

const settings = () => env.SETTINGS.getByName("global")
const today = () => new Date().toISOString().slice(0, 10)

async function post(path: string, body: unknown): Promise<Response> {
  return settings().fetch(`https://settings${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function preview(conversationID: string): Promise<Record<string, any>> {
  const response = await settings().fetch(
    `https://settings/usage/cutover?conversationID=${encodeURIComponent(conversationID)}`,
  )
  return (await response.json()) as Record<string, any>
}

function apply(body: Record<string, unknown>): Promise<Response> {
  return post("/usage/cutover", body)
}

async function reset(): Promise<void> {
  await runInDurableObject(settings(), async (_instance, state) => state.storage.deleteAll())
}

async function stored(key: string): Promise<any> {
  return runInDurableObject(settings(), async (_instance, state) => state.storage.get(key))
}

function applicationFor(plan: Record<string, any>, conversationID: string, patch = {}) {
  return {
    conversationID,
    cutoverID: "cutover-1",
    expectedSnapshotID: plan.snapshotID,
    sessionID: "session-1",
    throughSeq: 8,
    ...patch,
  }
}

function sourceReport(conversationID: string, sourceID: string, patch = {}) {
  return {
    conversationID,
    sessionID: "session-1",
    sourceID,
    date: today(),
    costUSD: 0.2,
    input: 2,
    output: 1,
    cutoverID: "cutover-1",
    seq: 9,
    ...patch,
  }
}

describe("usage ledger cutover", () => {
  beforeEach(reset)

  it("previews a deterministic snapshot without writing anything", async () => {
    const conversationID = "cutover-preview"
    const key = `usage:${today()}:${conversationID}`
    const row = { costUSD: 0.4, input: 40, output: 4, updatedAt: 123, custom: { kept: true } }
    await runInDurableObject(settings(), async (_instance, state) => state.storage.put(key, row))

    const before = await stored(key)
    const first = await preview(conversationID)
    const second = await preview(conversationID)
    const receipt = await stored(`usage-cutover:${conversationID}`)

    expect(first).toMatchObject({
      conversationID,
      rows: [{ date: today(), costUSD: 0.4, input: 40, output: 4, updatedAt: 123 }],
      legacyRows: [{ date: today(), costUSD: 0.4, input: 40, output: 4 }],
      holds: [],
    })
    expect(first.snapshotID).toMatch(/^[a-f0-9]{64}$/)
    expect(second.snapshotID).toBe(first.snapshotID)
    expect(before).toEqual(await stored(key))
    expect(receipt).toBeUndefined()
  })

  it("preserves legacy balances, updates budget actuals, and retains metadata through new spend", async () => {
    const conversationID = "cutover-preserve"
    const priorDay = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    await post("/put", { dailyBudgetUSD: 0.55 })
    await runInDurableObject(settings(), async (_instance, state) => {
      await state.storage.put(`usage:${today()}:${conversationID}`, {
        costUSD: 0.5, input: 50, output: 5, updatedAt: 100, custom: { kept: true },
      })
      await state.storage.put(`usage:${priorDay}:${conversationID}`, {
        costUSD: 1.25, input: 125, output: 12, updatedAt: 101,
      })
    })
    const plan = await preview(conversationID)
    const response = await apply(applicationFor(plan, conversationID))
    expect(response.ok).toBe(true)
    const receipt = await response.json() as Record<string, any>
    expect(receipt).toMatchObject({
      ok: true,
      cutoverID: "cutover-1",
      sessionID: "session-1",
      throughSeq: 8,
      historicalUsageUnreconciled: true,
      openingBalances: [
        { date: priorDay, costUSD: 1.25, input: 125, output: 12 },
        { date: today(), costUSD: 0.5, input: 50, output: 5 },
      ],
    })
    expect(await stored(`usage:${today()}:${conversationID}`)).toMatchObject({
      costUSD: 0.5,
      input: 50,
      output: 5,
      sourced: true,
      legacyOpening: { costUSD: 0.5, input: 50, output: 5 },
      cutoverID: "cutover-1",
      custom: { kept: true },
    })

    const budgetDenied = await post("/usage/reserve", {
      conversationID,
      reservationID: "hold-cutover-preserve",
      costUSD: 0.1,
    })
    expect(budgetDenied.status).toBe(429)
    expect(await stored(`reservation:${conversationID}`)).toBeUndefined()
    expect(await (await settings().fetch("https://settings/usage/today")).json()).toMatchObject({
      costUSD: 0.5,
      input: 50,
      output: 5,
      historicalUsageUnreconciled: true,
    })
    await post("/put", { dailyBudgetUSD: 2 })
    expect((await post("/usage/reserve", {
      conversationID,
      reservationID: "hold-cutover-preserve",
      costUSD: 0.1,
    })).status).toBe(200)

    expect((await post("/usage", sourceReport(conversationID, "after-cutover"))).ok).toBe(true)
    expect(await stored(`usage:${today()}:${conversationID}`)).toMatchObject({
      costUSD: 0.7,
      input: 52,
      output: 6,
      sourced: true,
      legacyOpening: { costUSD: 0.5, input: 50, output: 5 },
      cutoverID: "cutover-1",
      custom: { kept: true },
    })
  })

  it("rejects cutover when a hold exists or the preview snapshot changed", async () => {
    const conversationID = "cutover-stale"
    const date = today()
    const key = `usage:${date}:${conversationID}`
    await runInDurableObject(settings(), async (_instance, state) => {
      await state.storage.put(key, { costUSD: 0.3, input: 3, output: 1, updatedAt: 10 })
      await state.storage.put(`reservation:${conversationID}`, {
        conversationID, reservationID: "pending", date, costUSD: 0.1,
      })
    })
    const blockedPlan = await preview(conversationID)
    expect((await apply(applicationFor(blockedPlan, conversationID))).status).toBe(409)
    const heldRow = await stored(key)
    expect(heldRow.costUSD).toBe(0.3)
    expect(heldRow.sourced).toBeUndefined()
    expect(await stored(`usage-cutover:${conversationID}`)).toBeUndefined()

    await runInDurableObject(settings(), async (_instance, state) => {
      await state.storage.delete(`reservation:${conversationID}`)
    })
    const plan = await preview(conversationID)
    await runInDurableObject(settings(), async (_instance, state) => {
      await state.storage.put(key, { costUSD: 0.31, input: 3, output: 1, updatedAt: 11 })
    })
    expect((await apply(applicationFor(plan, conversationID))).status).toBe(409)
    const changedRow = await stored(key)
    expect(changedRow.costUSD).toBe(0.31)
    expect(changedRow.sourced).toBeUndefined()
    expect(await stored(`usage-cutover:${conversationID}`)).toBeUndefined()
  })

  it("blocks malformed legacy amounts before mutation while defaulting only missing counters to zero", async () => {
    const conversationID = "cutover-malformed"
    const invalidKey = `usage:${today()}:${conversationID}`
    const missingKey = `usage:${today()}:cutover-missing-counters`
    await runInDurableObject(settings(), async (_instance, state) => {
      await state.storage.put(invalidKey, { costUSD: Number.NaN, input: -1, output: "2", updatedAt: 5 })
      await state.storage.put(missingKey, { costUSD: 0.2, updatedAt: 6 })
    })
    const plan = await preview(conversationID)
    expect(plan.blockers).toEqual([{ date: today(), invalidFields: ["costUSD", "input", "output"] }])
    expect((await apply(applicationFor(plan, conversationID))).status).toBe(409)
    expect((await stored(invalidKey)).costUSD).toBeNaN()

    const missingPlan = await preview("cutover-missing-counters")
    expect(missingPlan.blockers).toEqual([])
    expect((await apply(applicationFor(missingPlan, "cutover-missing-counters"))).ok).toBe(true)
    expect(await stored(missingKey)).toMatchObject({
      costUSD: 0.2,
      input: 0,
      output: 0,
      legacyOpening: { costUSD: 0.2, input: 0, output: 0 },
    })
  })

  it("is idempotent, blocks stale epochs and old writes, and counts only post-watermark events", async () => {
    const conversationID = "cutover-boundary"
    const key = `usage:${today()}:${conversationID}`
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    await runInDurableObject(settings(), async (_instance, state) => {
      await state.storage.put(key, { costUSD: 0.4, input: 4, output: 2, updatedAt: 44 })
    })
    expect((await post("/usage", sourceReport(conversationID, "date-bound-source", {
      date: yesterday, costUSD: 0.05, input: 1, output: 0,
    }))).ok).toBe(true)
    const plan = await preview(conversationID)
    const input = applicationFor(plan, conversationID)
    const first = await apply(input)
    const savedReceipt = await first.json()
    expect(await (await apply(input)).json()).toEqual(savedReceipt)
    expect((await apply(applicationFor(plan, conversationID, { cutoverID: "another" }))).status).toBe(409)

    expect((await post("/usage", {
      conversationID, date: today(), costUSD: 99, input: 99, output: 99,
    })).status).toBe(409)
    expect((await post("/usage", sourceReport(conversationID, "old-missing-epoch", {
      cutoverID: undefined, seq: undefined,
    }))).status).toBe(409)
    expect((await post("/usage", sourceReport(conversationID, "old-wrong-epoch", {
      cutoverID: "stale", seq: 9,
    }))).status).toBe(409)
    const covered = await post("/usage", sourceReport(conversationID, "covered-event", { seq: 8 }))
    expect(await covered.json()).toMatchObject({ ok: true, covered: true })
    expect(await stored(`usage-source:${JSON.stringify([conversationID, "session-1", "covered-event"])}`))
      .toBeUndefined()
    expect((await post("/usage", sourceReport(conversationID, "date-bound-source", {
      seq: 8, date: today(),
    }))).status).toBe(409)
    expect(await stored(key)).toMatchObject({ costUSD: 0.4, input: 4, output: 2 })

    expect((await post("/usage", sourceReport(conversationID, "new-session-event", {
      sessionID: "session-2", seq: 1, costUSD: 0.1,
    }))).ok).toBe(true)
    expect((await post("/usage", sourceReport(conversationID, "post-watermark-event", {
      seq: 9, costUSD: 0.2,
    }))).ok).toBe(true)
    expect(await stored(key)).toMatchObject({ costUSD: 0.7, input: 8, output: 4 })
  })

  it("keeps the cutover receipt after daily pruning removes old aggregate rows", async () => {
    const conversationID = "cutover-retention"
    const plan = await preview(conversationID)
    await apply(applicationFor(plan, conversationID))
    const oldDate = new Date(Date.now() - 31 * 86_400_000).toISOString().slice(0, 10)
    const oldKey = `usage:${oldDate}:${conversationID}`
    await runInDurableObject(settings(), async (_instance, state) => {
      await state.storage.put(oldKey, { costUSD: 1, input: 1, output: 1 })
    })
    await post("/alerts/check", { metrics: {}, spendUSD: 0, budgetUSD: 0 })

    expect(await stored(oldKey)).toBeUndefined()
    expect(await stored(`usage-cutover:${conversationID}`)).toMatchObject({
      cutoverID: "cutover-1",
      historicalUsageUnreconciled: true,
    })
  })
})
