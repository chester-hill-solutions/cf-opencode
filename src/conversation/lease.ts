const LEASE_TTL_MS = 10 * 60_000
const LEASE_RENEW_MS = LEASE_TTL_MS / 2
const LEASE_RETRY_MS = 30_000

export interface ConversationLeaseRecord {
  version: 1
  desired: "held" | "released"
  status: "pending" | "acknowledged"
  requestStartedAt: number
  acknowledgedUntil?: number
  errorCode?: "capacity" | "authority_unavailable" | "stopped_unconfirmed"
}

export interface LeaseSettingsPort {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>
}

export interface ConversationLeaseOptions {
  storage: DurableObjectStorage
  settings(): LeaseSettingsPort
  identity: {
    id: string
    enabled(): boolean
    confirmedStopped(): boolean
  }
  jobs: {
    schedule(at: number, reason: string): Promise<void>
    cancel(): Promise<void>
  }
}

/** Conversation-side intent and retry layer; Settings remains lease authority. */
export class ConversationLease {
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: ConversationLeaseOptions) {}

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task)
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  async status(): Promise<ConversationLeaseRecord | undefined> {
    const value = await this.options.storage.get<unknown>("containerLease")
    if (value === undefined) return undefined
    if (!isLeaseRecord(value)) throw new Error("container lease state is unreadable")
    return value
  }

  ensureHeld(): Promise<void> {
    return this.serialize(async () => {
      if (!this.options.identity.enabled()) return
      const record = await this.status()
      if (record?.desired === "released") {
        if (!(await this.releasePending(record))) throw new Error("container lease authority unavailable")
      }
      const current = await this.status()
      if (current?.desired === "held" && current.status === "acknowledged" &&
        current.acknowledgedUntil !== undefined && current.acknowledgedUntil > Date.now()) return
      await this.acquire()
    })
  }

  renew(): Promise<void> {
    return this.serialize(async () => {
      if (!this.options.identity.enabled()) return
      const record = await this.status()
      if (!record) return
      if (record.desired === "released") {
        if (!this.options.identity.confirmedStopped()) {
          await this.persistIntent({ ...record, status: "pending", errorCode: "stopped_unconfirmed" }, "lease-release-retry")
          return
        }
        await this.releasePending(record)
        return
      }
      await this.acquire()
    })
  }

  releaseAfterStop(): Promise<boolean> {
    return this.serialize(async () => {
      await this.status()
      if (!this.options.identity.confirmedStopped()) return false
      const record: ConversationLeaseRecord = {
        version: 1,
        desired: "released",
        status: "pending",
        requestStartedAt: Date.now(),
      }
      await this.persistIntent(record, "lease-release-retry")
      return this.releasePending(record)
    })
  }

  /** Retry only durable intent; a missing record never reacquires a lease. */
  maintain(): Promise<void> {
    return this.serialize(async () => {
      const record = await this.status()
      if (!record) return
      if (record.desired === "released") {
        if (this.options.identity.confirmedStopped()) await this.releasePending(record)
        else await this.persistIntent({ ...record, status: "pending", errorCode: "stopped_unconfirmed" }, "lease-release-retry")
        return
      }
      if (record.desired === "held" && this.options.identity.enabled()) await this.acquire()
    })
  }

  private async acquire(): Promise<void> {
    const requestStartedAt = Date.now()
    const pending: ConversationLeaseRecord = {
      version: 1,
      desired: "held",
      status: "pending",
      requestStartedAt,
    }
    await this.persistIntent(pending, "lease-renew-retry")
    let response: Response
    try {
      response = await this.options.settings().fetch("https://settings/leases/acquire", {
        method: "POST",
        body: JSON.stringify({ id: this.options.identity.id, ttlMs: LEASE_TTL_MS }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      await this.persistIntent({ ...pending, errorCode: "authority_unavailable" }, "lease-renew-retry")
      throw new Error("container lease authority unavailable")
    }
    if (response.status === 429) {
      await this.persistIntent({ ...pending, errorCode: "capacity" }, "lease-renew-retry")
      throw new Error("container capacity reached")
    }
    if (!response.ok || !(await acknowledges(response))) {
      await this.persistIntent({ ...pending, errorCode: "authority_unavailable" }, "lease-renew-retry")
      throw new Error("container lease authority unavailable")
    }
    await this.persistIntent({
      version: 1,
      desired: "held",
      status: "acknowledged",
      requestStartedAt,
      acknowledgedUntil: requestStartedAt + LEASE_TTL_MS,
    }, "lease-renew", requestStartedAt + LEASE_RENEW_MS)
  }

  private async releasePending(record: ConversationLeaseRecord): Promise<boolean> {
    if (!this.options.identity.confirmedStopped()) {
      await this.persistIntent({ ...record, status: "pending", errorCode: "stopped_unconfirmed" }, "lease-release-retry")
      return false
    }
    const pending: ConversationLeaseRecord = {
      ...record,
      version: 1,
      desired: "released",
      status: "pending",
      requestStartedAt: record.requestStartedAt || Date.now(),
      errorCode: undefined,
    }
    await this.persistIntent(pending, "lease-release-retry")
    let response: Response
    try {
      response = await this.options.settings().fetch("https://settings/leases/release", {
        method: "POST",
        body: JSON.stringify({ id: this.options.identity.id }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      await this.persistIntent({ ...pending, errorCode: "authority_unavailable" }, "lease-release-retry")
      return false
    }
    if (!response.ok || !(await acknowledges(response))) {
      await this.persistIntent({ ...pending, errorCode: "authority_unavailable" }, "lease-release-retry")
      return false
    }
    await this.options.storage.transaction(async (txn) => {
      await txn.delete("containerLease")
      await this.options.jobs.cancel()
    })
    return true
  }

  private async persistIntent(
    record: ConversationLeaseRecord,
    reason: string,
    at = Date.now() + LEASE_RETRY_MS,
  ): Promise<void> {
    await this.options.storage.transaction(async (txn) => {
      await txn.put("containerLease", record)
      await this.options.jobs.schedule(at, reason)
    })
  }
}

async function acknowledges(response: Response): Promise<boolean> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return false
  }
  return Boolean(body && typeof body === "object" && !Array.isArray(body) &&
    (body as { ok?: unknown }).ok === true)
}

function isLeaseRecord(value: unknown): value is ConversationLeaseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const validError = record.errorCode === undefined || record.errorCode === "capacity" ||
    record.errorCode === "authority_unavailable" || record.errorCode === "stopped_unconfirmed"
  const validUntil = record.acknowledgedUntil === undefined ||
    (typeof record.acknowledgedUntil === "number" && Number.isFinite(record.acknowledgedUntil) &&
      record.acknowledgedUntil >= (record.requestStartedAt as number))
  return record.version === 1 && (record.desired === "held" || record.desired === "released") &&
    (record.status === "pending" || record.status === "acknowledged") &&
    typeof record.requestStartedAt === "number" && Number.isFinite(record.requestStartedAt) &&
    record.requestStartedAt >= 0 && validError && validUntil &&
    !(record.desired === "held" && record.status === "acknowledged" &&
      (typeof record.acknowledgedUntil !== "number" || !Number.isFinite(record.acknowledgedUntil)))
}
