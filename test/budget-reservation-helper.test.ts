import { beforeEach, describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"

const settings = () => env.SETTINGS.getByName("global")

async function post(path: string, body: unknown): Promise<Response> {
  return settings().fetch(`https://settings${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function clearSettings(): Promise<void> {
  await runInDurableObject(settings(), async (_instance, state) => {
    await state.storage.deleteAll()
  })
  await post("/put", { dailyBudgetUSD: 0 })
}

describe("conversation budget reservation helpers", () => {
  beforeEach(clearSettings)

  it("persists the grant before marking dispatch and only grants dispatch once", async () => {
    const stub = env.CONVERSATION.getByName("budget-helper-dispatch")
    const result = await runInDurableObject(stub, async (instance) => {
      const acquired = await instance.acquireBudgetReservation()
      if (acquired.kind !== "granted") throw new Error(`expected grant, got ${acquired.kind}`)
      const before = await (await instance.fetch(new Request("https://conversation/state"))).json() as {
        budgetReservation?: unknown
      }
      const firstDispatch = await instance.markBudgetReservationDispatched(acquired.reservation, "baseline-1")
      const state = await (await instance.fetch(new Request("https://conversation/state"))).json() as {
        budgetReservation?: unknown
        runStartedAt?: number
        turnBaseline?: string
      }
      const duplicateDispatch = await instance.markBudgetReservationDispatched(acquired.reservation, "baseline-1")
      const retry = await instance.acquireBudgetReservation()
      return {
        reservation: acquired.reservation,
        before,
        state,
        firstDispatch,
        duplicateDispatch,
        retryKind: retry.kind,
      }
    })

    expect(result.before.budgetReservation).toEqual({ ...result.reservation, dispatched: false })
    expect(result.state.budgetReservation).toEqual({ ...result.reservation, dispatched: true })
    expect(result.state.turnBaseline).toBe("baseline-1")
    expect(result.state.runStartedAt).toEqual(expect.any(Number))
    expect(result.firstDispatch).toBe(true)
    expect(result.duplicateDispatch).toBe(false)
    expect(result.retryKind).toBe("already-dispatched")
  })

  it("does not release a newer hold through a stale captured reference", async () => {
    const stub = env.CONVERSATION.getByName("budget-helper-stale-release")
    const result = await runInDurableObject(stub, async (instance) => {
      const first = await instance.acquireBudgetReservation()
      if (first.kind !== "granted") throw new Error(`expected first grant, got ${first.kind}`)
      const firstReleased = await instance.releaseBudgetReservation(first.reservation)
      const second = await instance.acquireBudgetReservation()
      if (second.kind !== "granted") throw new Error(`expected second grant, got ${second.kind}`)
      const staleRelease = await instance.releaseBudgetReservation(first.reservation)
      const state = await (await instance.fetch(new Request("https://conversation/state"))).json() as {
        budgetReservation?: unknown
      }
      const today = await (await settings().fetch("https://settings/usage/today")).json() as {
        reservedUSD?: number
      }
      return {
        firstReservation: first.reservation,
        firstReleased,
        secondReservation: second.reservation,
        staleRelease,
        state,
        today,
      }
    })

    expect(result.firstReleased).toBe(true)
    expect(result.staleRelease).toBe(false)
    expect(result.state.budgetReservation).toEqual(result.secondReservation)
    expect(result.today.reservedUSD).toBe(0.1)
  })

  it("returns structured denial amounts without retaining a proposed local hold", async () => {
    await post("/put", { dailyBudgetUSD: 0.05 })
    const stub = env.CONVERSATION.getByName("budget-helper-denial")
    const result = await runInDurableObject(stub, async (instance) => {
      const reservationResult = await instance.acquireBudgetReservation()
      const state = await (await instance.fetch(new Request("https://conversation/state"))).json() as {
        budgetReservation?: unknown
      }
      return { result: reservationResult, state }
    })

    // A fixed $0.10 estimate exceeds the enabled $0.05 cap.
    expect(result.result).toMatchObject({
      kind: "denied",
      spentUSD: 0,
      reservedUSD: 0,
      budgetUSD: 0.05,
      message: "daily budget reached ($0.00 spent + $0.00 reserved of $0.05)",
    })
    expect(result.state.budgetReservation).toBeUndefined()
  })

  it("clears only the local proposal after a definitive legacy migration conflict", async () => {
    const stub = env.CONVERSATION.getByName("budget-helper-legacy-migration")
    const result = await runInDurableObject(stub, async (instance) => {
      const target = instance as unknown as { ctx: { id: { toString(): string } } }
      const seeded = await post("/usage", {
        conversationID: target.ctx.id.toString(),
        date: new Date().toISOString().slice(0, 10),
        costUSD: 0.25,
        input: 10,
        output: 2,
      })
      expect(seeded.ok).toBe(true)
      const reservation = await instance.acquireBudgetReservation()
      const state = await (await instance.fetch(new Request("https://conversation/state"))).json() as {
        budgetReservation?: unknown
      }
      const today = await (await settings().fetch("https://settings/usage/today")).json() as {
        reservedUSD?: number
      }
      return { reservation, state, today }
    })
    expect(result.reservation.kind).toBe("conflict")
    if (result.reservation.kind !== "conflict") throw new Error("expected legacy migration conflict")
    expect(result.reservation.message).toContain("legacy usage")
    expect(result.state.budgetReservation).toBeUndefined()
    expect(result.today.reservedUSD).toBe(0)
  })
})
