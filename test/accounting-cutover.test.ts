import { beforeEach, describe, expect, it } from "vitest"
import { env, runInDurableObject, SELF } from "cloudflare:test"
import type { Conversation } from "../src/conversation"
import { ACCOUNTING_POLICY_CONFIG, ACCOUNTING_POLICY_ID } from "../src/accounting-policy"

const settings = () => env.SETTINGS.getByName("global")
const API = { authorization: "Bearer test-token" }

async function clearSettings(): Promise<void> {
  await runInDurableObject(settings(), async (_instance, state) => state.storage.deleteAll())
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

function durableRow(
  sessionID: string,
  seq: number,
  type: string,
  data: Record<string, unknown> = {},
) {
  const payload: Record<string, unknown> = { sessionID, ...data }
  return {
    id: `evt-${sessionID}-${seq}`,
    created: Date.now(),
    type,
    durable: { aggregateID: sessionID, seq, version: 1 },
    data: payload,
  }
}

function logResponse(request: Request | string | URL, sessionID: string, rows: readonly ReturnType<typeof durableRow>[]) {
  const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url)
  const after = Number(url.searchParams.get("after") ?? -1)
  const watermark = rows.at(-1)?.durable.seq ?? 0
  const output = [
    ...rows.filter((row) => row.durable.seq > after),
    { type: "log.synced", aggregateID: sessionID, ...(watermark ? { seq: watermark } : {}) },
  ]
  return new Response(output.map((row) => `data: ${JSON.stringify(row)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

interface FakeOptions {
  config?: unknown
  busy?: number
  idle?: number
  rows?: ReturnType<typeof durableRow>[]
  generation?: string
  sessionID?: string
  stepCost?: number
  logQueries?: string[]
}

function fakeContainer(options: FakeOptions = {}) {
  const sessionID = options.sessionID ?? "ses_cutover"
  const rows = options.rows ?? [
    durableRow(sessionID, 0, "session.created"),
    durableRow(sessionID, 1, "session.execution.started"),
    durableRow(sessionID, 2, "session.step.ended", {
      assistantMessageID: "assistant-cutover",
      finish: "stop",
      cost: options.stepCost ?? 0,
      tokens: { input: 0, output: 0 },
    }),
    durableRow(sessionID, 3, "session.execution.succeeded"),
  ]
  return (port: number) => ({
    async fetch(input: Request | string | URL): Promise<Response> {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
      if (port === 4001) {
        if (url.pathname === "/status") return json({ initialized: true })
        if (url.pathname === "/start") {
          return json({
            ok: true,
            accountingPolicy: ACCOUNTING_POLICY_ID,
            opencodeGeneration: options.generation ?? "opencode-cutover-generation",
          })
        }
        if (url.pathname === "/configure") return json({ ok: true })
      }
      if (url.pathname === "/health") return json({ ok: true })
      if (url.pathname === "/api/config") return json(options.config ?? [
        { type: "document", info: ACCOUNTING_POLICY_CONFIG },
      ])
      if (url.pathname === `/api/session/${sessionID}`) {
        return json({ data: { id: sessionID, time: { created: 1, updated: Date.now(), busy: options.busy, idle: options.idle ?? Date.now() } } })
      }
      if (url.pathname === `/api/experimental/session/${sessionID}/log`) {
        options.logQueries?.push(url.searchParams.get("after") ?? "<omitted>")
        return logResponse(input, sessionID, rows)
      }
      return json({ error: "not found" }, 404)
    },
  })
}

function conversationInternals(instance: Conversation) {
  return instance as unknown as {
    ctx: { id: { toString(): string } }
    transport?: (port: number) => { fetch(input: Request | string | URL): Promise<Response> }
    usage: { recordContext(messages: unknown[]): Promise<void>; refresh(sessionID: string): Promise<void> }
  }
}

async function seedState(
  instance: Conversation,
  storage: { put(key: string, value: unknown): Promise<void> },
  options: FakeOptions = {},
): Promise<void> {
  conversationInternals(instance).transport = fakeContainer(options)
  await storage.put("state", {
    sessionID: options.sessionID ?? "ses_cutover",
    phase: "idle",
    seen: [],
    pending: {},
  })
}

async function preview(instance: Conversation): Promise<Response> {
  return instance.fetch(new Request("https://conversation/accounting/cutover"))
}

describe("accounting cutover", () => {
  beforeEach(clearSettings)

  it("previews from sequence one so the native sequence-zero session.created row is excluded", async () => {
    const logQueries: string[] = []
    const plan = await runInDurableObject(env.CONVERSATION.getByName("C1:cutover-zero-sequence"), async (instance, state) => {
      await seedState(instance, state.storage, { logQueries })
      const response = await preview(instance)
      return await response.json() as { canApply: boolean; throughSeq: number }
    })

    expect(logQueries).toEqual(["0"])
    expect(plan).toMatchObject({ canApply: true, throughSeq: 3 })
  })

  it("previews without changing ledger balances or local usage cursors", async () => {
    const stub = env.CONVERSATION.getByName("C1:cutover-preview")
    const result = await runInDurableObject(stub, async (instance, state) => {
      await seedState(instance, state.storage)
      const internals = conversationInternals(instance)
      const conversationID = internals.ctx.id.toString()
      const beforeSeed = await settings().fetch("https://settings/usage", {
        method: "POST",
        body: JSON.stringify({ conversationID, date: new Date().toISOString().slice(0, 10), costUSD: 1.25, input: 20, output: 4 }),
      })
      expect(beforeSeed.ok).toBe(true)
      const before = await settings().fetch(`https://settings/usage/cutover?conversationID=${conversationID}`)
      const response = await preview(instance)
      const plan = await response.json() as { canApply: boolean; planID: string; historicalUsageUnreconciled: boolean }
      const after = await settings().fetch(`https://settings/usage/cutover?conversationID=${conversationID}`)
      const local = await state.storage.get<{ usageCursor?: unknown; usageTerminal?: unknown }>("state")
      return {
        plan,
        before: await before.json() as { snapshotID: string; rows: Array<{ sourced?: boolean; costUSD: number }> },
        after: await after.json() as { snapshotID: string; rows: Array<{ sourced?: boolean; costUSD: number }> },
        local,
      }
    })
    expect(result.plan).toMatchObject({ canApply: true, historicalUsageUnreconciled: true })
    expect(result.plan.planID).toMatch(/^[a-f0-9]{64}$/)
    expect(result.after.snapshotID).toBe(result.before.snapshotID)
    expect(result.after.rows[0]?.sourced).toBeUndefined()
    expect(result.after.rows[0]?.costUSD).toBe(1.25)
    expect(result.local?.usageCursor).toBeUndefined()
    expect(result.local?.usageTerminal).toBeUndefined()
  })

  it("blocks active sessions and an unsafe effective runtime policy", async () => {
    const active = await runInDurableObject(env.CONVERSATION.getByName("C1:cutover-active"), async (instance, state) => {
      await seedState(instance, state.storage, { busy: Date.now(), idle: 1, rows: [
        durableRow("ses_cutover", 1, "session.execution.started"),
      ] })
      return await (await preview(instance)).json() as { canApply: boolean; blockers: string[] }
    })
    expect(active.canApply).toBe(false)
    expect(active.blockers).toContain("provider_session_busy")

    const unsafe = await runInDurableObject(env.CONVERSATION.getByName("C1:cutover-unsafe"), async (instance, state) => {
      await seedState(instance, state.storage, {
        config: [{ type: "document", info: { experimental: { background_compaction: true }, agents: { title: { disabled: false } } } }],
      })
      const response = await preview(instance)
      return { body: await response.json() as { canApply: boolean; blockers: string[] }, state: await state.storage.get("state") }
    })
    expect(unsafe.body.canApply).toBe(false)
    expect(unsafe.body.blockers).toContain("foreground_runtime_or_log_unavailable")
    expect(unsafe.state).toMatchObject({ sessionID: "ses_cutover", phase: "idle" })
  })

  it("fails closed on missing runtime proof without recycling an active container", async () => {
    const stub = env.CONVERSATION.getByName("C1:cutover-proof-failure")
    const result = await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put("state", {
        sessionID: "ses_cutover",
        phase: "running",
        settingsVersion: 0,
        budgetReservation: { reservationID: "held", date: new Date().toISOString().slice(0, 10), dispatched: true },
        seen: [],
        pending: {},
      })
      let destroyCalls = 0
      let promptCalls = 0
      const internals = instance as unknown as {
        ctx: { container?: unknown }
        transport?: (port: number) => { fetch(input: Request | string | URL): Promise<Response> }
        withClient<T>(fn: (client: unknown) => Promise<T>): Promise<T>
      }
      Object.defineProperty(internals.ctx, "container", {
        configurable: true,
        value: {
          running: true,
          async setInactivityTimeout() {},
          async destroy() { destroyCalls++ },
        },
      })
      internals.transport = fakeContainer({ generation: "" })
      const errors: string[] = []
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await internals.withClient(async () => {
            promptCalls++
            return "sent"
          })
        } catch (error) {
          errors.push(String(error))
        }
      }
      return {
        errors,
        destroyCalls,
        promptCalls,
        state: await state.storage.get<{ phase: string; budgetReservation?: { dispatched: boolean } }>("state"),
      }
    })
    expect(result.errors).toHaveLength(2)
    expect(result.errors.every((error) => error.includes("AccountingPolicyError"))).toBe(true)
    expect(result.destroyCalls).toBe(0)
    expect(result.promptCalls).toBe(0)
    expect(result.state).toMatchObject({ phase: "running", budgetReservation: { dispatched: true } })
  })

  it("preserves an unpriced historical failed step as unreconciled opening balance", async () => {
    const stub = env.CONVERSATION.getByName("C1:cutover-unpriced-history")
    const result = await runInDurableObject(stub, async (instance, state) => {
      await seedState(instance, state.storage, { rows: [
        durableRow("ses_cutover", 1, "session.execution.started"),
        durableRow("ses_cutover", 2, "session.step.failed", {
          assistantMessageID: "failed-old-step",
          error: { name: "ProviderError", message: "historical failure" },
        }),
        durableRow("ses_cutover", 3, "session.execution.failed"),
      ] })
      const conversationID = conversationInternals(instance).ctx.id.toString()
      await settings().fetch("https://settings/usage", {
        method: "POST",
        body: JSON.stringify({ conversationID, date: new Date().toISOString().slice(0, 10), costUSD: 0.75, input: 12, output: 2 }),
      })
      const plan = await (await preview(instance)).json() as {
        canApply: boolean
        historicalUsageUnreconciled: boolean
        throughSeq: number
      }
      return { plan, conversationID }
    })
    expect(result.plan).toMatchObject({ canApply: true, historicalUsageUnreconciled: true, throughSeq: 3 })
  })

  it("rejects an execution terminal frame without its session identity", async () => {
    const terminal = {
      ...durableRow("ses_cutover", 3, "session.execution.succeeded"),
      data: {},
    }
    const plan = await runInDurableObject(env.CONVERSATION.getByName("C1:cutover-malformed-fence"), async (instance, state) => {
      await seedState(instance, state.storage, { rows: [
        durableRow("ses_cutover", 1, "session.execution.started"),
        durableRow("ses_cutover", 2, "session.step.ended", {
          assistantMessageID: "assistant-cutover", cost: 0, tokens: { input: 0, output: 0 },
        }),
        terminal,
      ] })
      return await (await preview(instance)).json() as { canApply: boolean; blockers: string[] }
    })
    expect(plan.canApply).toBe(false)
    expect(plan.blockers).toContain("foreground_runtime_or_log_unavailable")
  })

  it("rejects a changed preview plan without applying a receipt", async () => {
    const stub = env.CONVERSATION.getByName("C1:cutover-changed")
    const result = await runInDurableObject(stub, async (instance, state) => {
      await seedState(instance, state.storage)
      const conversationID = conversationInternals(instance).ctx.id.toString()
      const before = await (await preview(instance)).json() as { canApply: boolean; planID: string }
      expect(before.canApply).toBe(true)
      await settings().fetch("https://settings/usage", {
        method: "POST",
        body: JSON.stringify({ conversationID, date: new Date().toISOString().slice(0, 10), costUSD: 0.5, input: 3, output: 1 }),
      })
      const applied = await instance.fetch(new Request("https://conversation/accounting/cutover", {
        method: "POST",
        body: JSON.stringify({ expectedPlanID: before.planID }),
      }))
      const status = await settings().fetch(`https://settings/usage/cutover?conversationID=${conversationID}`)
      return { applied, status: await status.json() as { receipt?: unknown } }
    })
    expect(result.applied.status).toBe(409)
    expect(result.status.receipt).toBeUndefined()
  })

  it("applies an opening balance and reports later events in the new epoch", async () => {
    const stub = env.CONVERSATION.getByName("C1:cutover-apply")
    const result = await runInDurableObject(stub, async (instance, state) => {
      let futureRows: ReturnType<typeof durableRow>[] | undefined
      await seedState(instance, state.storage)
      const internals = conversationInternals(instance)
      const original = internals.transport!
      internals.transport = (port) => {
        const fake = original(port)
        return {
          async fetch(input) {
            const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
            if (port === 4000 && url.pathname === "/api/experimental/session/ses_cutover/log" && futureRows) {
              return logResponse(input, "ses_cutover", futureRows)
            }
            return fake.fetch(input)
          },
        }
      }
      const conversationID = internals.ctx.id.toString()
      await settings().fetch("https://settings/usage", {
        method: "POST",
        body: JSON.stringify({ conversationID, date: new Date().toISOString().slice(0, 10), costUSD: 2, input: 40, output: 8 }),
      })
      const plan = await (await preview(instance)).json() as { canApply: boolean; planID: string; throughSeq: number }
      const applied = await instance.fetch(new Request("https://conversation/accounting/cutover", {
        method: "POST",
        body: JSON.stringify({ expectedPlanID: plan.planID }),
      }))
      const receipt = await applied.json() as { ok: boolean; cutoverID: string; throughSeq: number }
      const row = await runInDurableObject(settings(), async (_settings, storage) =>
        storage.storage.get<{ costUSD: number; input: number; output: number; sourced?: boolean; legacyOpening?: unknown }>(
          `usage:${new Date().toISOString().slice(0, 10)}:${conversationID}`,
        ),
      )
      futureRows = [
        durableRow("ses_cutover", 1, "session.execution.started"),
        durableRow("ses_cutover", 2, "session.step.ended", {
          assistantMessageID: "assistant-cutover", cost: 0, tokens: { input: 0, output: 0 },
        }),
        durableRow("ses_cutover", 3, "session.execution.succeeded"),
        durableRow("ses_cutover", 4, "session.usage.recorded", {
          source: "title", cost: 0.25, tokens: { input: 5, output: 1 },
        }),
      ]
      await internals.usage.refresh("ses_cutover")
      const nextState = await state.storage.get<{ usageCursor?: { seq: number } }>("state")
      const current = await runInDurableObject(settings(), async (_settings, storage) =>
        storage.storage.get<{ costUSD: number; input: number; output: number; sourced?: boolean }>(
          `usage:${new Date().toISOString().slice(0, 10)}:${conversationID}`,
        ),
      )
      return { plan, applied: receipt, row, current, nextState }
    })
    expect(result.applied).toMatchObject({ ok: true, throughSeq: 3 })
    expect(result.row).toMatchObject({ costUSD: 2, input: 40, output: 8, sourced: true, legacyOpening: { costUSD: 2 } })
    expect(result.current).toMatchObject({ costUSD: 2.25, input: 45, output: 9, sourced: true })
    expect(result.nextState?.usageCursor?.seq).toBe(4)
  })

  it("recovers an acknowledged central cutover receipt after a lost local response", async () => {
    const stub = env.CONVERSATION.getByName("C1:cutover-recovery")
    const result = await runInDurableObject(stub, async (instance, state) => {
      await seedState(instance, state.storage)
      const conversationID = conversationInternals(instance).ctx.id.toString()
      const plan = await (await preview(instance)).json() as {
        canApply: boolean; planID: string; throughSeq: number; ledger: { snapshotID: string }
      }
      expect(plan.canApply).toBe(true)
      const committedResponse = await settings().fetch("https://settings/usage/cutover", {
        method: "POST",
        body: JSON.stringify({
          conversationID,
          cutoverID: plan.planID,
          expectedSnapshotID: plan.ledger.snapshotID,
          sessionID: "ses_cutover",
          throughSeq: plan.throughSeq,
        }),
      })
      expect(committedResponse.ok).toBe(true)
      const committed = await committedResponse.json() as {
        cutoverID: string
        sessionID: string
        throughSeq: number
        expectedSnapshotID: string
      }
      const localBeforeRecovery = await state.storage.get<{ usageCursor?: unknown }>("state")
      const recovered = await instance.fetch(new Request("https://conversation/accounting/cutover", {
        method: "POST",
        body: JSON.stringify({ expectedPlanID: plan.planID }),
      }))
      return { committed, localBeforeRecovery, recovered: await recovered.json() }
    })
    expect(result.localBeforeRecovery?.usageCursor).toBeUndefined()
    expect(result.recovered).toMatchObject({
      ok: true,
      recovered: true,
      receipt: {
        cutoverID: result.committed.cutoverID,
        sessionID: result.committed.sessionID,
        throughSeq: result.committed.throughSeq,
        expectedSnapshotID: result.committed.expectedSnapshotID,
      },
    })
  })

  it("keeps the receipt epoch after reset and reports a replacement session", async () => {
    const stub = env.CONVERSATION.getByName("C1:cutover-new-session")
    const result = await runInDurableObject(stub, async (instance, state) => {
      await seedState(instance, state.storage)
      const internals = conversationInternals(instance)
      const conversationID = internals.ctx.id.toString()
      const plan = await (await preview(instance)).json() as { canApply: boolean; planID: string }
      expect(plan.canApply).toBe(true)
      const applied = await instance.fetch(new Request("https://conversation/accounting/cutover", {
        method: "POST",
        body: JSON.stringify({ expectedPlanID: plan.planID }),
      }))
      expect(applied.ok).toBe(true)

      const reset = await instance.fetch(new Request("https://conversation/reset", { method: "POST" }))
      expect(reset.status).toBe(200)
      const newSession = "ses_after_cutover_reset"
      internals.transport = fakeContainer({ sessionID: newSession, stepCost: 0.4 })
      await state.storage.put("state", {
        sessionID: newSession,
        phase: "idle",
        seen: [],
        pending: {},
      })
      await internals.usage.recordContext([{ id: "assistant-cutover", type: "assistant", cost: 0.4 }])
      return {
        conversationID,
        local: await state.storage.get<{ usageCursor?: { sessionID: string; seq: number } }>("state"),
      }
    })
    const today = new Date().toISOString().slice(0, 10)
    const row = await runInDurableObject(settings(), async (_instance, storage) =>
      storage.storage.get<{ costUSD: number; sourced?: boolean }>(`usage:${today}:${result.conversationID}`),
    )
    expect(row).toMatchObject({ costUSD: 0.4, sourced: true })
    expect(result.local?.usageCursor).toEqual({ sessionID: "ses_after_cutover_reset", seq: 3 })
  })

  it("blocks apply when the provider log watermark falls behind the local cursor", async () => {
    const stub = env.CONVERSATION.getByName("C1:cutover-stale-log")
    const result = await runInDurableObject(stub, async (instance, state) => {
      await seedState(instance, state.storage, {
        rows: [
          durableRow("ses_cutover", 1, "session.execution.started"),
          durableRow("ses_cutover", 2, "session.step.ended", {
            assistantMessageID: "assistant-cutover", cost: 0, tokens: { input: 0, output: 0 },
          }),
          durableRow("ses_cutover", 3, "session.execution.succeeded"),
        ],
      })
      await state.storage.put("state", {
        sessionID: "ses_cutover",
        phase: "idle",
        usageCursor: { sessionID: "ses_cutover", seq: 4 },
        seen: [],
        pending: {},
      })
      const conversationID = conversationInternals(instance).ctx.id.toString()
      const before = await settings().fetch(`https://settings/usage/cutover?conversationID=${conversationID}`)
      const plan = await (await preview(instance)).json() as { canApply: boolean; blockers: string[]; planID: string }
      const applied = await instance.fetch(new Request("https://conversation/accounting/cutover", {
        method: "POST",
        body: JSON.stringify({ expectedPlanID: plan.planID }),
      }))
      const after = await settings().fetch(`https://settings/usage/cutover?conversationID=${conversationID}`)
      return {
        plan,
        applied,
        before: await before.json() as { snapshotID: string },
        after: await after.json() as { snapshotID: string; receipt?: unknown },
      }
    })
    expect(result.plan.canApply).toBe(false)
    expect(result.plan.blockers).toContain("provider_log_behind_local_cursor")
    expect(result.applied.status).toBe(409)
    expect(result.after.snapshotID).toBe(result.before.snapshotID)
    expect(result.after.receipt).toBeUndefined()
  })

  it("validates public apply bodies before recording a conversation", async () => {
    const before = await (await settings().fetch("https://settings/conversations")).json() as { conversations: Array<{ key: string }> }
    const response = await SELF.fetch("https://harness.test/api/conversations/cutover-invalid/accounting/cutover", {
      method: "POST",
      headers: { ...API, "content-type": "application/json" },
      body: JSON.stringify({ expectedPlanID: "bad" }),
    })
    const after = await (await settings().fetch("https://settings/conversations")).json() as { conversations: Array<{ key: string }> }
    expect(response.status).toBe(400)
    expect(after.conversations.some(({ key }) => key === "cutover-invalid")).toBe(before.conversations.some(({ key }) => key === "cutover-invalid"))
  })
})
