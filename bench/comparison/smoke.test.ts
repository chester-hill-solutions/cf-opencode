import { describe, expect, test } from "bun:test"
import { allowedSmokeAttempt, normalizeSmokeBody, smokeAdmissionAllowed, type SmokeCall } from "./baseline/smoke-contract"
import { FROZEN_PROTOCOL_SHA256 } from "./baseline/freeze.generated"
import { SMOKE_SCOPE } from "./baseline/smoke-scope"
import { taskAttemptID } from "./baseline/task-request"

const baseline = (task = "L1", condition: "cold" | "warm" = "cold", repetition = 1) => taskAttemptID(task, condition, repetition, FROZEN_PROTOCOL_SHA256)
const complete = (attemptID = baseline(), estimatedUSD = 0): SmokeCall => ({ attemptID, status: "complete", inputTokens: 0, outputTokens: 0, estimatedUSD })
const message = () => ({ role: "user", content: "Repair the frozen fixture." })
const request = () => ({ model: SMOKE_SCOPE.model, stream: true, messages: [message()] })

describe("fixed smoke provider contract", () => {
  test("normalizes both arms to the same paid model, generation bounds and usage stream", () => {
    const input = { ...request(), max_tokens: 999999, temperature: 2, stream_options: { include_usage: false }, tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }], tool_choice: "auto", parallel_tool_calls: false }
    const body = normalizeSmokeBody(input)
    expect(body.model).toBe(SMOKE_SCOPE.model); expect(body.stream).toBe(true)
    expect(body.max_tokens).toBe(4096); expect(body.temperature).toBe(0); expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.tools).toEqual(input.tools); expect(body.tool_choice).toBe("auto"); expect(body.parallel_tool_calls).toBe(false)
    input.messages[0]!.content = "mutated"; input.tools[0]!.function.name = "changed"
    expect(body.messages).toEqual([message()]); expect(body.tools).toEqual([{ type: "function", function: { name: "read", parameters: { type: "object" } } }])
  })

  test("rejects substitutions, aliases, priority tiers and unsupported generation controls", () => {
    for (const input of [
      { ...request(), model: "expensive-other-model" }, { ...request(), model: SMOKE_SCOPE.canonicalModel },
      { ...request(), service_tier: "priority" }, { ...request(), priority: "high" },
      { ...request(), top_p: 0.1 },
      { ...request(), stream: false }, { ...request(), stream: "true" },
    ]) expect(() => normalizeSmokeBody(input)).toThrow()
  })

  test("native OpenAI max_completion_tokens normalizes to the identical fixed upstream bound",()=>{
    const native={...request(),max_completion_tokens:999999,temperature:2,stream_options:{include_usage:true},tools:[]}
    const baseline={...request(),max_tokens:17,temperature:0,stream_options:{include_usage:false},tools:[]}
    expect(normalizeSmokeBody(native)).toEqual(normalizeSmokeBody(baseline))
    expect(normalizeSmokeBody(native).max_tokens).toBe(SMOKE_SCOPE.maxOutputTokens)
    expect(normalizeSmokeBody(native)).not.toHaveProperty("max_completion_tokens")
  })

  test("rejects malformed bodies before admitting a paid request", () => {
    for (const input of [null, [], "text", {}, { ...request(), messages: [] }, { ...request(), messages: [null] },
      { ...request(), messages: [{ role: "unknown", content: "text" }] }, { ...request(), messages: [{ role: "user", content: 4 }] },
      { ...request(), tools: {} }, { ...request(), tools: [{ type: "web_search" }] },
      { ...request(), tool_choice: { type: "function", function: {} } }, { ...request(), parallel_tool_calls: "false" },
      { ...request(), messages: [{ role: "user", content: "text", invalid: NaN }] },
    ]) expect(() => normalizeSmokeBody(input)).toThrow()
  })

  test("preserves ordinary assistant tool calls and tool results", () => {
    const messages = [message(), { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: '{"path":"src/index.ts"}' } }] }, { role: "tool", tool_call_id: "call-1", content: "source" }]
    expect(normalizeSmokeBody({ ...request(), messages, tool_choice: { type: "function", function: { name: "read" } } }).messages).toEqual(messages)
  })
})

describe("shared smoke admission", () => {
  test("allows only the four frozen cold repetition-one cells", () => {
    for (const task of ["L1", "Q1"]) for (const id of [baseline(task), "aboiteau-" + baseline(task)]) {
      expect(allowedSmokeAttempt(id)).toBe(true); expect(smokeAdmissionAllowed([], id)).toBe(true)
    }
    for (const id of [baseline("L2"), baseline("L1", "warm"), baseline("L1", "cold", 2), "alias-" + baseline(), "aboiteau-aboiteau-" + baseline(), baseline() + "-retry", taskAttemptID("L1", "cold", 1, "0".repeat(64))]) {
      expect(allowedSmokeAttempt(id)).toBe(false); expect(smokeAdmissionAllowed([], id)).toBe(false)
    }
  })

  test("pending or unknown work blocks both arms, including unknown or invalid costs", () => {
    for (const call of [
      { ...complete(), status: "pending" as const }, { ...complete(), status: "unknown" as const },
      { ...complete(), estimatedUSD: null }, { ...complete(), estimatedUSD: NaN }, { ...complete(), estimatedUSD: Infinity }, { ...complete(), estimatedUSD: -1 },
      { ...complete(), inputTokens: null }, { ...complete(), outputTokens: null }, { ...complete(), inputTokens: -1 }, { ...complete(), outputTokens: 1.5 },
      { ...complete(), attemptID: "unrecognized-attempt" },
    ]) {
      expect(smokeAdmissionAllowed([call], baseline())).toBe(false)
      expect(smokeAdmissionAllowed([call], "aboiteau-" + baseline("Q1"))).toBe(false)
    }
  })

  test("enforces per-attempt and total call limits across both arms", () => {
    const rows = Array.from({ length: 15 }, () => complete())
    expect(smokeAdmissionAllowed(rows, baseline())).toBe(true)
    rows.push(complete())
    expect(smokeAdmissionAllowed(rows, baseline())).toBe(false)
    expect(smokeAdmissionAllowed(rows, "aboiteau-" + baseline())).toBe(true)
    const all = [baseline(), baseline("Q1"), "aboiteau-" + baseline(), "aboiteau-" + baseline("Q1")].flatMap(id => Array.from({ length: 16 }, () => complete(id)))
    expect(all).toHaveLength(64); expect(smokeAdmissionAllowed(all, baseline())).toBe(false)
    expect(smokeAdmissionAllowed(Array.from({ length: 17 }, () => complete()), baseline("Q1"))).toBe(false)
  })

  test("preserves the quarter-dollar reserve and never understates token-derived cost", () => {
    const limit=SMOKE_SCOPE.providerBudgetUSD-0.25
    expect(smokeAdmissionAllowed([complete(baseline(), limit-0.001)], baseline("Q1"))).toBe(true)
    expect(smokeAdmissionAllowed([complete(baseline(), limit)], baseline("Q1"))).toBe(false)
    expect(smokeAdmissionAllowed([complete(baseline(), 2), complete("aboiteau-" + baseline(), limit-2)], baseline("Q1"))).toBe(false)
    const understated = { ...complete(), inputTokens: 20_000_000, estimatedUSD: 0 }
    expect(smokeAdmissionAllowed([understated], baseline("Q1"))).toBe(false)
    expect(smokeAdmissionAllowed([complete()], baseline("Q1"))).toBe(true)
  })
})
