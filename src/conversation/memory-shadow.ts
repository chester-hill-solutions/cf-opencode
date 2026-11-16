import { memoryCandidateRequest, memoryVerdict, rulesDecision, systemOneDecision, type DecisionPort } from "../decision"

/**
 * Shadow memory review: decide, after a turn, whether that turn would have been
 * worth remembering — and record the decision instead of acting on it. Nothing
 * here writes memory, starts a runtime, or touches the turn: the review runs
 * after settlement and its failure is invisible to the conversation.
 */

export const MEMORY_SHADOW_KEY = "memoryShadow"
export const MEMORY_SHADOW_LIMIT = 20

export interface MemoryShadowRecord {
  at: number
  /** Which provider answered: the configured model, or the offline rules baseline. */
  source: "model" | "rules"
  decision: "accept" | "reject" | "absent"
  probability?: number
  scope?: string
  scopeConfidence?: number
  model?: string
  inputTokens?: number
  latencyMs: number
  /** Present when the model failed and the rules baseline answered instead. */
  error?: string
}

export interface MemoryShadowOptions {
  storage: DurableObjectStorage
  /** The configured decision provider, or undefined when none is configured. */
  model(): DecisionPort | undefined
  rules(): DecisionPort
  now?(): number
}

export class ConversationMemoryShadow {
  constructor(private readonly options: MemoryShadowOptions) {}

  /** Review one settled turn. A no-op without a configured provider. */
  async review(turn: { user: string; assistant: string }): Promise<void> {
    const model = this.options.model()
    if (!model) return
    const started = this.now()
    let record: MemoryShadowRecord
    try {
      record = await this.measure("model", model, turn, started)
    } catch (error) {
      // Fall back to the offline baseline, but keep the failure on the record so
      // a quiet provider problem cannot look like a working filter.
      const reason = error instanceof Error ? error.message : String(error)
      record = { ...await this.measure("rules", this.options.rules(), turn, started), error: reason }
    }
    await this.append(record)
  }

  async list(): Promise<MemoryShadowRecord[]> {
    const stored = await this.options.storage.get<MemoryShadowRecord[]>(MEMORY_SHADOW_KEY).catch(() => undefined)
    return Array.isArray(stored) ? stored : []
  }

  private async measure(
    source: MemoryShadowRecord["source"],
    port: DecisionPort,
    turn: { user: string; assistant: string },
    started: number,
  ): Promise<MemoryShadowRecord> {
    const result = await port.decide(memoryCandidateRequest(turn))
    const verdict = memoryVerdict(result)
    return {
      at: started,
      source,
      decision: verdict.decision,
      ...(verdict.probability === undefined ? {} : { probability: verdict.probability }),
      ...(verdict.scope === undefined ? {} : { scope: verdict.scope }),
      ...(verdict.scopeConfidence === undefined ? {} : { scopeConfidence: verdict.scopeConfidence }),
      ...(result.model === undefined ? {} : { model: result.model }),
      ...(result.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }),
      latencyMs: this.now() - started,
    }
  }

  /** Newest first, bounded so evidence cannot grow the conversation state forever. */
  private async append(record: MemoryShadowRecord): Promise<void> {
    const existing = await this.list()
    await this.options.storage.put(MEMORY_SHADOW_KEY, [record, ...existing].slice(0, MEMORY_SHADOW_LIMIT)).catch(() => {})
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}

/** Build the shadow from deployment configuration; no provider means no review. */
export function memoryShadowFor(
  storage: DurableObjectStorage,
  env: { DECISION_URL?: string; DECISION_API_KEY?: string; DECISION_MODEL?: string },
): ConversationMemoryShadow {
  return new ConversationMemoryShadow({
    storage,
    // Built per call so a settings-driven restart or a test override is honoured.
    model: () => {
      const url = env.DECISION_URL
      const apiKey = env.DECISION_API_KEY
      if (!url || !apiKey) return undefined
      return systemOneDecision({ url, apiKey, model: env.DECISION_MODEL ?? "jev-1.13" })
    },
    rules: () => rulesDecision(),
  })
}

