import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"

/**
 * The ledger is the sum of the session's step totals and deduplicated
 * title/compaction events. A settle-time context write must not drop the
 * auxiliary spend, and a replayed recorded event must not double count.
 */

const settings = () => env.SETTINGS.getByName("global")

async function todayUsage(): Promise<{ costUSD: number; input: number; output: number }> {
  const response = await settings().fetch("https://settings/usage/today")
  return (await response.json()) as { costUSD: number; input: number; output: number }
}

function recorded(id: string, cost: number, input: number, output: number): string {
  return JSON.stringify({
    id,
    type: "session.usage.recorded",
    data: { sessionID: "ses_1", source: "title", cost, tokens: { input, output } },
  })
}

function updated(cost: number, input: number, output: number): string {
  return JSON.stringify({
    id: "evt_updated",
    type: "session.usage.updated",
    data: { sessionID: "ses_1", cost, tokens: { input, output } },
  })
}

describe("usage ledger", () => {
  it("dedupes auxiliary events and preserves them across settle", async () => {
    await runInDurableObject(settings(), async (_instance, state) => {
      await state.storage.deleteAll()
    })

    const stub = env.CONVERSATION.getByName("C1:usage-ledger")
    const result = await runInDurableObject(stub, async (instance, state) => {
      const call = (raw: string, mode: "replace" | "add") =>
        (instance as unknown as { recordUsage(raw: string, mode: "replace" | "add"): Promise<void> })
          .recordUsage(raw, mode)
      const settle = (messages: unknown[]) =>
        (
          instance as unknown as { recordContextUsage(messages: unknown[]): Promise<void> }
        ).recordContextUsage(messages)

      await call(recorded("evt_1", 0.5, 10, 2), "add")
      await call(recorded("evt_1", 0.5, 10, 2), "add")
      const afterDuplicate = (await state.storage.get<{ usageAux: { seen: string[] } }>("state"))
        ?.usageAux

      await call(updated(1, 100, 10), "replace")
      const afterReplace = (await state.storage.get<{ usage: { costUSD: number } }>("state"))?.usage

      await settle([
        {
          id: "a1",
          type: "assistant",
          time: { created: Date.now() },
          cost: 1,
          tokens: { input: 100, output: 10 },
        },
      ])
      const afterSettle = (await state.storage.get<{ usage: { costUSD: number } }>("state"))?.usage

      return { afterDuplicate, afterReplace, afterSettle }
    })

    const usage = await todayUsage()
    // 1.0 step + 0.5 title, counted once even though evt_1 was replayed.
    expect(usage.costUSD).toBeCloseTo(1.5)
    expect(usage.input).toBe(110)
    expect(usage.output).toBe(12)
    expect(result.afterDuplicate?.seen).toEqual(["evt_1"])
    // The stored step total stays separate from the auxiliary total.
    expect(result.afterReplace?.costUSD).toBe(1)
    expect(result.afterSettle?.costUSD).toBe(1)
  })
})
