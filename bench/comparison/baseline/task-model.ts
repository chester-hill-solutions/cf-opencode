import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { TaskJournal } from "./journal"

export type ModelConfig = {
  model: string
  baseURL: string
  temperature: number
  maxOutputTokens: number
  contextTokens: number
  maxModelCalls: number
  requestTimeoutMs: number
}
type SDKFetch = NonNullable<Parameters<typeof createOpenAICompatible>[0]["fetch"]>
export type ProviderTransport = (...args: Parameters<SDKFetch>) => ReturnType<SDKFetch>

export function parseModelConfig(value: unknown): ModelConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("model configuration required")
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(",") !== "baseURL,contextTokens,maxModelCalls,maxOutputTokens,model,requestTimeoutMs,temperature") throw new Error("unsupported model setting")
  if (typeof row.model !== "string" || !/^[\w./:@-]{1,200}$/.test(row.model) || typeof row.baseURL !== "string") throw new Error("invalid model route")
  const url = new URL(row.baseURL)
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("provider route requires credential-free HTTPS URL")
  for (const key of ["maxOutputTokens", "contextTokens", "maxModelCalls", "requestTimeoutMs"] as const) if (!Number.isSafeInteger(row[key]) || Number(row[key]) < 1) throw new Error("invalid model bound: " + key)
  if (Number(row.contextTokens) > 1_000_000 || Number(row.maxOutputTokens) > Number(row.contextTokens) || Number(row.maxModelCalls) > 64) throw new Error("model bound exceeds benchmark limit")
  if (Number(row.requestTimeoutMs) > 900_000) throw new Error("invalid request timeout")
  if (typeof row.temperature !== "number" || !Number.isFinite(row.temperature) || row.temperature < 0 || row.temperature > 2) throw new Error("explicit temperature required")
  return { model: row.model, baseURL: url.href.replace(/\/$/, ""), temperature: row.temperature,
    maxOutputTokens: Number(row.maxOutputTokens), contextTokens: Number(row.contextTokens), maxModelCalls: Number(row.maxModelCalls), requestTimeoutMs: Number(row.requestTimeoutMs) }
}

/** Credentials live only in the coordinator. All prices remain unknown. */
export function taskModel(config: ModelConfig, key: string, journal: TaskJournal, ensureWorkspace: () => Promise<void>, transport: ProviderTransport = fetch, lifetime?: AbortSignal): LanguageModelV3 {
  if (!key || /[\r\n]/.test(key)) throw new Error("provider credential required")
  const endpoint = config.baseURL + "/chat/completions"
  const provider = createOpenAICompatible({ name: "r0-23-provider", baseURL: config.baseURL, apiKey: key,
    fetch: Object.assign(async (...[input, init]: Parameters<ProviderTransport>) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url !== endpoint || init?.method !== "POST") throw new Error("provider destination refused")
      const timeout = AbortSignal.timeout(config.requestTimeoutMs)
      const response = await transport(input, { ...init, redirect: "manual", signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout })
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => {})
        throw new Error("provider redirect refused")
      }
      let bytes = 0
      const body = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
        bytes += chunk.byteLength
        if (bytes > 8_388_608) throw new Error("provider response exceeds byte limit")
        controller.enqueue(chunk)
      } }))
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    }, { preconnect: fetch.preconnect }) })
  const model = provider.chatModel(config.model)
  return {
    specificationVersion: "v3", provider: model.provider, modelId: model.modelId, supportedUrls: {},
    async doGenerate() { throw new Error("benchmark adapter requires streaming") },
    async doStream(options) {
      const signals = [options.abortSignal, lifetime].filter((value): value is AbortSignal => Boolean(value))
      const signal = AbortSignal.any(signals)
      signal.throwIfAborted()
      await ensureWorkspace()
      signal.throwIfAborted()
      const id = await journal.beginModel(config.maxModelCalls)
      try {
        signal.throwIfAborted()
        const response = await model.doStream({ ...options, abortSignal: signal, temperature: config.temperature, maxOutputTokens: config.maxOutputTokens })
        let streamError = false
        return { ...response, stream: response.stream.pipeThrough(new TransformStream({
          async transform(part, controller) {
            if (part.type === "error") streamError = true
            if (part.type === "finish" && !streamError && !["error", "unknown"].includes(part.finishReason.unified)) await journal.finishModel(id, part.usage.inputTokens.total, part.usage.outputTokens.total)
            // Provider errors can contain response bodies; avoid recording credential echoes.
            controller.enqueue(part.type === "error" ? { type: "error", error: new Error("provider stream failed; usage may be unknown") } : part)
          },
        })) }
      } catch { throw new Error("provider call failed; usage remains unknown") }
    },
  }
}
