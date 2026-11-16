import { DurableObject } from "cloudflare:workers"
import { Lifecycle } from "agents/lifecycle"
import { OpenCodeHarness } from "agents/harness/opencode"
import { OpenCodeWorkerd } from "@opencode/sdk/workerd"
import { SimulatedToolPlane } from "./linux"
import { durableJournal } from "./task-worker"
import { taskPlugin, taskProviderID } from "./task-plugin"
import { taskModel, type ProviderTransport } from "./task-model"
import { TaskRuntime } from "./task-runtime"
import { normalizeSmokeBody } from "./smoke-contract"
import { SMOKE_SCOPE } from "./smoke-scope"
import { smokeTransport } from "./smoke-provider"
import { taskAttemptID } from "./task-request"
import { FROZEN_PROTOCOL_SHA256 } from "./freeze.generated"

/** Real provider parser and task plugin, synthetic HTTP/SSE, simulated tools. */
export class SyntheticTaskProbe extends DurableObject<ComparisonBindings> {
  private readonly journal
  private readonly lifecycle: Lifecycle<ComparisonBindings>
  private readonly harness: OpenCodeHarness
  private readonly runtime: TaskRuntime
  private readonly stop = new AbortController()
  private readonly contractObservations: Array<{ keys: string[]; accepted: boolean; rejection: string | null }> = []
  private readonly bridgeObservations: Array<{ stage: string; status?: number; name?: string; message?: string }> = []

  constructor(ctx: DurableObjectState, env: ComparisonBindings) {
    super(ctx, env)
    this.journal = durableJournal(ctx.storage)
    const contractObservations = this.contractObservations
    const config = { model: SMOKE_SCOPE.model, baseURL: "https://provider.invalid/v1", temperature: SMOKE_SCOPE.temperature, maxOutputTokens: SMOKE_SCOPE.maxOutputTokens, contextTokens: SMOKE_SCOPE.contextTokens, maxModelCalls: 8, requestTimeoutMs: 5000 }
    const transport: ProviderTransport = async (input, init) => {
      const body = JSON.parse(String(init?.body))
      if (String(input) !== config.baseURL + "/chat/completions" || init?.redirect !== "manual" || body.model !== config.model || body.temperature !== config.temperature || body.max_tokens !== config.maxOutputTokens || new Headers(init.headers).get("authorization") !== "Bearer synthetic-noncredential") throw new Error("synthetic provider request mismatch")
      try { normalizeSmokeBody(body); contractObservations.push({ keys: Object.keys(body).sort(), accepted: true, rejection: null }) }
      catch (error) { contractObservations.push({ keys: Object.keys(body).sort(), accepted: false, rejection: error instanceof Error ? error.message : "contract rejected" }) }
      const id = taskAttemptID("L1", "cold", 1, FROZEN_PROTOCOL_SHA256)
      try {
        this.bridgeObservations.push({ stage: "construct-request" })
        const request = new Request(input, init)
        this.bridgeObservations.push({ stage: "dispatch-cross-do" })
        const response = await smokeTransport(env, id, request, env.SYNTHETIC_SMOKE_PROVIDER)
        this.bridgeObservations.push({ stage: "received-status", status: response.status })
        return response
      } catch (error) {
        this.bridgeObservations.push({ stage: "bridge-error", name: error instanceof Error ? error.name : "unknown", message: (error instanceof Error ? error.message : "bridge failed").replaceAll(env.BENCH_TOKEN, "[control-token-redacted]").slice(0, 500) })
        this.stop.abort()
        throw error
      }
    }
    const model = taskModel(config, "synthetic-noncredential", this.journal, async () => {}, transport, this.stop.signal)
    this.harness = new OpenCodeHarness({ opencode: ({ storage }) => OpenCodeWorkerd.create({ storage, models: { fetch: false },
      config: { default_agent: "build", experimental: { background_compaction: false }, agents: { title: { disabled: true } } },
      plugins: [taskPlugin(new SimulatedToolPlane(), model, this.journal, { context: config.contextTokens, output: config.maxOutputTokens })] }),
      defaults: { model: { providerID: taskProviderID, id: config.model }, agent: "build" } })
    this.lifecycle = Lifecycle.install(this).use(this.harness)
    this.runtime = new TaskRuntime(this.journal, () => this.lifecycle.start(), this.harness, this.stop, work => ctx.waitUntil(work), () => this.lifecycle.disableAlarms())
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === "/receipt") return Response.json({ cached: true, receipt: await this.ctx.storage.get("task-probe-receipt") ?? null })
    if (path === "/cleanup") {
      if (!await this.journal.store.read()) return new Response("not found", { status: 404 })
      const result = await this.runtime.cleanup({ async destroy() {}, running: () => false })
      return Response.json({ ...result, alarmsDisabled: result.coordinatorDisposed && await this.ctx.storage.getAlarm() === null }, { status: result.runtimeStopped && result.cleanupRecorded ? 200 : 503 })
    }
    const accepted = await this.journal.admit({ id: "synthetic-task-wiring", taskID: "PROBE", condition: "cold", repetition: 1, protocolSHA256: "synthetic-only", configSHA256: "synthetic-only" })
    if (!accepted) return Response.json({ error: "synthetic task probe already attempted" }, { status: 409 })
    try {
      await this.journal.transition("preparing", "ready"); await this.journal.transition("ready", "running")
      await this.runtime.submit("Exercise the scripted tools.", "synthetic-task-wiring")
      await this.runtime.wait("synthetic-task-wiring", 60_000)
      const receipt = await this.journal.store.read()
      const broker = await this.brokerReceipt()
      const passed = receipt?.phase === "done" && receipt.result?.text.includes("R0_23_TASK_ADAPTER_COMPLETE") && receipt.tools.length === 5 && receipt.tools.every(tool => tool.status === "done") && receipt.modelCalls.length === 6 && receipt.modelCalls.every(call => call.finished && call.inputTokens === 10 && call.outputTokens === 1) && this.contractObservations.length === 6 && this.contractObservations.every(row => row.accepted) && broker.synthetic === true && broker.calls?.length === 6 && broker.calls.every(call => call.status === "complete") && broker.refusals?.length === 0
      const observation = { kind: "synthetic-task-adapter", passed: Boolean(passed), externalProviderCalls: 0, transport: "mocked-cross-do-broker-http-sse", toolPlane: "simulated", contractObservations: this.contractObservations, bridgeObservations: this.bridgeObservations, broker, receipt }
      await this.ctx.storage.put("task-probe-receipt", observation)
      return Response.json(observation, { status: passed ? 200 : 422 })
    } catch {
      await this.journal.fail("synthetic task adapter failed")
      const observation = { passed: false, receipt: await this.journal.store.read(), contractObservations: this.contractObservations, bridgeObservations: this.bridgeObservations, broker: await this.brokerReceipt().catch(() => null), externalProviderCalls: 0 }
      await this.ctx.storage.put("task-probe-receipt", observation)
      return Response.json(observation, { status: 422 })
    }
  }

  private async brokerReceipt(): Promise<{ synthetic?: boolean; calls?: Array<{ status: string }>; refusals?: unknown[] }> {
    const response = await this.env.SYNTHETIC_SMOKE_PROVIDER.getByName("r0-23-smoke-budget").fetch("https://smoke/usage", { method: "GET", headers: { authorization: "Bearer " + this.env.BENCH_TOKEN } })
    return response.json()
  }
}
