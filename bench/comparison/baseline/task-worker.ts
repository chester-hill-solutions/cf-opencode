import { DurableObject } from "cloudflare:workers"
import { Lifecycle } from "agents/lifecycle"
import { OpenCodeHarness } from "agents/harness/opencode"
import { OpenCodeWorkerd } from "@opencode/sdk/workerd"
import { tasks } from "../protocol"
import { TaskJournal, type JournalStore, type TaskReceipt, type TaskIdentity } from "./journal"
import { LinuxToolPlane, type Exec } from "./linux"
import { taskModel } from "./task-model"
import { taskPlugin, taskProviderID, taskToolInstructions } from "./task-plugin"
import { parseTaskConfig, parseTaskRequest, readTaskBody, assertTaskConfiguration, taskConfigDigest, type TaskConfig } from "./task-request"
import { prepareTaskWorkspace, taskRoot, snapshotCommand } from "./task-workspace"
import { FROZEN_PROTOCOL_SHA256 } from "./freeze.generated"
import { TaskRuntime } from "./task-runtime"
import { smokeTransport } from "./smoke-provider"
import { SMOKE_SCOPE } from "./smoke-scope"

export function durableJournal(storage: DurableObjectStorage): TaskJournal {
  const store: JournalStore = {
    async read() { return await storage.get<TaskReceipt>("task-receipt") ?? null },
    change(update) {
      return storage.transaction(async tx => {
        const { next, result } = update(await tx.get<TaskReceipt>("task-receipt") ?? null)
        if (new TextEncoder().encode(JSON.stringify(next)).length > 120_000) throw new Error("task receipt storage bound")
        await tx.put("task-receipt", next)
        return result
      })
    },
  }
  return new TaskJournal(store)
}

/** One immutable attempt per DO/container. No provider secret enters tool execution. */
export class TaskBaseline extends DurableObject<ComparisonBindings> {
  private readonly journal: TaskJournal
  private readonly plane: LinuxToolPlane
  private readonly lifecycle: Lifecycle<ComparisonBindings>
  private readonly config: TaskConfig | null
  private readonly harness: OpenCodeHarness | null
  private readonly runtime: TaskRuntime
  private readonly stop = new AbortController()

  constructor(ctx: DurableObjectState, env: ComparisonBindings) {
    super(ctx, env)
    this.journal = durableJournal(ctx.storage)
    const exec: Exec = async (argv, options) => {
      if (!ctx.container?.running) throw new Error("attempt container absent; automatic fresh replacement refused")
      return ctx.container.exec(argv, { ...options, stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/local/bin:/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } })
    }
    this.plane = new LinuxToolPlane(exec, taskRoot, this.stop.signal)
    try { this.config = parseTaskConfig(env.BENCH_TASK_CONFIG, FROZEN_PROTOCOL_SHA256) } catch { this.config = null }
    this.lifecycle = Lifecycle.install(this)
    if (!this.config) { this.harness = null; this.runtime = new TaskRuntime(this.journal, () => this.lifecycle.start(), null, this.stop, work => ctx.waitUntil(work), () => this.lifecycle.disableAlarms()); return }
    const config = this.config
    this.harness = new OpenCodeHarness({ opencode: async ({ storage }) => {
      this.stop.signal.throwIfAborted()
      const receipt = await this.journal.store.read()
      if (!receipt) throw new Error("attempt not admitted")
      if (receipt.cleanup === "stopped" || !["ready", "running"].includes(receipt.phase)) throw new Error("attempt inactive; SDK boot refused")
      await assertTaskConfiguration(receipt.identity, config, env.BENCH_PROVIDER_KEY, FROZEN_PROTOCOL_SHA256)
      this.stop.signal.throwIfAborted()
      const transport = config.model.baseURL === SMOKE_SCOPE.baseURL ? async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const body = await this.journal.store.read()
        if (!body) throw new Error("attempt not admitted")
        return smokeTransport(env, body.identity.id, new Request(input, init))
      } : undefined
      const model = taskModel(config.model, env.BENCH_PROVIDER_KEY, this.journal, () => this.ensureWorkspace(), transport, this.stop.signal)
      return OpenCodeWorkerd.create({ storage, models: { fetch: false },
        config: { default_agent: "build", experimental: { background_compaction: false }, agents: { title: { disabled: true } } },
        plugins: [taskPlugin(this.plane, model, this.journal, { context: config.model.contextTokens, output: config.model.maxOutputTokens })] })
    }, defaults: { model: { providerID: taskProviderID, id: config.model.model }, agent: "build" } })
    this.lifecycle.use(this.harness)
    this.runtime = new TaskRuntime(this.journal, () => this.lifecycle.start(), this.harness, this.stop, work => ctx.waitUntil(work), () => this.lifecycle.disableAlarms())
  }

  private async ensureWorkspace(): Promise<void> {
    const receipt = await this.journal.store.read()
    if (!receipt || receipt.cleanup !== "pending" || receipt.phase !== "running") throw new Error("attempt inactive")
    const marker = await this.plane.execute("read", { path: ".r0-23-attempt" }, AbortSignal.timeout(5000))
    if (marker !== receipt.identity.id) throw new Error("workspace identity mismatch")
  }

  async alarm(): Promise<void> {
    // Override Lifecycle's automatic alarm entry: retained terminal/tombstoned
    // attempts must not reopen the SDK on a later wake or actor recreation.
    const receipt = await this.journal.store.read()
    if (!this.harness || !receipt || receipt.cleanup === "stopped" || !["ready", "running"].includes(receipt.phase)) {
      await this.lifecycle.disableAlarms()
      await this.harness?.dispose()
      return
    }
    await this.lifecycle.alarm()
  }

  private async run(identity: TaskIdentity): Promise<void> {
    let stage = "fixture setup interrupted"
    try {
      await this.runtime.prepare(async signal => {
        const container = this.ctx.container
        if (!container || container.running) throw new Error("fresh owned container required")
        const image = container.images.evented
        if (!image) throw new Error("pinned evented image required")
        signal.throwIfAborted()
        container.start({ image, entrypoint: ["sleep", "infinity"], enableInternet: false, instance: { vcpu: 1, memoryMib: 2048, diskMb: 8192 } })
        await container.setInactivityTimeout((this.config?.deadlineMs ?? 900_000) + 60_000)
        signal.throwIfAborted()
        const setupSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        const mkdir = await container.exec(["mkdir", "-p", taskRoot], { signal: setupSignal })
        signal.throwIfAborted()
        if ((await mkdir.output()).exitCode !== 0) throw new Error("workspace setup failed")
        signal.throwIfAborted()
        await prepareTaskWorkspace(identity.taskID, identity.id, this.plane, setupSignal)
        signal.throwIfAborted()
        await this.journal.transition("preparing", "ready")
      })
      // Warm means only runtime priming. No prior prompt or solution is submitted.
      if (identity.condition === "warm") await this.runtime.prime()
      await this.journal.transition("ready", "running")
      stage = "task execution or observation interrupted; runtime stop unconfirmed"
      if (!this.harness || !this.config) throw new Error("task configuration unavailable")
      const task = tasks.find(task => task.id === identity.taskID)!
      await this.runtime.submit(taskToolInstructions + "\n\n" + task.prompt, identity.id)
      await this.runtime.wait(identity.id, this.config.deadlineMs)
    } catch { await this.journal.fail(stage) }
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (request.method === "GET" && path.endsWith("/receipt")) return Response.json({ cached: true, receipt: await this.journal.store.read() })
    if (request.method === "POST" && path.endsWith("/observe")) {
      const receipt = await this.journal.store.read()
      if (!receipt) return Response.json({ error: "attempt not found" }, { status: 404 })
      let observation = "cached"
      if (receipt.phase === "running" && this.harness) {
        // This explicit action may resume the original operation; GET receipt is passive.
        try {
          observation = await this.runtime.observe(receipt.operationID)
        } catch { observation = "unconfirmed" }
      }
      return Response.json({ cached: true, observation, receipt: await this.journal.store.read() })
    }
    if (request.method === "POST" && path.endsWith("/cleanup")) {
      const receipt = await this.journal.store.read()
      if (!receipt) return Response.json({ error: "attempt not found" }, { status: 404 })
      try {
        const result = await this.runtime.cleanup({ destroy: async () => { await this.ctx.container?.destroy() }, running: () => this.ctx.container?.running ?? false })
        // Retain the journal as a tombstone: cleanup must not permit reexecution.
        return Response.json(result, { status: result.runtimeStopped && result.cleanupRecorded ? 200 : 503 })
      } catch { return Response.json({ error: "cleanup failed; runtime stop unconfirmed" }, { status: 503 }) }
    }
    if (request.method === "GET" && path.endsWith("/snapshot")) {
      const receipt = await this.journal.store.read()
      if (!receipt || receipt.phase !== "done" || receipt.cleanup !== "pending") return Response.json({ error: "completed live attempt required" }, { status: 409 })
      try {
        await this.ensureSnapshotWorkspace(receipt)
        const output = await this.plane.execute("shell", { command: snapshotCommand }, AbortSignal.timeout(30_000))
        return new Response(output, { headers: { "content-type": "application/json" } })
      } catch { return Response.json({ error: "bounded snapshot unavailable; quiescence unproven" }, { status: 422 }) }
    }
    if (request.method !== "POST" || !/\/tasks\/[\w-]+$/.test(path)) return new Response("not found", { status: 404 })
    if (!this.config || !this.harness || !this.env.BENCH_PROVIDER_KEY) return Response.json({ error: "task endpoint disabled; frozen model/config/credential required", configReady:Boolean(this.config),harnessReady:Boolean(this.harness),credentialReady:Boolean(this.env.BENCH_PROVIDER_KEY) }, { status: 503 })
    try {
      const body = parseTaskRequest(await readTaskBody(request), FROZEN_PROTOCOL_SHA256)
      if (!path.endsWith("/tasks/" + body.id)) throw new Error("path/attempt mismatch")
      const identity = { ...body, configSHA256: await taskConfigDigest(this.config, this.env.BENCH_PROVIDER_KEY) }
      const accepted = await this.journal.admit(identity)
      if (accepted) this.ctx.waitUntil(this.run(identity))
      return Response.json({ accepted, cached: !accepted, receipt: await this.journal.store.read() }, { status: accepted ? 202 : 200 })
    } catch { return Response.json({ error: "invalid or conflicting task request" }, { status: 409 }) }
  }

  private async ensureSnapshotWorkspace(receipt: TaskReceipt): Promise<void> {
    const marker = await this.plane.execute("read", { path: ".r0-23-attempt" }, AbortSignal.timeout(5000))
    if (marker !== receipt.identity.id) throw new Error("workspace identity mismatch")
  }
}
