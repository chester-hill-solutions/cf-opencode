import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"

const settings = () => env.SETTINGS.getByName("global")
const today = () => new Date().toISOString().slice(0, 10)

async function reset(): Promise<void> {
  await runInDurableObject(settings(), async (_instance, state) => state.storage.deleteAll())
}

function report(body: unknown): Promise<Response> {
  return settings().fetch("https://settings/usage", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

function reserve(conversationID: string, reservationID = `hold-${conversationID}`): Promise<Response> {
  return settings().fetch("https://settings/usage/reserve", {
    method: "POST",
    body: JSON.stringify({ conversationID, reservationID, costUSD: 0.01 }),
  })
}

function sourced(sourceID: string, values: Partial<Record<"costUSD" | "input" | "output", number>> = {}, extras = {}) {
  return {
    conversationID: "conv-1",
    sessionID: "session-1",
    sourceID,
    date: today(),
    costUSD: 1,
    input: 10,
    output: 2,
    ...values,
    ...extras,
  }
}

async function totals(): Promise<Record<string, unknown>> {
  return (await (await settings().fetch("https://settings/usage/today")).json()) as Record<string, unknown>
}

describe("source-backed usage ledger", () => {
  it("deduplicates replays and keeps a componentwise high-water mark in either arrival order", async () => {
    await reset()
    await report(sourced("evt-b", { costUSD: 2, input: 20, output: 4 }))
    await report(sourced("evt-a", { costUSD: 1, input: 10, output: 2 }))
    await report(sourced("evt-b", { costUSD: 3, input: 15, output: 6 }))
    await report(sourced("evt-b", { costUSD: 2, input: 12, output: 5 }))

    const usage = await totals()
    expect(usage.costUSD).toBe(4)
    expect(usage.input).toBe(30)
    expect(usage.output).toBe(8)
  })

  it("counts distinct sources concurrently and keeps sessions independently keyed", async () => {
    await reset()
    const concurrent = await Promise.all([
      report(sourced("evt-a", {}, { sessionID: "session-1" })),
      report(sourced("evt-a", { costUSD: 2, input: 20, output: 4 }, { sessionID: "session-2" })),
    ])
    expect(concurrent.every((response) => response.ok)).toBe(true)
    expect(await totals()).toMatchObject({ costUSD: 3, input: 30, output: 6, conversations: 1 })
  })

  it("rejects reuse of a source identity on another date", async () => {
    await reset()
    expect((await report(sourced("evt-a"))).status).toBe(200)
    const next = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    const response = await report(sourced("evt-a", {}, { date: next }))
    expect(response.status).toBe(409)
  })

  it("rejects malformed IDs, amounts, and dates", async () => {
    await reset()
    expect((await report(null)).status).toBe(400)
    expect((await report([])).status).toBe(400)
    const valid = sourced("evt-a")
    for (const [key, value] of [
      ["costUSD", -1], ["input", Number.NaN], ["output", Number.POSITIVE_INFINITY],
      ["date", "2026-02-30"], ["date", "2999-01-01"], ["conversationID", " "],
      ["sessionID", "x".repeat(257)], ["sourceID", ""],
    ] as Array<[string, unknown]>) {
      const response = await report({ ...valid, [key]: value })
      expect(response.status, `${key}=${String(value)}`).toBe(400)
    }
    expect((await report({ ...valid, date: "2000-01-01" })).status).toBe(400)
  })

  it("preserves legacy missing-counter defaults and rejects aggregate overflow atomically", async () => {
    await reset()
    const legacy = await report({ conversationID: "legacy", date: today(), costUSD: 1 })
    expect(legacy.ok).toBe(true)

    expect((await report(sourced("huge-a", { costUSD: 1e308, input: 0, output: 0 }))).ok).toBe(true)
    const overflow = await report(sourced("huge-b", { costUSD: 1e308, input: 0, output: 0 }))
    expect(overflow.status).toBe(400)
    // The failed aggregate transaction must not reserve the source identity.
    const retry = await report(sourced("huge-b", { costUSD: 1, input: 0, output: 0 }))
    expect(retry.ok).toBe(true)
  })

  it("keeps legacy reports monotonic and fails closed when legacy and source rows mix", async () => {
    await reset()
    const date = today()
    const legacy = { conversationID: "conv-1", date, costUSD: 5, input: 50, output: 5 }
    expect((await report(legacy)).ok).toBe(true)
    expect((await report({ ...legacy, costUSD: 3, input: 60, output: 1 })).ok).toBe(true)

    const mixed = await report(sourced("evt-a"))
    expect(mixed.status).toBe(409)
    const usage = await totals()
    expect(usage).toMatchObject({ costUSD: 5, input: 60, output: 5 })
  })

  it("allows conversion of a zero legacy row, then rejects legacy updates", async () => {
    await reset()
    const date = today()
    await report({ conversationID: "conv-1", date, costUSD: 0, input: 0, output: 0 })
    expect((await report(sourced("evt-a"))).ok).toBe(true)
    expect((await report({ conversationID: "conv-1", date, costUSD: 1, input: 1, output: 1 })).status).toBe(409)
  })

  it("blocks new reservations only for conversations with retained nonzero legacy actual rows", async () => {
    await reset()
    await settings().fetch("https://settings/put", {
      method: "POST",
      body: JSON.stringify({ dailyBudgetUSD: 0 }),
    })
    const date = today()
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    const expired = new Date(Date.now() - 31 * 86_400_000).toISOString().slice(0, 10)
    await runInDurableObject(settings(), async (_instance, state) => {
      await state.storage.put(`usage:${date}:legacy-today`, { costUSD: 0.01, input: 0, output: 0 })
      await state.storage.put(`usage:${yesterday}:legacy-prior`, { costUSD: 0.01, input: 0, output: 0 })
      await state.storage.put(`usage:${date}:zero-legacy`, { costUSD: 0, input: 0, output: 0 })
      await state.storage.put(`usage:${expired}:expired-legacy`, { costUSD: 0.01, input: 0, output: 0 })
      await state.storage.put(`usage:${date}:unrelated-legacy`, { costUSD: 0.01, input: 0, output: 0 })
    })
    expect((await report(sourced("evt-sourced", {}, { conversationID: "source-backed" }))).ok).toBe(true)

    const sameDay = await reserve("legacy-today")
    const priorDay = await reserve("legacy-prior")
    const zero = await reserve("zero-legacy")
    const expiredRow = await reserve("expired-legacy")
    const unrelated = await reserve("new-conversation")
    const sourceBacked = await reserve("source-backed")
    const storedHolds = await runInDurableObject(settings(), async (_instance, state) => ({
      sameDay: await state.storage.get("reservation:legacy-today"),
      priorDay: await state.storage.get("reservation:legacy-prior"),
    }))

    expect(sameDay.status).toBe(409)
    expect(priorDay.status).toBe(409)
    expect(await sameDay.json()).toMatchObject({
      code: "legacy_usage_requires_migration",
      error: expect.stringContaining("legacy accounting migration"),
    })
    expect(zero.status).toBe(200)
    expect(expiredRow.status).toBe(200)
    expect(unrelated.status).toBe(200)
    expect(sourceBacked.status).toBe(200)
    expect(storedHolds).toEqual({ sameDay: undefined, priorDay: undefined })
  })
})
