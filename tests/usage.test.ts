import { describe, expect, test } from "bun:test"
import { AUX_SEEN_LIMIT, auxAfterEvent, emptyAux, sumUsage } from "../src/usage"

describe("usage arithmetic", () => {
  test("sums step and auxiliary totals", () => {
    expect(
      sumUsage(
        { date: "2026-11-08", costUSD: 1.25, input: 100, output: 10 },
        { date: "2026-11-08", costUSD: 0.5, input: 10, output: 2 },
      ),
    ).toEqual({ date: "2026-11-08", costUSD: 1.75, input: 110, output: 12 })
  })

  test("counts an auxiliary event once by id", () => {
    const first = auxAfterEvent(emptyAux("2026-11-08"), "evt_1", 0.5, 10, 2)
    expect(first).toMatchObject({ costUSD: 0.5, input: 10, output: 2, seen: ["evt_1"] })
    expect(auxAfterEvent(first!, "evt_1", 0.5, 10, 2)).toBeUndefined()
  })

  test("bounds the dedupe list", () => {
    let aux = emptyAux("2026-11-08")
    for (let i = 0; i < AUX_SEEN_LIMIT + 10; i++) {
      aux = auxAfterEvent(aux, `evt_${i}`, 0, 1, 0)!
    }
    expect(aux.seen).toHaveLength(AUX_SEEN_LIMIT)
    expect(aux.seen.at(-1)).toBe(`evt_${AUX_SEEN_LIMIT + 9}`)
  })
})
