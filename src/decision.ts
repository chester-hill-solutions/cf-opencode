/**
 * Provider-neutral decision port: typed questions in, typed answers out.
 *
 * A decision model is not a chat model asked nicely. It takes a state and named
 * typed questions (probability, choice, score) and returns labelled answers with
 * probabilities, so no prose is parsed and no JSON schema is negotiated. The
 * System One wire format is the one TypeSafe and the OpenCode Console speak; an
 * OpenAI Decisions adapter implements the same port when one is wired up.
 */

export type DecisionQuestion =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }

export type DecisionAnswer =
  | { type: "noul"; probability: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }

export interface DecisionRequest {
  state: string | Record<string, unknown>
  questions: Record<string, DecisionQuestion>
}

export interface DecisionResult {
  answers: Record<string, DecisionAnswer>
  model?: string
  inputTokens?: number
}

export interface DecisionPort {
  decide(request: DecisionRequest): Promise<DecisionResult>
}

/** The provider could not answer: refuse the decision, never guess one. */
export class DecisionUnavailable extends Error {}

export interface SystemOneConfig {
  /** Full endpoint, configuration-owned; no host is hardcoded here. */
  url: string
  apiKey: string
  model: string
  timeoutMs?: number
  fetch?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 5_000

export function systemOneDecision(config: SystemOneConfig): DecisionPort {
  const send = config.fetch ?? fetch
  return {
    async decide(request) {
      let response: Response
      try {
        response = await send(config.url, {
          method: "POST",
          headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: config.model, state: request.state, questions: request.questions }),
          signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        })
      } catch (error) {
        throw new DecisionUnavailable(`decision request failed: ${message(error)}`)
      }
      if (!response.ok) throw new DecisionUnavailable(`decision provider returned ${response.status}`)
      return parseSystemOne(await response.json().catch((error: unknown) => {
        throw new DecisionUnavailable(`decision response was unreadable: ${message(error)}`)
      }))
    },
  }
}

/** Validate the envelope; an unrecognised answer is absent, never interpreted. */
export function parseSystemOne(body: unknown): DecisionResult {
  if (!object(body)) throw new DecisionUnavailable("decision response was not an object")
  const usage = object(body.usage) ? body.usage : undefined
  const model = typeof body.model === "string" ? body.model : undefined
  const inputTokens = typeof usage?.input_tokens === "number" && Number.isFinite(usage.input_tokens) ? usage.input_tokens : undefined
  return {
    answers: parseAnswers(body.answers),
    ...(model ? { model } : {}),
    ...(inputTokens === undefined ? {} : { inputTokens }),
  }
}

function parseAnswers(raw: unknown): Record<string, DecisionAnswer> {
  const answers: Record<string, DecisionAnswer> = {}
  if (!object(raw)) return answers
  for (const [id, value] of Object.entries(raw)) {
    const answer = parseAnswer(value)
    if (answer) answers[id] = answer
  }
  return answers
}

function parseAnswer(raw: unknown): DecisionAnswer | undefined {
  if (!object(raw)) return undefined
  if (typeof raw.noul === "number" && Number.isFinite(raw.noul)) {
    return { type: "noul", probability: clamp01(raw.noul) }
  }
  if (typeof raw.choice !== "string") return undefined
  const confidence = typeof raw.confidence === "number" && Number.isFinite(raw.confidence) ? clamp01(raw.confidence) : 0
  return { type: "choice", choice: raw.choice, confidence, probabilities: parseProbabilities(raw.probabilities) }
}

function parseProbabilities(raw: unknown): Record<string, number> {
  const probabilities: Record<string, number> = {}
  if (!object(raw)) return probabilities
  for (const [value, probability] of Object.entries(raw)) {
    if (typeof probability === "number" && Number.isFinite(probability)) probabilities[value] = clamp01(probability)
  }
  return probabilities
}

/**
 * Offline baseline: explicit memory markers only. It answers the probability
 * question and leaves a choice question unanswered rather than inventing a scope.
 */
export function rulesDecision(): DecisionPort {
  return {
    async decide(request) {
      const text = typeof request.state === "string" ? request.state : JSON.stringify(request.state)
      const explicit = /\b(remember|don'?t forget|always|never|prefer|we use|convention)\b/i.test(text)
      const answers: Record<string, DecisionAnswer> = {}
      for (const [id, question] of Object.entries(request.questions)) {
        if (question.type === "noul") answers[id] = { type: "noul", probability: explicit ? 1 : 0 }
      }
      return { answers, model: "rules" }
    },
  }
}

export const MEMORY_QUESTION = "memory"
export const MEMORY_SCOPE_QUESTION = "scope"

/** The one question that decides whether a turn is worth remembering. */
export function memoryCandidateRequest(turn: { user: string; assistant: string }): DecisionRequest {
  return {
    state: { user: trim(turn.user), assistant: trim(turn.assistant) },
    questions: {
      [MEMORY_QUESTION]: {
        type: "noul",
        instructions: "Does the user's message state something durable that a future conversation should know about them, their team, or their environment?",
        criteria: {
          true: "A lasting preference, correction, convention, or fact about people, tools or projects that stays true after this turn and is useful weeks later.",
          false: "A question, a greeting, a request for this turn only, a one-off detail such as a path or an error message, or anything already implied by the conversation.",
        },
      },
      [MEMORY_SCOPE_QUESTION]: {
        type: "choice",
        instructions: "Who would a remembered version of that statement belong to?",
        criteria: {
          user: "A preference or fact about the person speaking.",
          team: "A convention, environment fact, or shared decision for everyone working here.",
          neither: "Nothing here is worth remembering.",
        },
      },
    },
  }
}

export type MemoryVerdict = {
  decision: "accept" | "reject" | "absent"
  probability?: number
  scope?: string
  scopeConfidence?: number
}

/** Anything below this is not written unattended; it is a policy, not the model's. */
export const MEMORY_THRESHOLD = 0.9

export function memoryVerdict(result: DecisionResult): MemoryVerdict {
  const answer = result.answers[MEMORY_QUESTION]
  if (answer?.type !== "noul") return { decision: "absent" }
  const scope = result.answers[MEMORY_SCOPE_QUESTION]
  return {
    decision: answer.probability >= MEMORY_THRESHOLD ? "accept" : "reject",
    probability: answer.probability,
    ...(scope?.type === "choice" ? { scope: scope.choice, scopeConfidence: scope.confidence } : {}),
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** Keep the evidence bounded: a decision sees the turn, not a transcript. */
function trim(text: string): string {
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
