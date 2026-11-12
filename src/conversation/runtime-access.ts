import type { ContainerPort } from "../opencode"
import { RuntimeUseGate } from "./runtime-gate"

export interface RuntimeIdentity {
  port?: ContainerPort
  generation?: string
  ready: boolean
  running: boolean
}

export interface ConversationRuntimeAccessOptions {
  prepareOwned(): Promise<ContainerPort>
  identity(): RuntimeIdentity
  onUseComplete?(): Promise<void> | void
}

/** Serializes preparation and destructive transitions against active runtime use. */
export class ConversationRuntimeAccess {
  private readonly gate = new RuntimeUseGate()
  private preparing?: Promise<ContainerPort>
  private demandEpoch = 0

  constructor(private readonly options: ConversationRuntimeAccessOptions) {}

  get activeUses(): number { return this.gate.activeUses }
  get exclusivePending(): number { return this.gate.exclusivePending }
  /** Counts user demand at request time, including calls waiting for preparation. */
  get activityEpoch(): number { return this.demandEpoch }

  prepare(): Promise<ContainerPort> {
    if (!this.preparing) {
      this.preparing = this.gate.exclusive(() => this.options.prepareOwned()).finally(() => {
        this.preparing = undefined
      })
    }
    return this.preparing
  }

  /** Run a read/use operation only while its prepared port is still current. */
  async useReady<T>(operation: (port: ContainerPort) => Promise<T>): Promise<T> {
    // Demand must fence idle decisions synchronously, before prepare or gate waits.
    this.demandEpoch++

    for (;;) {
      await this.prepare()
      const captured = this.options.identity()
      let invoked = false
      let result: { matched: false } | { matched: true; value: T }
      try {
        result = await this.gate.use(async () => {
          const current = this.options.identity()
          if (!captured.ready || !captured.running || !captured.port ||
            current.ready !== true || current.running !== true ||
            current.port !== captured.port || current.generation !== captured.generation) {
            return { matched: false as const }
          }

          invoked = true
          return { matched: true as const, value: await operation(captured.port) }
        })
      } finally {
        // Completion hooks may do checkpoint work, so run them after releasing
        // the runtime resource gate.
        if (invoked) await this.options.onUseComplete?.()
      }

      if (!result.matched) continue
      return result.value
    }
  }

  /** Exclusive runtime transition. Do not call prepare/useReady from inside it. */
  exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    return this.gate.exclusive(operation)
  }
}
