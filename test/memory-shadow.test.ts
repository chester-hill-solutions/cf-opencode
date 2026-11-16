import { describe, expect, it } from "vitest"
import {
  MEMORY_SHADOW_KEY,
  MEMORY_SHADOW_LIMIT,
  ConversationMemoryShadow,
  memoryShadowFor,
  type MemoryShadowRecord,
} from "../src/conversation/memory-shadow"
import { DecisionUnavailable, rulesDecision, type DecisionPort } from "../src/decision"

function keyValueStorage(seed: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>(Object.entries(seed))
  return {
    map,
    async get<T>(key: string): Promise<T | undefined> { return map.get(key) as T | undefined },
    async put(key: string, value: unknown): Promise<void> { map.set(key, value) },
  } as unknown as DurableObjectStorage & { map: Map<string, unknown> }
}

const model = (probability: number): DecisionPort => ({
  async decide() {
    return { answers: { memory: { type: "noul", probability } }, model: "jev-1.13", inputTokens: 700 }
  },
})

const turn = { user: "we always deploy with --containers-rollout none", assistant: "noted" }

describe("memory shadow review", () => {
  it("records a provider verdict with probability, scope, tokens and latency", async () => {
    const storage = keyValueStorage()
    let clock = 1_000
    const shadow = new ConversationMemoryShadow({
      storage, model: () => model(0.97), rules: rulesDecision, now: () => (clock += 40),
    })
    await shadow.review(turn)
    const [record] = await shadow.list()
    expect(record).toMatchObject({
      source: "model", decision: "accept", probability: 0.97, model: "jev-1.13", inputTokens: 700,
    })
    expect(record?.latencyMs).toBeGreaterThan(0)
    expect(record).not.toHaveProperty("error")
  })

  it("falls back to the rules baseline and keeps the failure on the record", async () => {
    const storage = keyValueStorage()
    const broken: DecisionPort = { async decide() { throw new DecisionUnavailable("provider returned 529") } }
    const shadow = new ConversationMemoryShadow({
      storage,
      model: () => broken,
      rules: () => rulesDecision(),
      now: () => 2_000,
    })
    await shadow.review(turn)
    const [record] = await shadow.list()
    expect(record).toMatchObject({ source: "rules", error: "provider returned 529" })
    // The baseline answers the probability question only, so the verdict is its own.
    expect(record?.decision).toBe("accept")
    expect(record).not.toHaveProperty("scope")
  })

  it("does nothing without a configured provider", async () => {
    const storage = keyValueStorage()
    const shadow = new ConversationMemoryShadow({ storage, model: () => undefined, rules: rulesDecision })
    await shadow.review(turn)
    expect(storage.map.has(MEMORY_SHADOW_KEY)).toBe(false)
  })

  it("keeps the newest records and never exceeds the cap", async () => {
    const storage = keyValueStorage()
    let clock = 0
    const shadow = new ConversationMemoryShadow({
      storage, model: () => model(0.5), rules: rulesDecision, now: () => (clock += 1),
    })
    for (let i = 0; i < MEMORY_SHADOW_LIMIT + 5; i++) await shadow.review(turn)
    const records = await shadow.list()
    expect(records).toHaveLength(MEMORY_SHADOW_LIMIT)
    expect(records[0]?.at).toBeGreaterThan(records.at(-1)?.at ?? 0)
  })

  it("swallows a storage failure so settlement is never affected", async () => {
    const storage = {
      async get() { return [] },
      async put() { throw new Error("storage unavailable") },
    } as unknown as DurableObjectStorage
    const shadow = new ConversationMemoryShadow({ storage, model: () => model(0.99), rules: rulesDecision })
    await expect(shadow.review(turn)).resolves.toBeUndefined()
  })
})

describe("memory shadow configuration", () => {
  it("is inert without both a URL and a key", async () => {
    const storage = keyValueStorage()
    const shadow = memoryShadowFor(storage, { DECISION_URL: "https://decision.test/v1/systemone" })
    await shadow.review(turn)
    expect(storage.map.has(MEMORY_SHADOW_KEY)).toBe(false)
  })

  it("records through a configured endpoint", async () => {
    const storage = keyValueStorage()
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({
      model: "jev-1.13", answers: { memory: { noul: 0.2 } },
    }), { status: 200 })) as typeof fetch
    try {
      const shadow = memoryShadowFor(storage, {
        DECISION_URL: "https://decision.test/v1/systemone", DECISION_API_KEY: "k", DECISION_MODEL: "jev-1.13",
      })
      await shadow.review(turn)
    } finally {
      globalThis.fetch = original
    }
    const records = storage.map.get(MEMORY_SHADOW_KEY) as MemoryShadowRecord[]
    expect(records[0]).toMatchObject({ source: "model", decision: "reject", probability: 0.2 })
  })
})
