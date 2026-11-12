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

async function setBudget(dailyBudgetUSD: number): Promise<void> {
  const response = await post("/put", { dailyBudgetUSD })
  expect(response.ok).toBe(true)
}

async function clearSettings(): Promise<void> {
  await runInDurableObject(settings(), async (_instance, state) => {
    await state.storage.deleteAll()
  })
}

describe("Settings budget reservations", () => {
  beforeEach(clearSettings)

  it("atomically admits only one concurrent reservation within the cap", async () => {
    await setBudget(0.1)
    const results = await Promise.all([
      post("/usage/reserve", { conversationID: "one", reservationID: "r1", costUSD: 0.1 }),
      post("/usage/reserve", { conversationID: "two", reservationID: "r2", costUSD: 0.1 }),
    ])

    expect(results.map((response) => response.status).sort()).toEqual([200, 429])
    const denial = await results.find((response) => response.status === 429)!.json()
    expect(denial).toMatchObject({ spentUSD: 0, reservedUSD: 0.1, budgetUSD: 0.1 })
  })

  it("reuses the original reference on a same-owner retry", async () => {
    await setBudget(0.1)
    const first = await post("/usage/reserve", { conversationID: "one", reservationID: "r1", costUSD: 0.1 })
    const initial = await first.json()
    const retry = await post("/usage/reserve", { conversationID: "one", reservationID: "r1", costUSD: 0.1 })

    expect(first.status).toBe(200)
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual(initial)
    expect(initial).toMatchObject({ ok: true, reservationID: "r1", date: today() })
  })

  it("rejects another owner and protects a hold from stale and missing releases", async () => {
    await setBudget(1)
    await post("/usage/reserve", { conversationID: "one", reservationID: "r1", costUSD: 0.1 })

    const otherOwner = await post("/usage/reserve", {
      conversationID: "one", reservationID: "r2", costUSD: 0.1,
    })
    const staleRelease = await post("/usage/release", {
      conversationID: "one", reservationID: "old", date: today(),
    })
    const stillHeld = await settings().fetch("https://settings/usage/today")
    const released = await post("/usage/release", {
      conversationID: "one", reservationID: "r1", date: today(),
    })
    const missingRelease = await post("/usage/release", {
      conversationID: "one", reservationID: "r1", date: today(),
    })

    expect(otherOwner.status).toBe(409)
    expect(staleRelease.status).toBe(409)
    expect((await stillHeld.json() as { reservedUSD?: number }).reservedUSD).toBe(0.1)
    expect(await released.json()).toMatchObject({
      ok: true,
      released: true,
      retirement: {
        conversationID: "one",
        reservationID: "r1",
        date: today(),
        reason: "released",
        released: true,
        retiredAt: expect.any(Number),
      },
    })
    expect(await missingRelease.json()).toMatchObject({
      ok: true,
      released: true,
      retirement: {
        conversationID: "one",
        reservationID: "r1",
        date: today(),
        reason: "released",
        released: true,
        retiredAt: expect.any(Number),
      },
    })
  })

  it("rejects wrong types and non-finite reservation amounts", async () => {
    for (const body of [
      { conversationID: "one", reservationID: "r1", costUSD: "0.1" },
      { conversationID: "one", reservationID: "r1", costUSD: null },
      { conversationID: "one", reservationID: "r1", costUSD: Number.NaN },
      { conversationID: 1, reservationID: "r1", costUSD: 0.1 },
      { conversationID: "one", reservationID: "", costUSD: 0.1 },
    ]) {
      expect((await post("/usage/reserve", body)).status).toBe(400)
    }
  })

  it("disables headroom enforcement when the configured budget is zero", async () => {
    await setBudget(0)
    await post("/usage", { conversationID: "spent", date: today(), costUSD: 10 })

    const response = await post("/usage/reserve", {
      conversationID: "one", reservationID: "r1", costUSD: 0.1,
    })

    expect(response.status).toBe(200)
  })

  it("allows a decimal total equal to the cap but still denies real overage", async () => {
    await setBudget(0.3)
    await post("/usage", { conversationID: "at-cap", date: today(), costUSD: 0.2 })
    const atCap = await post("/usage/reserve", {
      conversationID: "at-cap-reservation", reservationID: "r1", costUSD: 0.1,
    })

    await clearSettings()
    await setBudget(0.3)
    await post("/usage", { conversationID: "over-cap", date: today(), costUSD: 0.200001 })
    const overCap = await post("/usage/reserve", {
      conversationID: "over-cap-reservation", reservationID: "r2", costUSD: 0.1,
    })

    expect(atCap.status).toBe(200)
    expect(overCap.status).toBe(429)
  })

  it("counts old legacy holds across days and retains them during pruning", async () => {
    await setBudget(0.1)
    const oldHoldKey = "usage:2020-01-01:reserve:legacy-owner"
    await runInDurableObject(settings(), async (_instance, state) => {
      await state.storage.put(oldHoldKey, { costUSD: 0.08, reserved: true })
      await state.storage.put(`usage:${today()}:actual`, {
        costUSD: 0.01, input: 7, output: 3,
      })
    })

    const denied = await post("/usage/reserve", {
      conversationID: "new", reservationID: "r1", costUSD: 0.02,
    })
    const unknownLegacyOwner = await post("/usage/reserve", {
      conversationID: "legacy-owner", reservationID: "new-reference", costUSD: 0.01,
    })
    const report = await (await settings().fetch("https://settings/usage/today")).json()
    await post("/alerts/check", { metrics: {}, spendUSD: 0, budgetUSD: 0.1 })
    const retained = await runInDurableObject(settings(), async (_instance, state) =>
      state.storage.get(oldHoldKey),
    )

    expect(denied.status).toBe(429)
    expect(unknownLegacyOwner.status).toBe(409)
    expect(report).toMatchObject({
      costUSD: 0.01,
      reservedUSD: 0.08,
      admittedUSD: 0.09,
      input: 7,
      output: 3,
      conversations: 1,
    })
    expect(retained).toEqual({ costUSD: 0.08, reserved: true })
  })

  it("keeps actual usage separate from legacy and new holds and rejects an old release shape", async () => {
    await setBudget(0.2)
    const legacyKey = "usage:2020-01-01:reserve:legacy-owner"
    const actualKey = `usage:${today()}:actual-owner`
    const actual = { costUSD: 0.01, input: 7, output: 3 }
    await runInDurableObject(settings(), async (_instance, state) => {
      await state.storage.put(legacyKey, { costUSD: 0.08, reserved: true })
      await state.storage.put(actualKey, actual)
    })
    expect((await post("/usage/reserve", {
      conversationID: "new-owner", reservationID: "r-new", costUSD: 0.02,
    })).status).toBe(200)

    const obsoleteRelease = await post("/usage/release", {
      conversationID: "legacy-owner", date: "2020-01-01",
    })
    const report = await (await settings().fetch("https://settings/usage/today")).json()
    const stored = await runInDurableObject(settings(), async (_instance, state) => ({
      legacy: await state.storage.get(legacyKey),
      actual: await state.storage.get(actualKey),
      newHold: await state.storage.get("reservation:new-owner"),
    }))

    expect(obsoleteRelease.status).toBe(400)
    expect(report).toMatchObject({
      costUSD: 0.01, reservedUSD: 0.1, admittedUSD: 0.11,
      input: 7, output: 3, conversations: 1,
    })
    expect(stored).toEqual({
      legacy: { costUSD: 0.08, reserved: true },
      actual,
      newHold: { conversationID: "new-owner", reservationID: "r-new", date: today(), costUSD: 0.02 },
    })
  })
})
