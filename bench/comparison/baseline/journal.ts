export type TaskIdentity = {
  id: string
  taskID: string
  protocolSHA256: string
  condition: "cold" | "warm"
  repetition: number
  configSHA256: string
}

export type ToolReceipt = {
  id: string
  name: string
  inputSHA256: string
  status: "started" | "done" | "error" | "uncertain"
  output: string | null
  outputBytes: number | null
}

export type TaskReceipt = {
  schemaVersion: 1
  identity: TaskIdentity
  phase: "preparing" | "ready" | "running" | "done" | "failed" | "ambiguous"
  startedAt: number
  readyAt: number | null
  runningAt: number | null
  finishedAt: number | null
  operationID: string
  submission: "pending" | "accepted"
  tools: ToolReceipt[]
  modelCalls: Array<{ id: number; finished: boolean; inputTokens: number | null; outputTokens: number | null }>
  result: { status: string; text: string } | null
  failure: string | null
  cleanup: "pending" | "stopped"
  cleanupCoordinatorDisposed: boolean | null
  modelUSD: null
  oraclePassed: null
}

/** The callback must run atomically against the single attempt document. */
export interface JournalStore {
  read(): Promise<TaskReceipt | null>
  change<T>(update: (current: TaskReceipt | null) => { next: TaskReceipt; result: T }): Promise<T>
}

export async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("")
}

function current(receipt: TaskReceipt | null): TaskReceipt {
  if (!receipt) throw new Error("attempt is not admitted")
  return receipt
}

function runnable(receipt: TaskReceipt | null): TaskReceipt {
  const value = current(receipt)
  if (value.phase !== "running" || value.cleanup !== "pending") throw new Error("attempt is not running")
  return value
}

/** Started effects are deliberately never replayed after an ambiguous interruption. */
export class TaskJournal {
  constructor(readonly store: JournalStore) {}

  async admit(identity: TaskIdentity): Promise<boolean> {
    return this.store.change(receipt => {
      if (receipt) {
        if (JSON.stringify(receipt.identity) !== JSON.stringify(identity)) throw new Error("attempt identity conflict")
        return { next: receipt, result: false }
      }
      return { next: { schemaVersion: 1, identity, phase: "preparing", startedAt: Date.now(), readyAt: null, runningAt: null, finishedAt: null,
        operationID: identity.id, submission: "pending", tools: [], modelCalls: [], result: null, failure: null, cleanup: "pending", cleanupCoordinatorDisposed: null, modelUSD: null, oraclePassed: null }, result: true }
    })
  }

  async transition(from: TaskReceipt["phase"], to: TaskReceipt["phase"]): Promise<void> {
    await this.store.change(receipt => {
      const next = current(receipt)
      if (next.phase !== from || next.cleanup !== "pending") throw new Error("attempt phase conflict")
      next.phase = to
      if (to === "ready") next.readyAt = Date.now()
      if (to === "running") next.runningAt = Date.now()
      return { next, result: undefined }
    })
  }

  async beginTool(id: string, name: string, inputSHA256: string): Promise<string | null> {
    return this.store.change(receipt => {
      const next = runnable(receipt), existing = next.tools.find(tool => tool.id === id)
      if (existing) {
        if (existing.name !== name || existing.inputSHA256 !== inputSHA256) throw new Error("tool identity conflict")
        if (existing.status !== "done" || existing.output === null) throw new Error("tool outcome ambiguous; replay refused")
        return { next, result: existing.output }
      }
      if (next.tools.length >= 64 || id.length > 200) throw new Error("tool receipt limit exceeded")
      next.tools.push({ id, name, inputSHA256, status: "started", output: null, outputBytes: null })
      return { next, result: null }
    })
  }

  async finishTool(id: string, output: string | null, uncertain = false): Promise<void> {
    await this.store.change(receipt => {
      const next = current(receipt), tool = next.tools.find(tool => tool.id === id)
      if (!tool || tool.status !== "started") throw new Error("tool completion conflict")
      const bytes = output === null ? null : new TextEncoder().encode(output).length
      const cachedBytes = next.tools.reduce((sum, row) => sum + (row.output === null ? 0 : row.outputBytes ?? 0), 0)
      tool.status = uncertain ? "uncertain" : output === null ? "error" : "done"
      tool.outputBytes = bytes
      // Bound the durable document; an uncached result is never executed again.
      tool.output = output !== null && bytes !== null && cachedBytes + bytes <= 49_152 ? output : null
      if (uncertain) {
        next.phase = "ambiguous"; next.failure = "tool outcome or process stop unconfirmed; automatic continuation refused"; next.finishedAt = Date.now()
      }
      return { next, result: undefined }
    })
  }

  async beginModel(limit: number): Promise<number> {
    return this.store.change(receipt => {
      const next = runnable(receipt)
      if (next.tools.some(tool => tool.status === "started" || tool.status === "uncertain")) throw new Error("unsettled tool effect; model continuation refused")
      if (next.modelCalls.some(call => !call.finished)) throw new Error("unknown prior model usage; automatic continuation refused")
      if (next.modelCalls.length >= limit) throw new Error("model call limit exceeded; this is not a dollar cap")
      const id = next.modelCalls.length
      next.modelCalls.push({ id, finished: false, inputTokens: null, outputTokens: null })
      return { next, result: id }
    })
  }

  async finishModel(id: number, inputTokens: number | undefined, outputTokens: number | undefined): Promise<void> {
    const amount = (value: number | undefined) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null
    await this.store.change(receipt => {
      const next = current(receipt), call = next.modelCalls[id]
      if (!call || call.finished) throw new Error("model completion conflict")
      call.finished = true; call.inputTokens = amount(inputTokens); call.outputTokens = amount(outputTokens)
      return { next, result: undefined }
    })
  }

  async settle(status: string, text = ""): Promise<void> {
    await this.store.change(receipt => {
      const next = runnable(receipt)
      const uncertain = next.tools.some(tool => tool.status === "started" || tool.status === "uncertain") || next.modelCalls.some(call => !call.finished)
      next.phase = uncertain ? "ambiguous" : status === "done" ? "done" : "failed"
      next.submission = "accepted"
      if (uncertain) next.failure = "terminal answer observed with unsettled effects or usage"
      next.result = { status, text: text.slice(0, 8192) }; next.finishedAt = Date.now()
      return { next, result: undefined }
    })
  }

  async fail(stage: string): Promise<void> {
    await this.store.change(receipt => {
      const next = current(receipt)
      if (next.phase === "done" || next.phase === "failed" || next.phase === "ambiguous") return { next, result: undefined }
      const uncertain = next.phase === "running" || next.tools.some(tool => tool.status === "started")
      next.phase = uncertain ? "ambiguous" : "failed"
      next.failure = stage; next.finishedAt = Date.now()
      return { next, result: undefined }
    })
  }

  async acknowledgeSubmission(): Promise<void> {
    await this.store.change(receipt => {
      const next = current(receipt)
      if (next.submission !== "accepted") { runnable(next); next.submission = "accepted" }
      return { next, result: undefined }
    })
  }

  async cleaned(coordinatorDisposed = true): Promise<void> {
    await this.store.change(receipt => {
      const next = current(receipt)
      if (["preparing", "ready", "running"].includes(next.phase)) { next.phase = "ambiguous"; next.failure = "cleanup requested before terminal observation"; next.finishedAt = Date.now() }
      next.cleanup = "stopped"
      next.cleanupCoordinatorDisposed = coordinatorDisposed
      return { next, result: undefined }
    })
  }
}
