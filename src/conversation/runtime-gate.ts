type Waiter = {
  kind: "use" | "exclusive"
  start: () => void
}

/**
 * Fair read/write gate for runtime operations. Uses may overlap; once a writer
 * queues, later readers wait behind it. Callers must use internal already-owned
 * methods from inside an exclusive operation instead of re-entering this gate.
 */
export class RuntimeUseGate {
  private runningUses = 0
  private runningExclusive = false
  private pendingWriters = 0
  private readonly queue: Waiter[] = []
  private epoch = 0

  get activeUses(): number {
    return this.runningUses
  }

  get exclusivePending(): number {
    return this.pendingWriters
  }

  get activityEpoch(): number {
    return this.epoch
  }

  async use<T>(operation: () => T | Promise<T>): Promise<T> {
    // This records demand, including readers that are still waiting on a writer.
    this.epoch++
    await this.acquire("use")
    try {
      return await operation()
    } finally {
      this.runningUses--
      this.drain()
    }
  }

  async exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    await this.acquire("exclusive")
    try {
      return await operation()
    } finally {
      this.runningExclusive = false
      this.drain()
    }
  }

  private acquire(kind: Waiter["kind"]): Promise<void> {
    if (kind === "use" && !this.runningExclusive && this.queue.length === 0) {
      this.runningUses++
      return Promise.resolve()
    }
    if (kind === "exclusive" && !this.runningExclusive && this.runningUses === 0 && this.queue.length === 0) {
      this.runningExclusive = true
      return Promise.resolve()
    }
    if (kind === "exclusive") this.pendingWriters++
    return new Promise<void>((resolve) => {
      this.queue.push({ kind, start: resolve })
      this.drain()
    })
  }

  private drain(): void {
    if (this.runningExclusive || this.runningUses > 0 || this.queue.length === 0) return
    const first = this.queue[0]!
    if (first.kind === "exclusive") {
      this.queue.shift()
      this.pendingWriters--
      this.runningExclusive = true
      first.start()
      return
    }
    // Admit a contiguous reader batch, stopping at the next writer fence.
    while (this.queue[0]?.kind === "use") {
      const reader = this.queue.shift()!
      this.runningUses++
      reader.start()
    }
  }
}
