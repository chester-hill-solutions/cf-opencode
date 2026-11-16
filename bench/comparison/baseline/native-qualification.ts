import { DurableObject } from "cloudflare:workers"
import { QUALIFICATION_ARTIFACT } from "../../../scripts/native-storage-qualification/artifact"
import { FROZEN_PROTOCOL_SHA256 } from "./freeze.generated"
import { LinuxToolPlane, type Exec } from "./linux"
import { assertEmptyNativeActionBody, boundedObservation, nativeRoot, runFixedNativeChecks, type CancellationObservation, type NativeCheck } from "./native-checks"

const KEY = "native-qualification"
const TOMBSTONE = "native-cleanup-tombstone"
const DEADLINE_MS = 4 * 60_000
const IDLE_MS = 5 * 60_000
const STOP_WAIT_MS = 5000
type Phase = "preparing" | "prepared" | "recreate-requested" | "recreated" | "losing" | "lost" | "restarting" | "restarted" | "failed" | "cleaned"

interface NativeReceipt {
  schemaVersion: 1
  kind: "model-free-native-qualification"
  providerCalls: 0
  protocolSHA256: string
  attemptID: string
  image: string
  requestedResources: typeof QUALIFICATION_ARTIFACT.instance
  observedResources: null
  phase: Phase
  initialIncarnation: string
  createdAt: number
  deadlineAt: number
  marker: string
  checks: NativeCheck[]
  commits?: Record<"ledger" | "queue", string>
  cancellation?: CancellationObservation
  recreate?: { requestedBy: string; requestedAt: number; observedBy?: string; containerContinued?: boolean; markerContinued?: boolean }
  loss?: { stopped: boolean; observedAt: number }
  restart?: { priorMarkerAbsent: boolean; portableRecovery: "unsupported"; observedAt: number }
  cleanup?: { runtimeStopped: boolean; requestedAt: number; reason: "explicit" | "deadline" }
  error?: string
}

/** Fixed one-shot Linux qualification. No harness/model/provider is imported or started. */
export class NativeQualification extends DurableObject<ComparisonBindings> {
  private readonly incarnation = crypto.randomUUID()
  private readonly stop = new AbortController()
  private cleanupRequested = false
  private tail: Promise<unknown> = Promise.resolve()
  private readonly exec: Exec

  constructor(ctx: DurableObjectState, env: ComparisonBindings) {
    super(ctx, env)
    // Reapply the inactivity backstop without starting a stopped container.
    if (ctx.container?.running) ctx.waitUntil(ctx.container.setInactivityTimeout(IDLE_MS).catch(() => {}))
    this.exec = async (argv, options) => {
      if (!ctx.container?.running) throw new Error("native container absent; implicit replacement refused")
      return ctx.container.exec(argv, { ...options, stdout: "pipe", stderr: "pipe", env: {
        PATH: "/usr/local/bin:/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      } })
    }
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work)
    this.tail = result.then(() => {}, () => {})
    return result
  }

  private async patch(change: Partial<NativeReceipt>): Promise<void> {
    await this.ctx.storage.transaction(async tx => {
      if (await tx.get(TOMBSTONE)) return
      const receipt = await tx.get<NativeReceipt>(KEY)
      if (!receipt) throw new Error("native attempt missing")
      await tx.put(KEY, { ...receipt, ...change })
    })
  }

  private async active(): Promise<void> {
    this.stop.signal.throwIfAborted()
    if (this.cleanupRequested || await this.ctx.storage.get(TOMBSTONE)) throw new Error("native attempt cleaned")
  }

  private start(): void {
    const container = this.ctx.container
    if (!container || container.running) throw new Error("fresh stopped native container required")
    const image = container.images.evented
    if (image !== QUALIFICATION_ARTIFACT.image) throw new Error("frozen evented image mismatch")
    // No await between the active fence and startup in callers.
    if (this.cleanupRequested || this.stop.signal.aborted) throw new Error("native cleanup in progress")
    container.start({ image, entrypoint: ["sleep", "infinity"], enableInternet: false, instance: { ...QUALIFICATION_ARTIFACT.instance } })
  }

  private plane(root = nativeRoot): LinuxToolPlane { return new LinuxToolPlane(this.exec, root, this.stop.signal) }

  private async prepare(receipt: NativeReceipt): Promise<void> {
    try {
      await this.active(); this.start()
      await this.ctx.container!.setInactivityTimeout(IDLE_MS)
      await this.active()
      // Root must be new; do not reuse a preexisting workspace or delete its contents.
      const setup = await this.exec(["bash", "-lc", `test ! -e ${nativeRoot} && mkdir -p ${nativeRoot}/{tools,ledger,queue,cancellation}`], { cwd: "/workspace", signal: this.stop.signal })
      const code = await boundedObservation(setup.exitCode, 10_000)
      void setup.stdout?.cancel().catch(() => {}); void setup.stderr?.cancel().catch(() => {})
      if (code !== 0) throw new Error("fresh native workspace refused")
      await this.plane().execute("write", { path: "continuity.txt", content: receipt.marker }, this.stop.signal)
      const checks: NativeCheck[] = []
      const runtime = JSON.parse(await this.plane().execute("shell", { command: "bun -e 'process.stdout.write(JSON.stringify({platform:process.platform,arch:process.arch}))'" }, this.stop.signal)) as { platform: string; arch: string }
      const linux = runtime.platform === "linux" && runtime.arch === "x64"
      checks.push({ id: "runtime-platform", passed: linux, details: { platform: linux ? "linux" : "unexpected", arch: runtime.arch === "x64" ? "x64" : "unexpected" } })
      await this.patch({ checks })
      if (!linux) throw new Error("frozen Linux x64 image required")
      const result = await runFixedNativeChecks(this.exec, nativeRoot, this.stop.signal, async check => {
        checks.push(check)
        await this.patch({ checks })
      })
      await this.active()
      await this.patch({ phase: "prepared", checks, commits: result.commits, cancellation: result.cancellation })
    } catch { await this.patch({ phase: "failed", error: "fixed native preparation/check failed; inspect explicit stop receipt" }).catch(() => {}) }
  }

  private async status(): Promise<Response> {
    let receipt = await this.ctx.storage.get<NativeReceipt>(KEY) ?? null
    const tombstone = await this.ctx.storage.get<NativeReceipt["cleanup"]>(TOMBSTONE)
    if (receipt?.phase === "recreate-requested" && receipt.recreate && receipt.recreate.requestedBy !== this.incarnation && !tombstone) {
      const running = this.ctx.container?.running === true
      let markerContinued = false
      if (running) {
        try { markerContinued = await this.plane().execute("read", { path: "continuity.txt" }, AbortSignal.timeout(5000)) === receipt.marker }
        catch { /* Report loss rather than repairing or replacing it. */ }
      }
      await this.patch({ phase: "recreated", recreate: { ...receipt.recreate, observedBy: this.incarnation, containerContinued: running, markerContinued },
        checks: [...receipt.checks, { id: "coordinator-recreation", passed: running && markerContinued, details: { changedIncarnation: true, containerContinued: running, markerContinued } }] })
      receipt = await this.ctx.storage.get<NativeReceipt>(KEY) ?? null
    }
    return Response.json({ schemaVersion: 1, kind: "model-free-native-qualification", providerCalls: 0,
      incarnation: this.incarnation, containerRunning: this.ctx.container?.running ?? false,
      receipt: receipt && tombstone ? { ...receipt, phase: "cleaned", cleanup: tombstone } : receipt, cleanup: tombstone ?? null })
  }

  /** No dependency on the command/action queue: cleanup can stop a stuck prepare. */
  private async cleanup(reason: "explicit" | "deadline"): Promise<Response> {
    this.cleanupRequested = true; this.stop.abort()
    const requestedAt = Date.now()
    const recording = boundedObservation(this.ctx.storage.put(TOMBSTONE, { runtimeStopped: false, requestedAt, reason }), STOP_WAIT_MS).then(() => true, () => false)
    const stopping = boundedObservation((async () => {
      const container = this.ctx.container
      if (container?.running) await container.destroy()
      return container?.running !== true
    })(), STOP_WAIT_MS).catch(() => false)
    const [tombstoneRecorded, runtimeStopped] = await Promise.all([recording, stopping])
    let cleanupRecorded = false
    if (tombstoneRecorded) cleanupRecorded = await boundedObservation(this.ctx.storage.put(TOMBSTONE, { runtimeStopped, requestedAt, reason }), STOP_WAIT_MS).then(() => true, () => false)
    // A retained alarm retries uncertain stop. Never erase the one-shot tombstone.
    try {
      if (runtimeStopped && cleanupRecorded) await boundedObservation(this.ctx.storage.deleteAlarm(), STOP_WAIT_MS)
      else await boundedObservation(this.ctx.storage.setAlarm(Date.now() + 10_000), STOP_WAIT_MS)
    } catch { /* Inactivity timeout is the independent platform backstop. */ }
    return Response.json({ schemaVersion: 1, kind: "model-free-native-qualification", providerCalls: 0,
      incarnation: this.incarnation, runtimeStopped, cleanupRecorded, tombstoneRecorded }, { status: runtimeStopped && cleanupRecorded ? 200 : 503 })
  }

  async alarm(): Promise<void> {
    const receipt = await this.ctx.storage.get<NativeReceipt>(KEY)
    if (await this.ctx.storage.get(TOMBSTONE) || !receipt || Date.now() >= receipt.deadlineAt) { await this.cleanup("deadline"); return }
    await this.ctx.storage.setAlarm(receipt.deadlineAt)
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (request.method === "GET" && path === "/native/status") return this.serial(() => this.status())
    if (request.method !== "POST" || !["/native/prepare", "/native/recreate", "/native/lose", "/native/restart", "/native/cleanup"].includes(path)) return new Response("not found", { status: 404 })
    try { await assertEmptyNativeActionBody(request) }
    catch { return Response.json({ error: "fixed native actions accept no request body; empty-body read failed or exceeded deadline", providerCalls: 0 }, { status: 400 }) }
    if (path === "/native/cleanup") return this.cleanup("explicit")
    return this.serial(async () => {
      if (await this.ctx.storage.get(TOMBSTONE)) return Response.json({ error: "native qualification cleaned; one-shot tombstone retained", providerCalls: 0 }, { status: 409 })
      const receipt = await this.ctx.storage.get<NativeReceipt>(KEY)
      if (receipt && Date.now() >= receipt.deadlineAt) return Response.json({ error: "native qualification deadline elapsed; cleanup required", providerCalls: 0 }, { status: 409 })
      if (path === "/native/prepare") {
        if (receipt) return Response.json({ error: "native qualification already attempted", providerCalls: 0 }, { status: 409 })
        const now = Date.now()
        const initial: NativeReceipt = { schemaVersion: 1, kind: "model-free-native-qualification", providerCalls: 0,
          protocolSHA256: FROZEN_PROTOCOL_SHA256, attemptID: crypto.randomUUID(), image: QUALIFICATION_ARTIFACT.image,
          requestedResources: QUALIFICATION_ARTIFACT.instance, observedResources: null, phase: "preparing",
          initialIncarnation: this.incarnation, createdAt: now, deadlineAt: now + DEADLINE_MS,
          marker: crypto.randomUUID(), checks: [] }
        await this.ctx.storage.put(KEY, initial)
        await this.ctx.storage.setAlarm(initial.deadlineAt)
        this.ctx.waitUntil(this.prepare(initial))
        return Response.json({ accepted: true, providerCalls: 0, incarnation: this.incarnation, receipt: initial }, { status: 202 })
      }
      if (!receipt) return Response.json({ error: "native preparation required", providerCalls: 0 }, { status: 409 })
      if (path === "/native/recreate") {
        if (receipt.phase !== "prepared") return Response.json({ error: "prepared phase required", providerCalls: 0 }, { status: 409 })
        await this.patch({ phase: "recreate-requested", recreate: { requestedBy: this.incarnation, requestedAt: Date.now() } })
        // Ack first. Reset only the coordinator; no container operation is performed.
        this.ctx.waitUntil(new Promise<void>(resolve => setTimeout(resolve, 250)).then(() => {
          if (!this.cleanupRequested) this.ctx.abort("R0-23 fixed native coordinator recreation")
        }))
        return Response.json({ accepted: true, providerCalls: 0, requestedIncarnation: this.incarnation, action: "coordinator-abort-scheduled" }, { status: 202 })
      }
      if (path === "/native/lose") {
        if (receipt.phase !== "recreated" || !receipt.recreate?.containerContinued || !receipt.recreate.markerContinued) return Response.json({ error: "verified coordinator recreation required", providerCalls: 0 }, { status: 409 })
        await this.patch({ phase: "losing" })
        const stopped = await boundedObservation((async () => {
          const container = this.ctx.container
          if (!container) return false
          await container.destroy()
          return container.running === false
        })(), STOP_WAIT_MS).catch(() => false)
        await this.patch({ phase: stopped ? "lost" : "failed", loss: { stopped, observedAt: Date.now() } })
        return Response.json({ providerCalls: 0, incarnation: this.incarnation, runtimeStopped: stopped, portableRecovery: "unsupported" }, { status: stopped ? 200 : 503 })
      }
      if (receipt.phase !== "lost" || !receipt.loss?.stopped) return Response.json({ error: "confirmed container loss required", providerCalls: 0 }, { status: 409 })
      await this.patch({ phase: "restarting" })
      try {
        await this.active(); this.start()
        await this.ctx.container!.setInactivityTimeout(IDLE_MS)
        const code = await this.exec(["bash", "-lc", `test ! -e ${nativeRoot}/continuity.txt`], { cwd: "/workspace", signal: AbortSignal.timeout(10_000) })
        const absent = await boundedObservation(code.exitCode, 10_000) === 0
        void code.stdout?.cancel().catch(() => {}); void code.stderr?.cancel().catch(() => {})
        await this.patch({ phase: absent ? "restarted" : "failed", restart: { priorMarkerAbsent: absent, portableRecovery: "unsupported", observedAt: Date.now() },
          checks: [...receipt.checks, { id: "container-loss-observation", passed: absent, details: { priorMarkerAbsent: absent, portableRecovery: "unsupported; fresh image start is not successful restore" } }] })
        const response = await this.status()
        return absent ? response : new Response(response.body, { status: 422, headers: response.headers })
      } catch {
        await this.patch({ phase: "failed", error: "explicit fresh restart failed; no recovery was attempted" }).catch(() => {})
        return Response.json({ error: "native restart failed", providerCalls: 0 }, { status: 503 })
      }
    })
  }
}
