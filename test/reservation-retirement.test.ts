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

async function reset(): Promise<void> {
  await runInDurableObject(settings(), async (_instance, state) => state.storage.deleteAll())
}

async function reserve(conversationID: string, reservationID: string, costUSD = 0.1): Promise<Response> {
  return post("/usage/reserve", { conversationID, reservationID, costUSD })
}

async function preview(conversationID: string, reservationID: string): Promise<Record<string, any>> {
  return (await (await settings().fetch(
    `https://settings/usage/cutover?conversationID=${encodeURIComponent(conversationID)}&reservationID=${encodeURIComponent(reservationID)}`,
  )).json()) as Record<string, any>
}

async function stored(key: string): Promise<any> {
  return runInDurableObject(settings(), async (_instance, state) => state.storage.get(key))
}

function retiredKey(conversationID: string, reservationID: string): string {
  return `reservation-retired:${JSON.stringify([conversationID, reservationID])}`
}

function cancelBody(conversationID: string, reservationID: string, expectedSnapshotID: string) {
  return { conversationID, reservationID, expectedSnapshotID }
}

describe("Settings reservation retirement", () => {
  beforeEach(reset)

  it("fences a delayed acquire whether it arrives before or after cancellation", async () => {
    const beforeCancel = "reserve-before-cancel"
    const grant = await reserve(beforeCancel, "r-before")
    expect(grant.ok).toBe(true)
    const grantBody = await grant.json() as { date: string }
    const beforePlan = await preview(beforeCancel, "r-before")
    const cancelled = await post("/usage/cancel", cancelBody(beforeCancel, "r-before", beforePlan.snapshotID))
    expect(cancelled.status).toBe(200)
    expect(await cancelled.json()).toMatchObject({
      ok: true,
      released: true,
      retirement: {
        conversationID: beforeCancel,
        reservationID: "r-before",
        date: grantBody.date,
        reason: "cancelled_before_dispatch",
      },
    })
    const delayedAfter = await reserve(beforeCancel, "r-before")
    expect(delayedAfter.status).toBe(409)
    expect(await delayedAfter.json()).toMatchObject({ code: "reservation_retired" })
    expect(await stored(`reservation:${beforeCancel}`)).toBeUndefined()

    const afterCancel = "cancel-before-reserve"
    const plan = await preview(afterCancel, "r-after")
    const cancellation = await post("/usage/cancel", cancelBody(afterCancel, "r-after", plan.snapshotID))
    expect(await cancellation.json()).toMatchObject({
      ok: true,
      released: false,
      retirement: {
        conversationID: afterCancel,
        reservationID: "r-after",
        reason: "cancelled_before_dispatch",
        released: false,
      },
    })
    expect((await stored(retiredKey(afterCancel, "r-after"))).date).toBeUndefined()
    const delayedBefore = await reserve(afterCancel, "r-after")
    expect(delayedBefore.status).toBe(409)
    expect(await stored(`reservation:${afterCancel}`)).toBeUndefined()
  })

  it("retires normal releases permanently and preserves the first receipt on retries", async () => {
    const conversationID = "normal-release"
    const held = await reserve(conversationID, "r-release", 0.2)
    const { date } = await held.json() as { date: string }
    const released = await post("/usage/release", { conversationID, reservationID: "r-release", date })
    const receipt = await released.json() as Record<string, any>
    expect(released.status).toBe(200)
    expect(receipt).toMatchObject({
      ok: true,
      released: true,
      retirement: {
        conversationID,
        reservationID: "r-release",
        date,
        reason: "released",
        released: true,
      },
    })
    expect(await (await post("/usage/release", {
      conversationID, reservationID: "r-release", date,
    })).json()).toEqual(receipt)
    const attemptedRecreate = await reserve(conversationID, "r-release", 0.2)
    expect(attemptedRecreate.status).toBe(409)
    expect(await attemptedRecreate.json()).toMatchObject({
      code: "reservation_retired",
      retirement: receipt.retirement,
    })
  })

  it("does not retire or delete a hold when owner, ID, or date does not match", async () => {
    const conversationID = "release-mismatch"
    const held = await reserve(conversationID, "r-owner")
    const { date } = await held.json() as { date: string }

    expect((await post("/usage/release", {
      conversationID, reservationID: "r-other", date,
    })).status).toBe(409)
    expect((await post("/usage/release", {
      conversationID, reservationID: "r-owner", date: "2020-01-01",
    })).status).toBe(409)
    const plan = await preview(conversationID, "r-other")
    expect((await post("/usage/cancel", cancelBody(conversationID, "r-other", plan.snapshotID))).status)
      .toBe(409)
    expect(await stored(`reservation:${conversationID}`)).toMatchObject({
      conversationID, reservationID: "r-owner", date,
    })
    expect(await stored(retiredKey(conversationID, "r-other"))).toBeUndefined()
    expect(await stored(retiredKey(conversationID, "r-owner"))).toBeUndefined()

    const mismatchedOwner = "reservation-owner-mismatch"
    const wrongOwnerKey = `reservation:${mismatchedOwner}`
    await runInDurableObject(settings(), async (_instance, state) => {
      await state.storage.put(wrongOwnerKey, {
        conversationID: "another-conversation",
        reservationID: "r-owner-mismatch",
        date: today(),
        costUSD: 0.1,
      })
    })
    const ownerPlan = await preview(mismatchedOwner, "r-owner-mismatch")
    expect(ownerPlan.holds[0]).toMatchObject({
      conversationID: "another-conversation",
      invalidFields: ["conversationID"],
    })
    expect((await post("/usage/cancel", cancelBody(
      mismatchedOwner, "r-owner-mismatch", ownerPlan.snapshotID,
    ))).status).toBe(409)
    expect((await post("/usage/release", {
      conversationID: mismatchedOwner,
      reservationID: "r-owner-mismatch",
      date: today(),
    })).status).toBe(409)
    expect(await stored(wrongOwnerKey)).toMatchObject({ conversationID: "another-conversation" })
    expect(await stored(retiredKey(mismatchedOwner, "r-owner-mismatch"))).toBeUndefined()
  })

  it("blocks cancellation for malformed central holds and legacy holds", async () => {
    const malformedConversation = "cancel-malformed-hold"
    const malformedKey = `reservation:${malformedConversation}`
    await runInDurableObject(settings(), async (_instance, state) => {
      await state.storage.put(malformedKey, {
        conversationID: malformedConversation,
        reservationID: "r-malformed",
        costUSD: 0.1,
      })
    })
    const malformedPlan = await preview(malformedConversation, "r-malformed")
    expect(malformedPlan.holds[0].invalidFields).toContain("date")
    expect((await post("/usage/cancel", cancelBody(
      malformedConversation, "r-malformed", malformedPlan.snapshotID,
    ))).status).toBe(409)
    expect(await stored(malformedKey)).toMatchObject({ reservationID: "r-malformed", costUSD: 0.1 })
    expect(await stored(retiredKey(malformedConversation, "r-malformed"))).toBeUndefined()

    const legacyConversation = "cancel-legacy-hold"
    const legacyKey = `usage:${today()}:reserve:${legacyConversation}`
    await runInDurableObject(settings(), async (_instance, state) => {
      await state.storage.put(legacyKey, { costUSD: 0.1, reserved: true })
    })
    const legacyPlan = await preview(legacyConversation, "r-local")
    expect(legacyPlan.holds).toMatchObject([{ kind: "legacy-reservation", conversationID: legacyConversation }])
    expect((await post("/usage/cancel", cancelBody(
      legacyConversation, "r-local", legacyPlan.snapshotID,
    ))).status).toBe(409)
    expect(await stored(legacyKey)).toEqual({ costUSD: 0.1, reserved: true })
    expect(await stored(retiredKey(legacyConversation, "r-local"))).toBeUndefined()
  })

  it("rejects a changed cancellation snapshot without retiring or deleting", async () => {
    const conversationID = "cancel-stale"
    const held = await reserve(conversationID, "r-stale")
    const { date } = await held.json() as { date: string }
    const plan = await preview(conversationID, "r-stale")
    await runInDurableObject(settings(), async (_instance, state) => {
      await state.storage.put(`usage:${today()}:${conversationID}`, {
        costUSD: 0.31, input: 1, output: 1, updatedAt: 1,
      })
    })

    const response = await post("/usage/cancel", cancelBody(conversationID, "r-stale", plan.snapshotID))
    expect(response.status).toBe(409)
    expect(await stored(`reservation:${conversationID}`)).toMatchObject({ reservationID: "r-stale", date })
    expect(await stored(`usage:${today()}:${conversationID}`)).toMatchObject({ costUSD: 0.31 })
    expect(await stored(retiredKey(conversationID, "r-stale"))).toBeUndefined()
  })

  it("makes absent-hold cancellation idempotent after a lost acknowledgement", async () => {
    const conversationID = "cancel-lost-ack"
    const firstPlan = await preview(conversationID, "proposal")
    const first = await post("/usage/cancel", cancelBody(conversationID, "proposal", firstPlan.snapshotID))
    const receipt = await first.json()
    await runInDurableObject(settings(), async (_instance, state) => {
      await state.storage.put(`usage:${today()}:concurrent-unrelated`, {
        costUSD: 9, input: 9, output: 9, updatedAt: 15,
      })
    })
    const retry = await post("/usage/cancel", cancelBody(conversationID, "proposal", "0".repeat(64)))
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual(receipt)
    expect(await stored(`reservation:${conversationID}`)).toBeUndefined()
  })

  it("binds retirement into targeted previews and preserves it across daily pruning without changing spend", async () => {
    const conversationID = "retirement-retention"
    const actualKey = `usage:${today()}:${conversationID}`
    await runInDurableObject(settings(), async (_instance, state) => {
      await state.storage.put(actualKey, { costUSD: 0.37, input: 37, output: 3, updatedAt: 20 })
    })
    const globalBefore = await settings().fetch("https://settings/usage/cutover?conversationID=retirement-retention")
    const globalSnapshot = (await globalBefore.json() as { snapshotID: string }).snapshotID
    const targetedBefore = await preview(conversationID, "r-retired")
    expect(targetedBefore.snapshotID).not.toBe(globalSnapshot)

    const retirement = await post("/usage/release", {
      conversationID, reservationID: "r-retired", date: today(),
    })
    expect(await retirement.json()).toMatchObject({ released: false, retirement: { reason: "released" } })
    const targetedAfter = await preview(conversationID, "r-retired")
    expect(targetedAfter.snapshotID).not.toBe(targetedBefore.snapshotID)
    const globalAfter = await settings().fetch("https://settings/usage/cutover?conversationID=retirement-retention")
    expect((await globalAfter.json() as { snapshotID: string }).snapshotID).toBe(globalSnapshot)

    const oldDate = new Date(Date.now() - 31 * 86_400_000).toISOString().slice(0, 10)
    const oldActualKey = `usage:${oldDate}:${conversationID}`
    await runInDurableObject(settings(), async (_instance, state) => {
      await state.storage.put(oldActualKey, { costUSD: 1, input: 10, output: 1 })
    })
    await post("/alerts/check", { metrics: {}, spendUSD: 0, budgetUSD: 0 })
    const daily = await (await settings().fetch("https://settings/usage/today")).json() as {
      costUSD: number; input: number; output: number
    }
    expect(await stored(retiredKey(conversationID, "r-retired"))).toMatchObject({
      reason: "released",
      released: false,
    })
    expect(await stored(oldActualKey)).toBeUndefined()
    expect(daily).toMatchObject({ costUSD: 0.37, input: 37, output: 3 })
  })
})
