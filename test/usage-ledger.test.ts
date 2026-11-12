import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"

async function todayUsage(): Promise<{ costUSD: number; input: number; output: number }> {
  const response = await env.SETTINGS.getByName("global").fetch("https://settings/usage/today")
  return (await response.json()) as { costUSD: number; input: number; output: number }
}

function durableEvent(
  id: string,
  seq: number,
  type: string,
  data: Record<string, unknown>,
) {
  return {
    id,
    created: Date.now(),
    type,
    durable: { aggregateID: data.sessionID ?? "ses_1", seq },
    data: { sessionID: "ses_1", ...data },
  }
}

describe("durable usage ledger", () => {
  it("replays step and auxiliary actuals once and proves the terminal step", async () => {
    await runInDurableObject(env.SETTINGS.getByName("global"), async (_instance, state) => {
      await state.storage.deleteAll()
    })

    const stub = env.CONVERSATION.getByName("C1:usage-ledger")
    const result = await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("state", { sessionID: "ses_1", seen: [], pending: {} })
      const rows = [
        durableEvent("execution-start", 1, "session.execution.started", {}),
        durableEvent("step-1", 2, "session.step.ended", {
          assistantMessageID: "assistant-1", cost: 1, tokens: { input: 100, output: 10 },
        }),
        durableEvent("title-1", 5, "session.usage.recorded", {
          source: "title", cost: 0.5, tokens: { input: 10, output: 2 },
        }),
        durableEvent("step-2", 7, "session.step.ended", {
          assistantMessageID: "assistant-2", cost: 0, tokens: { input: 0, output: 0 },
        }),
        durableEvent("execution-succeeded", 8, "session.execution.succeeded", {}),
      ]
      let watermark = 8
      const iterable = async function* (after = 0) {
        for (const row of rows) {
          const seq = (row as { durable?: { seq?: number } }).durable?.seq
          if (seq === undefined || seq > after) yield row
        }
        yield { type: "log.synced", aggregateID: "ses_1", seq: watermark }
      }
      const target = instance as unknown as {
        withClient<T>(fn: (client: any) => Promise<T>): Promise<T>
        recordContextUsage(messages: unknown[]): Promise<void>
        refreshUsageFromLog(sessionID: string): Promise<void>
      }
      target.withClient = async (fn) => fn({
        experimental: { session: { log: ({ after }: { after?: number }) => iterable(after) } },
      })
      const messages = [{ id: "assistant-2", type: "assistant", cost: 0, finish: "stop" }]
      // A warm replay can cross the terminal step before settlement sees the
      // same log. Its persisted terminal id must let settlement prove it.
      await target.refreshUsageFromLog("ses_1")
      await target.recordContextUsage(messages)
      await target.recordContextUsage(messages)
      rows.push(durableEvent("late-title", 9, "session.usage.recorded", {
        source: "title", cost: 0.25, tokens: { input: 5, output: 1 },
      }))
      watermark = 9
      await target.refreshUsageFromLog("ses_1")
      return state.storage.get<{ usageCursor: { sessionID: string; seq: number }; usageTerminal: { assistantMessageID: string } }>("state")
    })

    const usage = await todayUsage()
    expect(usage.costUSD).toBeCloseTo(1.75)
    expect(usage.input).toBe(115)
    expect(usage.output).toBe(13)
    expect(result?.usageCursor).toEqual({ sessionID: "ses_1", seq: 9 })
    expect(result?.usageTerminal).toEqual({ sessionID: "ses_1", assistantMessageID: "assistant-2", seq: 7 })
  })

  it("does not advance past an unacknowledged usage report or an incomplete log", async () => {
    const stub = env.CONVERSATION.getByName("C1:usage-incomplete")
    const result = await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("state", { sessionID: "ses_1", seen: [], pending: {} })
      const rows = [
        durableEvent("execution-start", 1, "session.execution.started", {}),
        durableEvent("step-x", 2, "session.step.ended", {
          assistantMessageID: "assistant-x", cost: 0, tokens: { input: 0, output: 0 },
        }),
        durableEvent("execution-succeeded", 3, "session.execution.succeeded", {}),
      ]
      const iterable = async function* () { yield* rows }
      const target = instance as unknown as {
        withClient<T>(fn: (client: any) => Promise<T>): Promise<T>
        recordContextUsage(messages: unknown[]): Promise<void>
      }
      target.withClient = async (fn) => fn({
        experimental: { session: { log: () => iterable() } },
      })
      let error = ""
      try {
        await target.recordContextUsage([{ id: "assistant-x", type: "assistant" }])
      } catch (caught) {
        error = String(caught)
      }
      return { error, saved: await state.storage.get<{ usageCursor?: { seq: number } }>("state") }
    })
    expect(result.error).toContain("log.synced")
    expect(result.saved?.usageCursor).toBeUndefined()
  })

  it("fails terminal proof when the durable log has no execution terminal after its last step", async () => {
    const stub = env.CONVERSATION.getByName("C1:usage-missing-execution-terminal")
    const result = await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("state", { sessionID: "ses_1", seen: [], pending: {} })
      const rows = [
        durableEvent("execution-start", 1, "session.execution.started", {}),
        durableEvent("step-terminal", 2, "session.step.ended", {
          assistantMessageID: "assistant-terminal", cost: 0, tokens: { input: 0, output: 0 },
        }),
      ]
      const target = instance as unknown as {
        withClient<T>(fn: (client: any) => Promise<T>): Promise<T>
        recordContextUsage(messages: unknown[]): Promise<void>
      }
      const iterable = async function* () {
        yield* rows
        yield { type: "log.synced", aggregateID: "ses_1", seq: 2 }
      }
      target.withClient = async (fn) => fn({
        experimental: { session: { log: () => iterable() } },
      })
      let error = ""
      try {
        await target.recordContextUsage([{ id: "assistant-terminal", type: "assistant", cost: 0, finish: "stop" }])
      } catch (caught) {
        error = String(caught)
      }
      return {
        error,
        saved: await state.storage.get<{
          usageCursor?: { seq: number }
          usageExecution?: { terminalSeq: number; latestStepSeq: number }
        }>("state"),
      }
    })

    expect(result.error).toContain("terminal assistant usage")
    expect(result.saved?.usageCursor?.seq).toBe(2)
    expect(result.saved?.usageExecution).toMatchObject({ terminalSeq: 0, latestStepSeq: 2 })
  })

  it("keeps reconstruction fences atomic across a crash and blocks a later unfinished execution", async () => {
    const stub = env.CONVERSATION.getByName("C1:usage-rebuild-crash")
    const result = await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("state", {
        sessionID: "ses_1",
        usageCursor: { sessionID: "ses_1", seq: 2 },
        seen: [],
        pending: {},
      })
      const rows = [
        durableEvent("first-start", 1, "session.execution.started", {}),
        durableEvent("first-step", 2, "session.step.ended", {
          assistantMessageID: "assistant-1", cost: 0.1, tokens: { input: 1, output: 1 },
        }),
        durableEvent("second-start", 3, "session.execution.started", {}),
        durableEvent("second-step", 4, "session.step.ended", {
          assistantMessageID: "assistant-2", cost: 0.2, tokens: { input: 2, output: 1 },
        }),
      ]
      const afterCalls: number[] = []
      const target = instance as unknown as {
        withClient<T>(fn: (client: any) => Promise<T>): Promise<T>
        recordContextUsage(messages: unknown[]): Promise<void>
        withUsageLifecycle(cleanup: () => Promise<Response>): Promise<Response>
      }
      target.withClient = async (fn) => fn({
        experimental: {
          session: {
            log: ({ after }: { after?: number }) => {
              const replay = async function* () {
                afterCalls.push(after ?? 0)
                if (afterCalls.length === 1) {
                  yield rows[0]!
                  throw new Error("simulated log stream interruption")
                }
                for (const row of rows) {
                  const seq = row.durable.seq
                  if (seq > (after ?? 0)) yield row
                }
                yield { type: "log.synced", aggregateID: "ses_1", seq: 4 }
              }
              return replay()
            },
          },
        },
      })

      const messages = [{ id: "assistant-2", type: "assistant", cost: 0.2, finish: "stop" }]
      await target.recordContextUsage(messages).catch(() => {})
      const afterCrash = await state.storage.get<{
        usageCursor?: { seq: number }
        usageExecution?: unknown
        usageTerminal?: unknown
      }>("state")
      let settlementError = ""
      try {
        await target.recordContextUsage(messages)
      } catch (error) {
        settlementError = String(error)
      }
      let cleanupCalls = 0
      const cleanup = await target.withUsageLifecycle(async () => {
        cleanupCalls++
        return Response.json({ ok: true })
      })
      const afterRetry = await state.storage.get<{
        usageCursor?: { seq: number }
        usageExecution?: { startedSeq: number; terminalSeq: number; latestStepSeq: number }
        usageTerminal?: { assistantMessageID: string; seq: number }
      }>("state")
      return {
        afterCalls,
        afterCrash,
        settlementError,
        cleanupStatus: cleanup.status,
        cleanupCalls,
        afterRetry,
      }
    })
    expect(result.afterCalls).toEqual([0, 0, 4])
    expect(result.afterCrash?.usageCursor).toEqual({ sessionID: "ses_1", seq: 2 })
    expect(result.afterCrash?.usageExecution).toBeUndefined()
    expect(result.afterCrash?.usageTerminal).toBeUndefined()
    expect(result.settlementError).toContain("terminal assistant usage")
    expect(result.cleanupStatus).toBe(503)
    expect(result.cleanupCalls).toBe(0)
    expect(result.afterRetry?.usageCursor?.seq).toBe(4)
    expect(result.afterRetry?.usageExecution).toEqual({
      sessionID: "ses_1", startedSeq: 3, terminalSeq: 0, latestStepSeq: 4,
    })
    expect(result.afterRetry?.usageTerminal).toEqual({
      sessionID: "ses_1", assistantMessageID: "assistant-2", seq: 4,
    })
  })

  it("rejects a bare sync marker after a persisted cursor", async () => {
    const stub = env.CONVERSATION.getByName("C1:usage-bare-sync")
    const result = await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("state", {
        sessionID: "ses_1",
        usageCursor: { sessionID: "ses_1", seq: 4 },
        usageTerminal: { sessionID: "ses_1", assistantMessageID: "assistant-4" },
        seen: [],
        pending: {},
      })
      const target = instance as unknown as {
        withClient<T>(fn: (client: any) => Promise<T>): Promise<T>
        recordContextUsage(messages: unknown[]): Promise<void>
      }
      const iterable = async function* () {
        yield { type: "log.synced", aggregateID: "ses_1" }
      }
      target.withClient = async (fn) => fn({
        experimental: { session: { log: () => iterable() } },
      })
      let error = ""
      try {
        await target.recordContextUsage([{ id: "assistant-4", type: "assistant" }])
      } catch (caught) {
        error = String(caught)
      }
      return { error, saved: await state.storage.get<{ usageCursor: { seq: number } }>("state") }
    })
    expect(result.error).toContain("sync marker")
    expect(result.saved?.usageCursor.seq).toBe(4)
  })

  it("keeps the cursor before a report rejected during legacy ledger cutover", async () => {
    const stub = env.CONVERSATION.getByName("C1:usage-rejected")
    const result = await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("state", { sessionID: "ses_1", seen: [], pending: {} })
      const target = instance as unknown as {
        ctx: { id: { toString(): string } }
        withClient<T>(fn: (client: any) => Promise<T>): Promise<T>
        recordContextUsage(messages: unknown[]): Promise<void>
      }
      const seed = await env.SETTINGS.getByName("global").fetch("https://settings/usage", {
        method: "POST",
        body: JSON.stringify({
          conversationID: target.ctx.id.toString(),
          date: new Date().toISOString().slice(0, 10),
          costUSD: 0.1,
          input: 1,
          output: 0,
        }),
      })
      expect(seed.ok).toBe(true)
      const rows = [
        durableEvent("execution-start", 1, "session.execution.started", {}),
        durableEvent("step-rejected", 2, "session.step.ended", {
          assistantMessageID: "assistant-rejected", cost: 0.2, tokens: { input: 2, output: 1 },
        }),
        durableEvent("execution-succeeded", 3, "session.execution.succeeded", {}),
      ]
      const iterable = async function* () {
        yield* rows
        yield { type: "log.synced", aggregateID: "ses_1", seq: 3 }
      }
      target.withClient = async (fn) => fn({
        experimental: { session: { log: () => iterable() } },
      })
      let error = ""
      try {
        await target.recordContextUsage([{ id: "assistant-rejected", type: "assistant" }])
      } catch (caught) {
        error = String(caught)
      }
      const saved = await state.storage.get<{
        usageCursor?: { seq: number }
        usageError?: string
      }>("state")
      return { error, saved }
    })
    expect(result.error).toContain("409")
    expect(result.error).toContain("legacy")
    expect(result.saved?.usageCursor).toBeUndefined()
    expect(result.saved?.usageError).toContain("legacy")
  })

  it("skips expired auxiliary history but reports and proves a current terminal step", async () => {
    const before = await todayUsage()
    const stub = env.CONVERSATION.getByName("C1:usage-expired-aux")
    const result = await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("state", { sessionID: "ses_1", seen: [], pending: {} })
      const old = durableEvent("old-title", 1, "session.usage.recorded", {
        source: "title", cost: 8, tokens: { input: 80, output: 8 },
      })
      old.created = Date.now() - 31 * 24 * 60 * 60 * 1000
      const rows = [
        old,
        durableEvent("execution-start", 2, "session.execution.started", {}),
        durableEvent("fresh-step", 3, "session.step.ended", {
          assistantMessageID: "fresh-assistant", cost: 0.3, tokens: { input: 3, output: 1 },
        }),
        durableEvent("execution-succeeded", 4, "session.execution.succeeded", {}),
      ]
      const iterable = async function* (after = 0) {
        for (const row of rows) {
          const seq = (row as { durable?: { seq?: number } }).durable?.seq
          if (seq !== undefined && seq > after) yield row
        }
        yield { type: "log.synced", aggregateID: "ses_1", seq: 4 }
      }
      const target = instance as unknown as {
        withClient<T>(fn: (client: any) => Promise<T>): Promise<T>
        refreshUsageFromLog(sessionID: string): Promise<void>
        recordContextUsage(messages: unknown[]): Promise<void>
      }
      target.withClient = async (fn) => fn({
        experimental: { session: { log: ({ after }: { after?: number }) => iterable(after) } },
      })
      await target.refreshUsageFromLog("ses_1")
      await target.recordContextUsage([{ id: "fresh-assistant", type: "assistant", cost: 0.3 }])
      return state.storage.get<{ usageCursor: { seq: number }; usageTerminal: { assistantMessageID: string } }>("state")
    })
    const after = await todayUsage()
    expect(after.costUSD - before.costUSD).toBeCloseTo(0.3)
    expect(after.input - before.input).toBe(3)
    expect(after.output - before.output).toBe(1)
    expect(result?.usageCursor.seq).toBe(4)
    expect(result?.usageTerminal.assistantMessageID).toBe("fresh-assistant")
  })

  it("keeps midnight totals by UTC day and adds a new session after reset", async () => {
    const stub = env.CONVERSATION.getByName("C1:usage-reset-midnight")
    const today = new Date().toISOString().slice(0, 10)
    const todayStart = Date.parse(`${today}T00:00:00.000Z`)
    const yesterday = new Date(todayStart - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const oldSession = "ses_usage_old"
    const oldRows = [
      durableEvent("old-execution-start", 1, "session.execution.started", { sessionID: oldSession }),
      durableEvent("reused-aux-id", 2, "session.usage.recorded", {
        sessionID: oldSession, source: "title", cost: 0.2, tokens: { input: 2, output: 1 },
      }),
      durableEvent("reused-step-id", 4, "session.step.ended", {
        sessionID: oldSession, assistantMessageID: "old-terminal", cost: 0.3,
        tokens: { input: 3, output: 1 },
      }),
      durableEvent("old-execution-succeeded", 5, "session.execution.succeeded", { sessionID: oldSession }),
    ]
    oldRows[0]!.created = todayStart - 120_000
    oldRows[1]!.created = todayStart - 60_000
    oldRows[2]!.created = todayStart
    oldRows[3]!.created = todayStart + 1

    const first = await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("state", { sessionID: oldSession, seen: [], pending: {} })
      const target = instance as unknown as {
        ctx: { id: { toString(): string } }
        withClient<T>(fn: (client: any) => Promise<T>): Promise<T>
        recordContextUsage(messages: unknown[]): Promise<void>
      }
      const iterable = async function* (after = 0) {
        for (const row of oldRows) {
          const seq = (row as { durable?: { seq?: number } }).durable?.seq
          if (seq !== undefined && seq > after) yield row
        }
        yield { type: "log.synced", aggregateID: oldSession, seq: 5 }
      }
      target.withClient = async (fn) => fn({
        experimental: { session: { log: ({ after }: { after?: number }) => iterable(after) } },
      })
      const conversationID = target.ctx.id.toString()
      await target.recordContextUsage([{ id: "old-terminal", type: "assistant" }])
      await target.recordContextUsage([{ id: "old-terminal", type: "assistant" }])
      return { conversationID, cursor: await state.storage.get<{ usageCursor: { sessionID: string; seq: number } }>("state") }
    })
    expect(first.cursor?.usageCursor).toEqual({ sessionID: oldSession, seq: 5 })

    const reset = await runInDurableObject(stub, async (instance, state) => {
      const target = instance as unknown as {
        withClient<T>(fn: (client: any) => Promise<T>): Promise<T>
        deleteCheckpoints(): Promise<void>
        refreshUsageFromLog(sessionID: string): Promise<void>
      }
      let logCalls = 0
      let cleanupEntered!: () => void
      let releaseCleanup!: () => void
      const cleanupStarted = new Promise<void>((resolve) => { cleanupEntered = resolve })
      const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve })
      const iterable = async function* () {
        yield { type: "log.synced", aggregateID: oldSession, seq: 5 }
      }
      target.withClient = async (fn) => fn({
        experimental: { session: { log: () => { logCalls++; return iterable() } } },
      })
      target.deleteCheckpoints = async () => {
        cleanupEntered()
        await cleanupGate
      }
      const resetPromise = instance.fetch(new Request("https://conversation/reset", { method: "POST" }))
      await cleanupStarted
      const lateRefresh = target.refreshUsageFromLog(oldSession)
      await Promise.resolve()
      expect(logCalls).toBe(1)
      releaseCleanup()
      const response = await resetPromise
      await lateRefresh
      return { response, logCalls, remainingState: await state.storage.get("state") }
    })
    expect(reset.response.status).toBe(200)
    expect(reset.logCalls).toBe(1)
    expect(reset.remainingState).toBeUndefined()
    const newSession = "ses_usage_new"
    const newRows = [
      durableEvent("new-execution-start", 1, "session.execution.started", { sessionID: newSession }),
      durableEvent("reused-aux-id", 2, "session.usage.recorded", {
        sessionID: newSession, source: "title", cost: 0.4, tokens: { input: 4, output: 1 },
      }),
      durableEvent("reused-step-id", 4, "session.step.ended", {
        sessionID: newSession, assistantMessageID: "new-terminal", cost: 0.5,
        tokens: { input: 5, output: 2 },
      }),
      durableEvent("new-execution-succeeded", 5, "session.execution.succeeded", { sessionID: newSession }),
    ]
    newRows[0]!.created = todayStart - 120_000
    newRows[1]!.created = todayStart - 60_000
    newRows[2]!.created = todayStart
    newRows[3]!.created = todayStart + 1

    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("state", { sessionID: newSession, seen: [], pending: {} })
      const target = instance as unknown as {
        withClient<T>(fn: (client: any) => Promise<T>): Promise<T>
        recordContextUsage(messages: unknown[]): Promise<void>
      }
      const iterable = async function* (after = 0) {
        for (const row of newRows) {
          const seq = (row as { durable?: { seq?: number } }).durable?.seq
          if (seq !== undefined && seq > after) yield row
        }
        yield { type: "log.synced", aggregateID: newSession, seq: 5 }
      }
      target.withClient = async (fn) => fn({
        experimental: { session: { log: ({ after }: { after?: number }) => iterable(after) } },
      })
      await target.recordContextUsage([{ id: "new-terminal", type: "assistant" }])
      await target.recordContextUsage([{ id: "new-terminal", type: "assistant" }])
      expect(await state.storage.get("usageCursor")).toBeUndefined()
    })

    const dateRows = await runInDurableObject(env.SETTINGS.getByName("global"), async (_instance, state) => ({
      yesterday: await state.storage.get<{ costUSD: number; input: number; output: number }>(
        `usage:${yesterday}:${first.conversationID}`,
      ),
      today: await state.storage.get<{ costUSD: number; input: number; output: number }>(
        `usage:${today}:${first.conversationID}`,
      ),
    }))
    expect(dateRows.yesterday?.costUSD).toBeCloseTo(0.6)
    expect(dateRows.yesterday).toMatchObject({ input: 6, output: 2 })
    expect(dateRows.today?.costUSD).toBeCloseTo(0.8)
    expect(dateRows.today).toMatchObject({ input: 8, output: 3 })
  })
})
