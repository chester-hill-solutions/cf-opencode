import type { TaskJournal } from "./journal"

export type OperationResult = { status: string; text?: string; reason?: string }
export interface HarnessPort {
  submit(prompt: string, options: { operationId: string }): Promise<unknown>
  wait(id: string, options: { signal: AbortSignal }): Promise<OperationResult>
  abort(): Promise<unknown>
  dispose(): Promise<void>
}
export interface ContainerPort { destroy(): Promise<void>; running(): boolean }

async function confirmedWithin(operation: () => Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(operation).then(() => true, () => false),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs) }),
    ])
  } finally { if (timer) clearTimeout(timer) }
}

/** Actor orchestration, separate from platform construction so races can be reproduced. */
export class TaskRuntime {
  private readonly handoffs = new Set<Promise<unknown>>()
  private closing: Promise<void> | undefined
  constructor(private readonly journal: TaskJournal, private readonly start: () => Promise<unknown>, private readonly harness: HarnessPort | null, private readonly controller = new AbortController(), private readonly keepAlive: (work: Promise<unknown>) => void = work => { void work.catch(() => {}) }, private readonly disableWakeups: () => Promise<void> = async () => {}) {}
  get signal(): AbortSignal { return this.controller.signal }

  private handoff<T>(operation: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(() => { this.signal.throwIfAborted(); return operation() })
    this.handoffs.add(pending)
    void pending.then(() => this.handoffs.delete(pending), () => this.handoffs.delete(pending))
    return pending
  }

  prime(): Promise<void> {
    return this.handoff(async () => { await this.start(); this.signal.throwIfAborted() })
  }

  prepare(operation: (signal: AbortSignal) => Promise<void>): Promise<void> {
    return this.handoff(async () => { await operation(this.signal); this.signal.throwIfAborted() })
  }

  submit(prompt: string, id: string): Promise<void> {
    return this.handoff(async () => {
      await this.start(); this.signal.throwIfAborted()
      if (!this.harness) throw new Error("task configuration unavailable")
      await this.harness.submit(prompt, { operationId: id })
      this.signal.throwIfAborted()
      await this.journal.acknowledgeSubmission()
    })
  }

  wait(id: string, timeoutMs: number): Promise<"settled" | "submission-unconfirmed" | "inactive"> {
    return this.handoff(() => this.waitResult(id, timeoutMs))
  }

  private async waitResult(id: string, timeoutMs: number): Promise<"settled" | "submission-unconfirmed" | "inactive"> {
    this.signal.throwIfAborted()
    if (!this.harness) throw new Error("task configuration unavailable")
    const before = await this.journal.store.read()
    this.signal.throwIfAborted()
    if (before?.phase !== "running") return "inactive"
    const result = await this.harness.wait(id, { signal: AbortSignal.any([this.signal, AbortSignal.timeout(timeoutMs)]) })
    this.signal.throwIfAborted()
    const receipt = await this.journal.store.read()
    if (result.reason === "not_found") {
      // A result can be delivered after a concurrent admission finishes. Judge
      // disappearance against acceptance at query start, not at delivery time.
      if (receipt?.phase === "running" && before.submission === "accepted") await this.journal.fail("accepted SDK operation not found; outcome unconfirmed")
      return "submission-unconfirmed"
    }
    if (receipt?.phase !== "running") return "inactive"
    await this.journal.settle(result.status, result.text)
    return "settled"
  }

  async observe(id: string) {
    await this.prime()
    return this.wait(id, 1000)
  }

  async cleanup(container: ContainerPort, timeoutMs = 5000) {
    this.controller.abort()
    // Neither storage nor the SDK may prevent an owned container-stop attempt.
    const containerStop = confirmedWithin(async () => {
      await container.destroy()
      if (container.running()) throw new Error("container stop unconfirmed")
    }, timeoutMs)
    const fence = confirmedWithin(() => this.journal.fail("cleanup requested; runtime stop not yet confirmed"), timeoutMs)
    if (!this.closing) {
      const flight = this.closeCoordinator([...this.handoffs], timeoutMs)
      this.closing = flight
      // Keep the underlying close, not just its bounded observer, alive. Retries
      // observe this same flight while any earlier SDK work remains pending.
      this.keepAlive(flight.catch(() => {}))
      void flight.catch(() => { if (this.closing === flight) this.closing = undefined })
    }
    const closing = this.closing
    const coordinatorStop = confirmedWithin(() => closing, timeoutMs * 3)
    const [runtimeStopped, coordinatorDisposed, fenceRecorded] = await Promise.all([containerStop, coordinatorStop, fence])
    const cleanupRecorded = runtimeStopped && await confirmedWithin(() => this.journal.cleaned(coordinatorDisposed), timeoutMs)
    return { runtimeStopped, coordinatorDisposed, cleanupRecorded, stopFenceRecorded: fenceRecorded || cleanupRecorded, providerStop: "unproven" as const, receiptRetained: true as const }
  }

  private async closeCoordinator(pending: Promise<unknown>[], timeoutMs: number): Promise<void> {
    const abort = Promise.resolve().then(() => this.harness?.abort())
    await confirmedWithin(() => abort, timeoutMs)
    // Attempt disposal even when cancellation stalls; retain both operations.
    const dispose = Promise.resolve().then(() => this.harness?.dispose())
    await confirmedWithin(() => dispose, timeoutMs)
    await Promise.allSettled([...pending, abort, dispose])
    // A late startup/abort could reopen SDK state after the early disposal.
    // Only this final close, after every earlier operation settled, proves it.
    await this.harness?.dispose()
    await this.disableWakeups()
  }
}
