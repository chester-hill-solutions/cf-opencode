import { DurableObject, WorkerEntrypoint } from "cloudflare:workers"
import { bearerAuthorized, constantTimeEqual } from "../../../src/control-auth"
import { sha256 } from "./journal"
import { SMOKE_SCOPE } from "./smoke-scope"
import { allowedSmokeAttempt, normalizeSmokeBody, smokeAdmissionAllowed, type SmokeCall } from "./smoke-contract"
import { steps } from "./provider"

export type SmokeGrant = { attemptID: string; tokenSHA256: string; expiresAt: number }
const maxBody = 131_072

/** Trusted native HTTP intercept: the container sees only a scoped grant token. */
export class SmokeEgress extends WorkerEntrypoint<ComparisonBindings, SmokeGrant> {
  async fetch(request: Request): Promise<Response> {
    const scope = this.ctx.props
    if (request.url !== "http://provider.aboiteau/v1/chat/completions" || request.method !== "POST" ||
      !allowedSmokeAttempt(scope.attemptID) || Date.now() >= scope.expiresAt) return new Response("scope refused", { status: 403 })
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""
    if (!constantTimeEqual(await sha256(token), scope.tokenSHA256)) return new Response("grant refused", { status: 403 })
    return smokeTransport(this.env, scope.attemptID, request)
  }
}

export function smokeTransport(env: ComparisonBindings, attemptID: string, request: Request, namespace: Pick<ComparisonBindings["SMOKE_PROVIDER"], "getByName"> = env.SMOKE_PROVIDER): Promise<Response> {
  const headers = new Headers(request.headers)
  headers.set("authorization", "Bearer " + env.BENCH_TOKEN)
  headers.set("x-smoke-attempt", attemptID)
  return namespace.getByName("r0-23-smoke-budget").fetch(new Request("https://smoke/provider", { method: "POST", redirect: "manual", headers, body: request.body, signal: request.signal }))
}

/** Common serial dispatcher for both arms. Unknown usage blocks further requests. */
export class SmokeProvider extends DurableObject<ComparisonBindings> {
  protected readonly synthetic: boolean = false
  protected credential(): string { return this.env.BENCH_PROVIDER_KEY }
  protected upstream(body: Record<string, unknown>, signal: AbortSignal, _index: number, attemptID: string): Promise<Response> {
    const headers=new Headers({authorization:"Bearer "+this.credential(),"content-type":"application/json","x-opencode-session":attemptID})
    if(this.env.BENCH_PROVIDER_ORG)headers.set("x-opencode-org-id",this.env.BENCH_PROVIDER_ORG)
    return fetch(SMOKE_SCOPE.endpoint, { method: "POST", redirect: "manual", headers, body: JSON.stringify(body), signal })
  }

  private async refused(reason: string, status: number, keys: string[] = []): Promise<Response> {
    await this.ctx.storage.transaction(async tx => {
      const rows = await tx.get<Array<{ reason: string; keys: string[] }>>("refusals") ?? []
      await tx.put("refusals", [...rows.slice(-31), { reason, keys: keys.slice(0, 64).map(key => key.slice(0, 80)).sort() }])
    })
    return new Response(reason, { status })
  }

  async fetch(request: Request): Promise<Response> {
    if (!bearerAuthorized(request.headers.get("authorization"), this.env.BENCH_TOKEN)) return new Response("unauthorized", { status: 401 })
    if (request.method === "GET") return Response.json({ scope: SMOKE_SCOPE, calls: await this.ctx.storage.get<SmokeCall[]>("calls") ?? [], refusals: await this.ctx.storage.get("refusals") ?? [], ...(this.synthetic ? { synthetic: true, externalProviderCalls: 0 } : {}) })
    if (request.method !== "POST") return this.refused("provider method refused", 405)
    const attemptID = request.headers.get("x-smoke-attempt") ?? ""
    if (!allowedSmokeAttempt(attemptID) || !this.credential()) return this.refused("smoke not configured or attempt refused", 403)
    let body: Record<string, unknown>
    let keys: string[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (Number(request.headers.get("content-length")) > maxBody) throw new Error("body limit")
      const reader = request.body?.getReader(); if (!reader) throw new Error("body required")
      let size = 0; const chunks: Uint8Array[] = []
      const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("body deadline")), 5000) })
      try { for (;;) { const part = await Promise.race([reader.read(), deadline]); if (part.done) break; size += part.value.byteLength; if (size > maxBody) throw new Error("body limit"); chunks.push(part.value) } }
      finally { if (timer) clearTimeout(timer); void reader.cancel().catch(() => {}); reader.releaseLock() }
      const bytes = new Uint8Array(size); let offset = 0
      for (const part of chunks) { bytes.set(part, offset); offset += part.length }
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) keys = Object.keys(parsed).sort()
      body = normalizeSmokeBody(parsed)
    } catch { return this.refused("provider body read or contract refused", 400, keys) }
    const index = await this.ctx.storage.transaction(async tx => {
      const calls = await tx.get<SmokeCall[]>("calls") ?? []
      if (!smokeAdmissionAllowed(calls, attemptID)) return null
      calls.push({ attemptID, status: "pending", inputTokens: null, outputTokens: null, estimatedUSD: null })
      await tx.put("calls", calls); return calls.length - 1
    })
    if (index === null) return this.refused("smoke budget/call/unknown-usage gate closed", 409, keys)
    let upstreamStatus: number | undefined
    try {
      const upstream = await this.upstream(body, AbortSignal.any([request.signal, AbortSignal.timeout(SMOKE_SCOPE.requestTimeoutMs)]), index, attemptID)
      upstreamStatus = upstream.status
      if (!upstream.ok || !upstream.body) { await upstream.body?.cancel(); throw new Error("upstream refused") }
      return new Response(this.observe(index, upstream.body), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } })
    } catch {
      await this.finish(index, null, null, upstreamStatus)
      return new Response("provider unavailable; usage unknown", { status: 502 })
    }
  }

  private observe(index: number, stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    let input: number | null = null, output: number | null = null
    const decoder = new TextDecoder(); let pending = "", bytes = 0, done = false, terminal = false
    const line = (value: string) => {
      if (value === "data: [DONE]") { done = true; return }
      if (!value.startsWith("data: ")) return
      const row = JSON.parse(value.slice(6))
      if (row.choices?.some((choice: {finish_reason?:unknown})=>typeof choice.finish_reason==="string")) terminal=true
      if (row.usage && Number.isSafeInteger(row.usage.prompt_tokens) && row.usage.prompt_tokens >= 0 && Number.isSafeInteger(row.usage.completion_tokens) && row.usage.completion_tokens >= 0) { input=row.usage.prompt_tokens;output=row.usage.completion_tokens }
    }
    return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform: (part, controller) => {
        bytes += part.length; if (bytes > 8_388_608) throw new Error("response bound")
        pending += decoder.decode(part, { stream: true })
        const lines = pending.split(/\r?\n/); pending = lines.pop() ?? ""
        for (const value of lines) line(value)
        controller.enqueue(part)
      },
      // Commit usage before EOF reaches the SDK, so its next serial model call
      // cannot race the previous request's pending accounting record.
      flush: async () => { if(pending.trim())line(pending.trim());await this.finish(index, done&&terminal?input:null, done&&terminal?output:null) },
    }))
  }

  private async finish(index: number, inputTokens: number | null, outputTokens: number | null, upstreamStatus?: number): Promise<void> {
    await this.ctx.storage.transaction(async tx => {
      const calls = await tx.get<SmokeCall[]>("calls") ?? [], call = calls[index]
      if (!call) return
      call.status = inputTokens === null || outputTokens === null ? "unknown" : "complete"
      if (upstreamStatus !== undefined) call.upstreamStatus = upstreamStatus
      call.inputTokens = inputTokens; call.outputTokens = outputTokens
      call.estimatedUSD = inputTokens === null || outputTokens === null ? null : (inputTokens * SMOKE_SCOPE.inputUSDPerMillion + outputTokens * SMOKE_SCOPE.outputUSDPerMillion) / 1_000_000
      await tx.put("calls", calls)
    })
  }
}

/** Isolated namespace, fixed streaming script: no real credential read or external fetch. */
export class SyntheticSmokeProvider extends SmokeProvider {
  protected readonly synthetic: boolean = true
  protected credential(): string { return "synthetic-noncredential" }
  protected async upstream(body: Record<string, unknown>, signal: AbortSignal, index: number): Promise<Response> {
    signal.throwIfAborted()
    const step = steps[index]
    const delta = step ? { role: "assistant", tool_calls: [{ index: 0, id: "task-tool-" + index, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.input) } }] } : { role: "assistant", content: "R0_23_TASK_ADAPTER_COMPLETE" }
    const chunk = (choices: unknown[], usage?: unknown) => "data: " + JSON.stringify({ id: "synthetic-chat-" + index, object: "chat.completion.chunk", created: 0, model: body.model, choices, ...(usage ? { usage } : {}) }) + "\n\n"
    return new Response(chunk([{ index: 0, delta, finish_reason: null }]) + chunk([{ index: 0, delta: {}, finish_reason: step ? "tool_calls" : "stop" }]) + chunk([], { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
  }
}
