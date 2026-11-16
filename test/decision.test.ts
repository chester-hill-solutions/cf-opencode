import { describe, expect, it } from "vitest"
import {
  DecisionUnavailable,
  MEMORY_QUESTION,
  MEMORY_SCOPE_QUESTION,
  MEMORY_THRESHOLD,
  memoryCandidateRequest,
  memoryVerdict,
  parseSystemOne,
  rulesDecision,
  systemOneDecision,
} from "../src/decision"

function stubFetch(response: Response | (() => Promise<Response>)) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) })
    return typeof response === "function" ? response() : response
  }) as typeof fetch
  return { calls, fetch: fn }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
})

describe("System One decision adapter", () => {
  it("posts typed questions to the configured endpoint and parses both answer kinds", async () => {
    const stub = stubFetch(json({
      model: "jev-1.13",
      usage: { input_tokens: 812, output_tokens: 0 },
      answers: {
        [MEMORY_QUESTION]: { noul: 0.94 },
        [MEMORY_SCOPE_QUESTION]: {
          choice: "team",
          confidence: 0.5,
          probabilities: { user: 0.3, team: 0.6, neither: 0.1 },
        },
      },
    }))
    const port = systemOneDecision({
      url: "https://decision.test/v1/systemone", apiKey: "key-not-logged", model: "jev-1.13", fetch: stub.fetch,
    })
    const result = await port.decide(memoryCandidateRequest({ user: "we use bun here", assistant: "noted" }))

    expect(stub.calls).toHaveLength(1)
    const [call] = stub.calls
    expect(call?.url).toBe("https://decision.test/v1/systemone")
    expect(call?.init?.method).toBe("POST")
    expect((call?.init?.headers as Record<string, string>).authorization).toBe("Bearer key-not-logged")
    const body = JSON.parse(String(call?.init?.body)) as { model: string; state: unknown; questions: unknown }
    expect(body.model).toBe("jev-1.13")
    expect(body.state).toMatchObject({ user: "we use bun here", assistant: "noted" })
    expect(Object.keys(body.questions as Record<string, unknown>)).toEqual([MEMORY_QUESTION, MEMORY_SCOPE_QUESTION])

    expect(result.model).toBe("jev-1.13")
    expect(result.inputTokens).toBe(812)
    expect(result.answers[MEMORY_QUESTION]).toEqual({ type: "noul", probability: 0.94 })
    expect(result.answers[MEMORY_SCOPE_QUESTION]).toMatchObject({ type: "choice", choice: "team", confidence: 0.5 })
  })

  it("refuses instead of guessing when the provider fails", async () => {
    const port = systemOneDecision({
      url: "https://decision.test/v1/systemone", apiKey: "k", model: "jev-1.13",
      fetch: stubFetch(json({ error: "overloaded" }, 529)).fetch,
    })
    await expect(port.decide(memoryCandidateRequest({ user: "a", assistant: "b" })))
      .rejects.toBeInstanceOf(DecisionUnavailable)
  })

  it("refuses when the transport throws or the body is unreadable", async () => {
    const offline = systemOneDecision({
      url: "https://decision.test/v1/systemone", apiKey: "k", model: "jev-1.13",
      fetch: stubFetch(async () => { throw new Error("connection reset") }).fetch,
    })
    await expect(offline.decide(memoryCandidateRequest({ user: "a", assistant: "b" })))
      .rejects.toThrow(/connection reset/)

    const html = systemOneDecision({
      url: "https://decision.test/v1/systemone", apiKey: "k", model: "jev-1.13",
      fetch: stubFetch(new Response("<html>", { status: 200 })).fetch,
    })
    await expect(html.decide(memoryCandidateRequest({ user: "a", assistant: "b" })))
      .rejects.toBeInstanceOf(DecisionUnavailable)
  })
})

describe("decision answer validation", () => {
  it("treats unknown, missing and out-of-range answers as absent or clamped", () => {
    const parsed = parseSystemOne({
      model: "jev-1.13",
      answers: {
        unknown: { refusal: { message: "no" } },
        partial: { noul: "yes" },
        high: { noul: 1.7 },
        low: { noul: -0.2 },
        noChoice: { confidence: 0.9 },
      },
    })
    expect(parsed.answers.unknown).toBeUndefined()
    expect(parsed.answers.partial).toBeUndefined()
    expect(parsed.answers.noChoice).toBeUndefined()
    expect(parsed.answers.high).toEqual({ type: "noul", probability: 1 })
    expect(parsed.answers.low).toEqual({ type: "noul", probability: 0 })
  })

  it("rejects a body that is not an object", () => {
    expect(() => parseSystemOne([])).toThrow(DecisionUnavailable)
    expect(() => parseSystemOne("answers")).toThrow(DecisionUnavailable)
  })
})

describe("memory verdict", () => {
  const answer = (probability: number, scope?: string) => ({
    answers: {
      [MEMORY_QUESTION]: { type: "noul" as const, probability },
      ...(scope ? { [MEMORY_SCOPE_QUESTION]: { type: "choice" as const, choice: scope, confidence: 0.4, probabilities: {} } } : {}),
    },
  })

  it("accepts only at or above the policy threshold", () => {
    expect(memoryVerdict(answer(MEMORY_THRESHOLD)).decision).toBe("accept")
    expect(memoryVerdict(answer(MEMORY_THRESHOLD - 0.01)).decision).toBe("reject")
    expect(memoryVerdict({ answers: {} }).decision).toBe("absent")
  })

  it("carries the scope when the provider answered it", () => {
    expect(memoryVerdict(answer(0.99, "team"))).toMatchObject({ decision: "accept", scope: "team" })
    expect(memoryVerdict(answer(0.99))).not.toHaveProperty("scope")
  })
})

describe("rules baseline", () => {
  const run = async (user: string) => rulesDecision().decide(memoryCandidateRequest({ user, assistant: "ok" }))

  it("answers only explicit memory markers, and never invents a scope", async () => {
    const marked = await run("remember that we use bun, never npm")
    expect(marked.answers[MEMORY_QUESTION]).toEqual({ type: "noul", probability: 1 })
    expect(marked.answers[MEMORY_SCOPE_QUESTION]).toBeUndefined()

    const plain = await run("what time is the standup?")
    expect(plain.answers[MEMORY_QUESTION]).toEqual({ type: "noul", probability: 0 })
  })
})
