import { beforeEach, describe, expect, it } from "vitest"
import { env, runInDurableObject, SELF } from "cloudflare:test"
import type { Conversation } from "../src/conversation"
import type { ConversationState } from "../src/state"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"

const API = { authorization: "Bearer test-token" }
const settings = () => env.SETTINGS.getByName("global")
const sessionID = "ses_operator_control"

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

function fakeContainer(options: { waitStatus?: number; generation?: string; calls?: string[]; unknownContext?: boolean; priorOnly?: boolean; toolContinuation?: boolean; compaction?: boolean; pastTurn?: boolean; firstTurn?: boolean } = {}) {
  const generation = options.generation ?? "runtime-operator-generation"
  const now = Date.now() - (options.pastTurn ? 24 * 60 * 60_000 : 0)
  const messages = options.firstTurn ? [
    { id: "switch-operator", type: "model-switched", time: { created: now - 20_000 } },
    { id: "user-operator", type: "user", content: [{ type: "text", text: "private prompt" }], time: { created: now - 1000 } },
    { id: "assistant-operator", type: "assistant", content: [{ type: "text", text: "READY" }],
      time: { created: now - 500, completed: now }, finish: "stop", cost: 0.0017703, tokens: { input: 5885, output: 4 } },
  ] : options.priorOnly ? [
    { id: "baseline-operator", type: "assistant", content: [{ type: "text", text: "prior" }], time: { created: now - 3000, completed: now - 2500 }, finish: "stop", cost: 0.002, tokens: { input: 2, output: 2 } },
  ] : options.unknownContext ? [
    { id: "baseline-operator", type: "assistant", content: [{ type: "text", text: "prior" }], time: { created: now - 3000, completed: now - 2500 }, finish: "stop", cost: 0.002, tokens: { input: 2, output: 2 } },
    { id: "user-operator", type: "user", content: [{ type: "text", text: "private prompt" }], time: { created: now - 1000 } },
    { id: "idle-operator", type: "idle", error: { type: "provider.no-route", message: "unavailable" }, time: { created: now } },
  ] : [
    { id: "baseline-operator", type: "assistant", content: [{ type: "text", text: "prior" }], time: { created: now - 3000, completed: now - 2500 }, finish: "stop", cost: 0.002, tokens: { input: 2, output: 2 } },
    { id: "user-operator", type: "user", content: [{ type: "text", text: "private prompt" }], time: { created: now - 1000 } },
    ...(options.toolContinuation ? [{
      id: "assistant-tool", type: "assistant", content: [{ type: "tool", text: "" }],
      time: { created: now - 700, completed: now - 600 }, finish: "tool-calls", cost: 0.0005, tokens: { input: 50, output: 1 },
    }] : []),
    ...(options.compaction ? [{
      id: "compaction-operator", type: "compaction", time: { created: now - 800 }, cost: 0.003, tokens: { input: 100, output: 20 },
    }] : []),
    {
      id: "assistant-operator", type: "assistant", content: [{ type: "text", text: "READY" }],
      time: { created: now - 500, completed: now }, finish: "stop",
      cost: 0.0017703, tokens: { input: 5885, output: 4 },
    },
  ]
  return (port: number) => ({
    async fetch(input: Request | string | URL): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input)
      const url = new URL(request.url)
      options.calls?.push(`${port}:${request.method}:${url.pathname}`)
      if (port === 4001) {
        if (url.pathname === "/status") return json({ initialized: true })
        if (url.pathname === "/configure") return json({ ok: true })
        if (url.pathname === "/start") return json(accountingPolicyStart.opencodeGeneration === generation
          ? accountingPolicyStart
          : { ...accountingPolicyStart, opencodeGeneration: generation })
        return json({ error: "not found" }, 404)
      }
      if (url.pathname === "/api/config") return json(accountingPolicyConfig)
      if (url.pathname === `/api/experimental/session/${sessionID}/wait`) {
        return new Response(null, { status: options.waitStatus ?? 204 })
      }
      if (url.pathname === `/api/session/${sessionID}`) {
        return json({ data: { id: sessionID, location: { directory: "/workspace" }, time: { created: 1, updated: Date.now(), idle: Date.now() } } })
      }
      if (url.pathname === `/api/session/${sessionID}/context`) return json({ data: messages })
      if (url.pathname === `/api/session/${sessionID}/inbox`) return json({ data: [] })
      if (url.pathname === `/api/session/${sessionID}/form`) return json({ data: [] })
      if (url.pathname === "/api/permission/request") return json({ data: [] })
      if (url.pathname === "/api/event") return new Response(": connected\n\n", { headers: { "content-type": "text/event-stream" } })
      return json({ error: "not found" }, 404)
    },
  })
}

function internals(instance: Conversation) {
  return instance as unknown as {
    ctx: { id: { toString(): string } }
    transport?: (port: number) => { fetch(input: Request | string | URL): Promise<Response> }
  }
}

async function clearSettings(): Promise<void> {
  await runInDurableObject(settings(), async (_instance, state) => state.storage.deleteAll())
}

async function setup(key: string, options: { waitStatus?: number; generation?: string; calls?: string[]; unknownContext?: boolean; priorOnly?: boolean; toolContinuation?: boolean; compaction?: boolean; pastTurn?: boolean; firstTurn?: boolean; missingBaseline?: boolean } = {}) {
  const stub = env.CONVERSATION.getByName(key)
  return runInDurableObject(stub, async (instance, storage) => {
    await storage.storage.deleteAll()
    const conversationID = internals(instance).ctx.id.toString()
    const reservationID = `reservation-${key}`
    const hold = await settings().fetch("https://settings/usage/reserve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationID, reservationID, costUSD: 0.1 }),
    })
    expect(hold.ok).toBe(true)
    const reserved = await hold.json() as { date: string }
    await storage.storage.put("state", {
      sessionID,
      phase: "running",
      runStartedAt: Date.now() - (options.pastTurn ? 24 * 60 * 60_000 : 0) - 10_000,
      turnBaseline: options.missingBaseline || options.firstTurn ? undefined : "baseline-operator",
      budgetReservation: { reservationID, date: reserved.date, dispatched: true },
      seen: [], pending: {},
    } satisfies ConversationState)
    internals(instance).transport = fakeContainer(options)
    return { conversationID, reservationID, date: reserved.date }
  })
}

async function call(path: string, init: RequestInit = {}) {
  return SELF.fetch(`https://harness.test${path}`, { ...init, headers: { ...API, ...init.headers } })
}

function path(key: string, query: string) {
  return `/api/conversations/${encodeURIComponent(key)}/accounting/reconciliation${query}`
}

describe("operator reconciliation control plane", () => {
  beforeEach(clearSettings)

  it("requires API auth and validates the preview kind without touching central holds", async () => {
    const key = "C1:operator-auth"
    const seeded = await setup(key)
    expect((await SELF.fetch(`https://harness.test${path(key, "?kind=observed_actual")}`)).status).toBe(401)
    expect((await call(path(key, "?kind=estimate"))).status).toBe(400)
    const ledger = await (await settings().fetch(`https://settings/usage/cutover?conversationID=${encodeURIComponent(seeded.conversationID)}&reservationID=${seeded.reservationID}`)).json() as { holds: unknown[] }
    expect(ledger.holds).toHaveLength(1)
  })

  it("previews exact settled actuals and commits once, preserving receipt on retry", async () => {
    const key = "C1:operator-observed-control"
    const calls: string[] = []
    const seeded = await setup(key, { calls })
    const previewResponse = await call(path(key, "?kind=observed_actual"))
    expect(previewResponse.status, await previewResponse.clone().text()).toBe(200)
    const preview = await previewResponse.json() as {
      canApply: boolean
      proposal: Record<string, unknown>
      evidence: Record<string, unknown>
      accounting: Record<string, unknown>
    }
    expect(preview).toMatchObject({ canApply: true, evidence: { assistantMessageID: "assistant-operator", usageDate: seeded.date } })
    expect(preview.proposal).toMatchObject({
      conversationID: seeded.conversationID, sessionID, reservationID: seeded.reservationID,
      originDate: seeded.date, usageDate: seeded.date, kind: "observed_actual",
      actualCostUSD: 0.0017703, input: 5885, output: 4, assistantMessageID: "assistant-operator",
    })
    expect(preview.accounting).toMatchObject({
      reservationUSD: 0.1,
      historicalOriginDateAttribution: { beforeUSD: 0.1, afterUSD: 0.0017703 },
      currentBudget: { reportedSpendBeforeUSD: 0, reportedSpendAfterUSD: 0.0017703, reservedBeforeUSD: 0.1, reservedAfterUSD: 0 },
    })
    expect(JSON.stringify(preview)).not.toContain("private prompt")
    expect(calls.some((entry) => entry.includes("/prompt"))).toBe(false)

    const proposal = {
      ...preview.proposal,
      operator: "reviewer@example.test",
      approvalReference: "approved-case-17",
    }
    const first = await call(path(key, ""), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(proposal) })
    expect(first.status).toBe(200)
    const applied = await first.json() as { ok: boolean; localCleared: boolean; receipt: { receiptID: string } }
    expect(applied).toMatchObject({ ok: true, localCleared: true })
    const after = await runInDurableObject(env.CONVERSATION.getByName(key), async (instance, storage) => ({
      state: await storage.storage.get<ConversationState>("state"),
      inner: await instance.fetch(new Request("https://conversation/recovery")),
    }))
    expect(after.state?.budgetReservation).toBeUndefined()
    expect(after.state?.phase).toBe("idle")
    expect(after.state?.operatorReconciliation).toMatchObject({ receiptID: applied.receipt.receiptID, kind: "observed_actual" })

    const newerReservationID = "newer-reservation-after-reconciliation"
    const newerHold = await settings().fetch("https://settings/usage/reserve", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationID: seeded.conversationID, reservationID: newerReservationID, costUSD: 0.1 }),
    })
    expect(newerHold.ok).toBe(true)
    const newerDate = (await newerHold.json() as { date: string }).date
    await runInDurableObject(env.CONVERSATION.getByName(key), async (_instance, storage) => {
      await storage.storage.put("state", {
        ...(await storage.storage.get<ConversationState>("state")),
        budgetReservation: { reservationID: newerReservationID, date: newerDate, dispatched: true },
      })
    })
    const retry = await call(path(key, ""), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(proposal) })
    expect(retry.status).toBe(409)
    const retainedNewOwner = await runInDurableObject(env.CONVERSATION.getByName(key), async (_instance, storage) => storage.storage.get<ConversationState>("state"))
    expect(retainedNewOwner?.budgetReservation).toMatchObject({ reservationID: newerReservationID, date: newerDate })
    await runInDurableObject(env.CONVERSATION.getByName(key), async (_instance, storage) => {
      await storage.storage.put("state", { ...(await storage.storage.get<ConversationState>("state")), budgetReservation: undefined })
    })
    const replay = await call(path(key, ""), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(proposal) })
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ ok: true, replayed: true, localCleared: false })
    const ledger = await (await settings().fetch(`https://settings/usage/cutover?conversationID=${encodeURIComponent(seeded.conversationID)}&reservationID=${seeded.reservationID}`)).json() as { retirement?: { operatorReceiptID?: string } }
    expect(ledger.retirement?.operatorReceiptID).toBe(applied.receipt.receiptID)
  })

  it("keeps unknown previews null and refuses when native wait cannot be verified", async () => {
    const key = "C1:operator-unknown-control"
    const seeded = await setup(key, { waitStatus: 503 })
    const failed = await call(path(key, "?kind=acknowledged_unknown"))
    expect(failed.status).toBe(409)
    const stateAfterFailure = await runInDurableObject(env.CONVERSATION.getByName(key), async (_instance, storage) => storage.storage.get<ConversationState>("state"))
    expect(stateAfterFailure?.budgetReservation).toMatchObject({ reservationID: seeded.reservationID, dispatched: true })

    const retryKey = "C1:operator-unknown-preview"
    const retrySeed = await setup(retryKey, { unknownContext: true })
    const preview = await (await call(path(retryKey, "?kind=acknowledged_unknown"))).json() as { proposal: Record<string, unknown>; accounting: Record<string, unknown> }
    expect(preview.proposal).toMatchObject({ kind: "acknowledged_unknown", usageDate: null, actualCostUSD: null, input: null, output: null })
    expect(preview.proposal).not.toHaveProperty("assistantMessageID")
    expect(preview.accounting).toMatchObject({ reservationUSD: 0.1, currentBudget: { reservedBeforeUSD: 0.2, reservedAfterUSD: 0.1 } })
    const before = await settings().fetch(`https://settings/usage/cutover?conversationID=${encodeURIComponent(retrySeed.conversationID)}&reservationID=${retrySeed.reservationID}`)
    expect(((await before.json()) as { holds: unknown[] }).holds).toHaveLength(1)

    const proposal = { ...preview.proposal, operator: "reviewer@example.test", approvalReference: "unknown-approved-1", acceptUnknownRisk: true }
    const applied = await call(path(retryKey, ""), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(proposal) })
    expect(applied.status).toBe(200)
    expect(await applied.json()).toMatchObject({ ok: true, localCleared: true, receipt: { kind: "acknowledged_unknown", actualCostUSD: null } })
    const recovery = await (await SELF.fetch(`https://harness.test/api/conversations/${encodeURIComponent(retryKey)}/recovery`, { headers: API })).json() as {
      local: { historicalUsageUnreconciled: boolean; operatorReconciliation: { kind: string; actualCostUSD: number | null } }
    }
    expect(recovery.local).toMatchObject({ historicalUsageUnreconciled: true, operatorReconciliation: { kind: "acknowledged_unknown", actualCostUSD: null } })
    const usageToday = await (await call("/api/usage")).json() as Record<string, unknown>
    expect(usageToday).toMatchObject({ historicalUsageUnreconciled: true, unknownReconciliationCount: 1 })
  })

  it.each([
    ["multi-step assistant usage", { toolContinuation: true }],
    ["compaction usage", { compaction: true }],
    ["prior-turn-only context", { priorOnly: true }],
    ["missing turn baseline", { missingBaseline: true }],
  ] as const)("blocks observed import for %s without touching the hold", async (label, options) => {
    const key = `C1:operator-ambiguous-${label.replaceAll(" ", "-")}`
    const seeded = await setup(key, options)
    const response = await call(path(key, "?kind=observed_actual"))
    expect(response.status).toBe(409)
    const state = await runInDurableObject(env.CONVERSATION.getByName(key), async (_instance, storage) => storage.storage.get<ConversationState>("state"))
    expect(state?.budgetReservation).toMatchObject({ reservationID: seeded.reservationID, dispatched: true })
    const ledger = await settings().fetch(`https://settings/usage/cutover?conversationID=${encodeURIComponent(seeded.conversationID)}&reservationID=${seeded.reservationID}`)
    expect(((await ledger.json()) as { holds: unknown[] }).holds).toHaveLength(1)
  })

  it("labels first-turn actual attribution as context-and-timing evidence", async () => {
    const key = "C1:operator-first-turn"
    const seeded = await setup(key, { firstTurn: true })
    const response = await call(path(key, "?kind=observed_actual"))
    expect(response.status).toBe(200)
    const preview = await response.json() as { proposal: Record<string, unknown>; evidence: Record<string, unknown> }
    expect(preview.proposal).toMatchObject({ kind: "observed_actual", assistantMessageID: "assistant-operator" })
    expect(preview.evidence).toMatchObject({
      source: "first_turn_context_and_timing",
      attributionLimit: expect.stringContaining("no prompt ID proves exclusivity"),
    })
    expect(preview.proposal).toMatchObject({ conversationID: seeded.conversationID })
  })

  it("subtracts a past-origin reservation from current reserved funds without changing today's actual spend", async () => {
    const key = "C1:operator-past-origin"
    const seeded = await setup(key, { pastTurn: true })
    const yesterday = new Date(Date.now() - 24 * 60 * 60_000).toISOString().slice(0, 10)
    const today = new Date().toISOString().slice(0, 10)
    await runInDurableObject(settings(), async (_instance, runtime) => {
      const hold = await runtime.storage.get<Record<string, unknown>>(`reservation:${seeded.conversationID}`)
      await runtime.storage.put(`reservation:${seeded.conversationID}`, { ...hold, date: yesterday })
    })
    await runInDurableObject(env.CONVERSATION.getByName(key), async (_instance, runtime) => {
      const state = await runtime.storage.get<ConversationState>("state")
      await runtime.storage.put("state", {
        ...state,
        budgetReservation: { ...state?.budgetReservation, date: yesterday },
      })
    })
    const unrelated = await settings().fetch("https://settings/usage/reserve", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationID: "unrelated-current-reservation", reservationID: "unrelated-today", costUSD: 0.1 }),
    })
    expect(unrelated.ok).toBe(true)
    const response = await call(path(key, "?kind=observed_actual"))
    expect(response.status).toBe(200)
    const preview = await response.json() as { proposal: Record<string, unknown>; accounting: Record<string, any> }
    expect(preview.proposal).toMatchObject({ originDate: yesterday, usageDate: yesterday })
    expect(preview.accounting.currentBudget).toMatchObject({
      date: today, reportedSpendBeforeUSD: 0, reportedSpendAfterUSD: 0,
      reservedBeforeUSD: 0.2, reservedAfterUSD: 0.1,
    })
  })

  it("rejects queued or stale proposals without changing a hold", async () => {
    const key = "C1:operator-queued"
    const seeded = await setup(key)
    await runInDurableObject(env.CONVERSATION.getByName(key), async (_instance, storage) => {
      await storage.storage.put("state", {
        ...(await storage.storage.get<ConversationState>("state")),
        queued: { text: "later", attempts: 0 },
      })
    })
    const blocked = await call(path(key, "?kind=observed_actual"))
    expect(blocked.status).toBe(409)
    const state = await runInDurableObject(env.CONVERSATION.getByName(key), async (_instance, storage) => storage.storage.get<ConversationState>("state"))
    expect(state?.budgetReservation).toMatchObject({ reservationID: seeded.reservationID, dispatched: true })
    expect(state?.queued?.text).toBe("later")
  })

  it("rejects a stale reviewed local snapshot without retiring the central hold", async () => {
    const key = "C1:operator-stale-review"
    const seeded = await setup(key)
    const preview = await (await call(path(key, "?kind=observed_actual"))).json() as { proposal: Record<string, unknown> }
    await runInDurableObject(env.CONVERSATION.getByName(key), async (_instance, storage) => {
      await storage.storage.put("state", {
        ...(await storage.storage.get<ConversationState>("state")),
        settlementError: "changed after preview",
      })
    })
    const stale = await call(path(key, ""), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...preview.proposal, operator: "reviewer@example.test", approvalReference: "stale-review" }),
    })
    expect(stale.status).toBe(409)
    const local = await runInDurableObject(env.CONVERSATION.getByName(key), async (_instance, storage) => storage.storage.get<ConversationState>("state"))
    expect(local?.budgetReservation).toMatchObject({ reservationID: seeded.reservationID, dispatched: true })
    const central = await (await settings().fetch(`https://settings/usage/cutover?conversationID=${encodeURIComponent(seeded.conversationID)}&reservationID=${seeded.reservationID}`)).json() as { holds: unknown[] }
    expect(central.holds).toHaveLength(1)
  })
})
