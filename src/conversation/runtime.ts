import { opencodeViaControl } from "../opencode-proxy"
import type { ContainerPort } from "../opencode"
import { logEvent } from "../log"
import { traceId, withSpan } from "../telemetry"
import { emitConversationTelemetry, type ConversationTelemetrySink } from "./telemetry"

type RuntimeContainer = NonNullable<DurableObjectState["container"]>

export interface ConversationRuntimePorts {
  conversationID?: string
  telemetry?: ConversationTelemetrySink
  network: {
    transport(): ((port: number) => ContainerPort) | undefined
    containerURL(): string | undefined
  }
  binding: {
    get(): RuntimeContainer | undefined
  }
  startup: {
    start(): Promise<boolean>
    prepareImage(container: RuntimeContainer): Promise<void>
    options(): ContainerStartupOptions
  }
  snapshots: {
    snapshotHandle(): Promise<ContainerSnapshot | undefined>
    clearSnapshot(): Promise<boolean>
  }
  authorization: { controlToken(): Promise<string> }
  lifecycle?: { beforeStop(): void }
  observations: { snapshotStale(): void; count(name: string): void }
}

/** Owns runtime ports and process-local readiness/startup cache. */
export class ConversationRuntime {
  private readyValue = false
  private apiPortValue?: ContainerPort
  private generationValue?: string
  private eventPersistenceValue?: boolean
  private eventPersistenceGenerationValue?: string
  private startModeValue: "image" | "snapshot" | "none" = "none"
  private inactivitySetValue = false
  private imageVariantValue?: "base" | "evented"
  private readying?: Promise<ContainerPort>
  private stopConfirmedValue = false

  constructor(private readonly ports: ConversationRuntimePorts) {}

  get ready(): boolean { return this.readyValue }
  get apiPort(): ContainerPort | undefined { return this.apiPortValue }
  get generation(): string | undefined { return this.generationValue }
  get eventPersistence(): boolean | undefined { return this.eventPersistenceValue }
  get eventPersistenceGeneration(): string | undefined { return this.eventPersistenceGenerationValue }
  get startMode(): "image" | "snapshot" | "none" { return this.startModeValue }
  get inactivitySet(): boolean { return this.inactivitySetValue }
  get imageVariant(): "base" | "evented" | undefined { return this.imageVariantValue }
  get confirmedStopped(): boolean {
    const container = this.ports.binding.get()
    return container ? this.stopConfirmedValue || container.running === false : false
  }

  bindImage(variant: "base" | "evented" | undefined): void {
    this.imageVariantValue = variant
  }

  recordGeneration(generation: string): void {
    this.generationValue = generation
  }

  recordProof(generation: string, eventPersistence: boolean): void {
    this.generationValue = generation
    this.eventPersistenceValue = eventPersistence
    this.eventPersistenceGenerationValue = generation
  }

  markVerified(port: ContainerPort, generation: string, eventPersistence: boolean): void {
    this.stopConfirmedValue = false
    this.recordProof(generation, eventPersistence)
    this.apiPortValue = port
    this.readyValue = true
  }

  pauseServer(): void {
    this.readyValue = false
    this.apiPortValue = undefined
  }

  invalidate(): void {
    this.pauseServer()
    this.generationValue = undefined
    this.eventPersistenceValue = undefined
    this.eventPersistenceGenerationValue = undefined
  }

  resetAfterStop(): void {
    this.invalidate()
    this.inactivitySetValue = false
  }

  /** Stop only when the binding confirms destruction; failed stops retain ownership. */
  async stop(): Promise<boolean> {
    const container = this.ports.binding.get()
    if (!container) {
      // Headless and external-host conversations have no native process to stop.
      // This is cleanup success, but not a positive native stop proof for leases.
      this.resetAfterStop()
      return true
    }
    const startedAt = Date.now()
    const generation = this.generationValue
    return withSpan("container.stop", async (span) => {
      this.ports.lifecycle?.beforeStop()
      if (container.running !== false) {
        try {
          await container.destroy()
        } catch {
          this.ports.observations.count("container.stop.failed")
          span.setAttribute("container.stop.result", "failed")
          this.emitLifecycle({
            event: "container.stop.failed",
            runtimeGeneration: generation,
            result: "failed",
            durationMs: Date.now() - startedAt,
            reasonCode: "destroy_failed",
          })
          return false
        }
      }
      this.stopConfirmedValue = true
      this.resetAfterStop()
      const durationMs = Date.now() - startedAt
      span.setAttribute("container.stop.result", "stopped")
      this.ports.observations.count("container.stopped")
      this.emitLifecycle({
        event: "container.stopped",
        runtimeGeneration: generation,
        result: "stopped",
        durationMs,
      })
      return true
    })
  }

  ensureReady(load: () => Promise<ContainerPort>): Promise<ContainerPort> {
    if (!this.readying) {
      this.readying = load().finally(() => {
        this.readying = undefined
      })
    }
    return this.readying
  }

  applyInactivity(container: RuntimeContainer): void {
    if (this.inactivitySetValue) return
    this.inactivitySetValue = true
    void container.setInactivityTimeout(10 * 60_000).catch(() => {})
  }

  async startBoundContainer(container: RuntimeContainer): Promise<boolean> {
    const startedAt = Date.now()
    try {
      return await withSpan("container.start", async (span) => {
        await this.ports.startup.prepareImage(container)
        const options = this.ports.startup.options()
        const snapshot = await this.ports.snapshots.snapshotHandle()
        if (snapshot) {
          try {
            container.start({ ...options, image: undefined, containerSnapshot: snapshot } as ContainerStartupOptions)
            this.stopConfirmedValue = false
            this.startModeValue = "snapshot"
            this.applyInactivity(container)
            span.setAttribute("container.start_mode", "snapshot")
            span.setAttribute("container.start.result", "started")
            logEvent("snapshot.restored")
            this.ports.observations.count("snapshot.restored")
            this.recordStarted("snapshot", startedAt)
            return true
          } catch {
            this.ports.observations.snapshotStale()
            span.setAttribute("container.snapshot_stale", true)
            await this.ports.snapshots.clearSnapshot()
          }
        }
        container.start(options)
        this.stopConfirmedValue = false
        this.startModeValue = "image"
        this.applyInactivity(container)
        span.setAttribute("container.start_mode", "image")
        span.setAttribute("container.start.result", "started")
        this.recordStarted("image", startedAt)
        return false
      })
    } catch (error) {
      this.ports.observations.count("container.start.failed")
      this.emitLifecycle({
        event: "container.start.failed",
        runtimeGeneration: this.generationValue,
        result: "failed",
        durationMs: Date.now() - startedAt,
        reasonCode: "start_failed",
      })
      throw error
    }
  }

  private recordStarted(mode: "image" | "snapshot", startedAt: number): void {
    const durationMs = Date.now() - startedAt
    this.ports.observations.count("container.started")
    this.emitLifecycle({
      event: "container.started",
      runtimeGeneration: this.generationValue,
      result: "succeeded",
      durationMs,
      reasonCode: mode,
    })
  }

  private emitLifecycle(input: Parameters<typeof emitConversationTelemetry>[0]): void {
    emitConversationTelemetry({ ...input, conversationID: this.ports.conversationID }, this.ports.telemetry, traceId)
  }

  async port(number: number): Promise<ContainerPort> {
    if (number === 4000) {
      if (this.ports.network.transport()) return this.rawPort(number)
      return opencodeViaControl(await this.controlPort())
    }
    const base = await this.rawPort(number)
    if (number !== 4001) return base
    const token = await this.ports.authorization.controlToken()
    return {
      fetch: (input, init) => {
        const request = new Request(input as any, init)
        request.headers.set("authorization", `Bearer ${token}`)
        return base.fetch(request)
      },
    }
  }

  private controlPort(): Promise<ContainerPort> {
    return this.port(4001)
  }

  private async rawPort(number: number): Promise<ContainerPort> {
    const transport = this.ports.network.transport()
    if (transport) return transport(number)
    const containerURL = this.ports.network.containerURL()
    if (containerURL) {
      const host = new URL(containerURL).hostname
      return {
        fetch: (input, init) => {
          const original = input instanceof Request ? input : new Request(input as any, init)
          const url = new URL(original.url)
          url.hostname = host
          url.port = String(number)
          return fetch(url.toString(), {
            method: original.method,
            headers: original.headers,
            body: original.body,
          })
        },
      }
    }
    const container = this.ports.binding.get()
    if (!container) throw new Error("no container bound")
    const usedSnapshot = container.running ? false : await this.ports.startup.start()
    const port = container.getTcpPort(number)
    const ready = async (limit: number): Promise<boolean> => {
      for (let attempt = 0; attempt < limit; attempt++) {
        try {
          const response = await port.fetch("http://container/health", {
            signal: AbortSignal.timeout(2000),
          })
          if (response.ok) return true
        } catch {
          // A new process may need time before its local endpoint accepts traffic.
        }
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
      return false
    }
    if (await ready(usedSnapshot ? 90 : 300)) return port
    if (usedSnapshot) {
      this.ports.observations.snapshotStale()
      await this.ports.snapshots.clearSnapshot()
      if (!(await this.stop())) throw new Error("snapshot container stop was not confirmed")
      await this.ports.startup.start()
      if (await ready(300)) return port
    }
    throw new Error(`container port ${number} did not become ready`)
  }
}
