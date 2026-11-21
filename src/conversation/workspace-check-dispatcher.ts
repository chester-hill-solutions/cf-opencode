import type { ConversationWorkspaceChecks } from "./workspace-checks"
import { readWorkspaceCheckBytes } from "./workspace-checks"
import type { ConversationCheckpoints } from "./checkpoints"
import type { SlackTarget } from "../state"
import { archiveMetadata } from "./archive-keys"
import { encryptBytes } from "../archive-crypto"
import { parseWorkspaceCheckArgv, sameWorkspaceCheckRequest, WorkspaceCheckValidationError } from "../workspace-check"
import {
  CHECK_UUID, parseWorkspaceCheckCollectorClaim, parseWorkspaceCheckCollectorClaimRequest,
  parseWorkspaceCheckCollectorCompletion, parseWorkspaceCheckExecution, WorkspaceCheckDispatchError,
  type WorkspaceCheckExecution, type WorkspaceCheckCollectorClaimRequest,
} from "../workspace-check-dispatch"

const PREFIX = "workspaceCheckExecution:"
const encoder = new TextEncoder()
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } })
class DispatchError extends Error { constructor(readonly code: string, readonly status = 409) { super(code) } }
async function digest(value: string | Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", typeof value === "string" ? encoder.encode(value) : new Uint8Array(value)))].map(byte => byte.toString(16).padStart(2, "0")).join("")
}
function bytes(value: string): Uint8Array { return Uint8Array.from(atob(value), char => char.charCodeAt(0)) }
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DispatchError("CHECK_STORAGE_TIMEOUT", 503)), 30_000) })]) }
  finally { if (timer) clearTimeout(timer) }
}
function unresolved(execution: WorkspaceCheckExecution): boolean {
  return execution.cleanupReconciledAt === null && (execution.status === "claimed" || execution.receipt?.cleanupConfirmed === false)
}
interface Options {
  storage: DurableObjectStorage
  id: string
  key(): string
  checks: ConversationWorkspaceChecks
  bucket: R2Bucket
  checkpoints: Pick<ConversationCheckpoints, "cryptoKey" | "decryptBody" | "keyId">
  admission<T>(operation: () => Promise<T>): Promise<T>
  config(): { collectorID: string; imageID: string; timeoutMs: number; platform: "linux/amd64" | "linux/arm64" }
  register(): Promise<void>
  schedule(at: number): Promise<void>
  notify(target: SlackTarget, text: string): Promise<boolean>
}

/** Separate authorization/attempt/outbox state; exported intents never become run receipts. */
export class ConversationWorkspaceCheckDispatcher {
  constructor(private readonly options: Options) {}
  private key(id: string): string { return PREFIX + id }
  private async rows(): Promise<WorkspaceCheckExecution[]> {
    return [...(await this.options.storage.list({ prefix: PREFIX, limit: 11 })).values()].map(parseWorkspaceCheckExecution)
  }
  async get(id: string): Promise<WorkspaceCheckExecution | undefined> {
    const value = await this.options.storage.get(this.key(id))
    return value === undefined ? undefined : parseWorkspaceCheckExecution(value)
  }
  async hasUnresolved(): Promise<boolean> { return (await this.rows()).some(row => row.status === "queued" || unresolved(row) || row.notification.status === "pending") }

  async queue(argvValue: string[], target: SlackTarget, eventID: string | undefined): Promise<string> {
    const argv = parseWorkspaceCheckArgv(argvValue), config = this.options.config()
    if (!eventID || eventID.length > 512) throw new DispatchError("CHECK_EVENT_ID_REQUIRED", 400)
    const hash = await digest(`${this.options.key()}\0${eventID}`)
    const requestID = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
    let intent = await this.options.checks.get(requestID)
    if (intent && (JSON.stringify(intent.argv) !== JSON.stringify(argv) || intent.imageID !== config.imageID || intent.timeoutMs !== config.timeoutMs)) throw new DispatchError("CHECK_REQUEST_CONFLICT")
    // Discovery must be durable before execution is authorized, including Slack retries.
    await this.options.register()
    if (!intent) {
      const head = await this.options.checks.currentHead()
      const exported = await this.options.checks.create({ requestID, expectedBindingID: head.binding.bindingID, commitOID: head.commit,
        argv, imageID: config.imageID, timeoutMs: config.timeoutMs })
      if (!exported.ok) throw new DispatchError("CHECK_EXPORT_REFUSED", exported.status)
      intent = await this.options.checks.get(requestID)
    } else if (intent.status !== "exported") {
      const exported = await this.options.checks.create(intent)
      if (!exported.ok) throw new DispatchError("CHECK_EXPORT_REFUSED", exported.status)
      intent = await this.options.checks.get(requestID)
    }
    if (!intent || intent.status !== "exported") throw new DispatchError("CHECK_EXPORT_UNAVAILABLE", 503)
    const selected = intent
    const execution = await this.options.admission(async () => {
      const retained = await this.options.checks.get(requestID)
      if (!retained || JSON.stringify(retained) !== JSON.stringify(selected)) throw new DispatchError("CHECK_REQUEST_CONFLICT")
      const prior = await this.get(requestID)
      if (prior) {
        if (JSON.stringify(prior.target) !== JSON.stringify(target)) throw new DispatchError("CHECK_TARGET_CONFLICT")
        return prior
      }
      const row = parseWorkspaceCheckExecution({ schemaVersion: 1, requestID, status: "queued", queuedAt: Date.now(), target,
        attempt: null, receipt: null, completedAt: null, completionSHA256: null, cleanupReconciledAt: null, logs: null,
        notification: { status: "not_requested", attempts: 0, nextAttemptAt: 0 } })
      await this.options.storage.put(this.key(requestID), row)
      return row
    })
    return `Check ${execution.requestID} ${execution.status}. This checks the frozen committed tree only; working edits, baseline checks and test/config changes are unverified.`
  }

  async status(): Promise<string> {
    const rows = await this.rows()
    if (!rows.length) return "No checks have been queued for this conversation."
    return rows.sort((a, b) => b.queuedAt - a.queuedAt).map(row =>
      `Check ${row.requestID}: ${row.receipt?.outcome ?? row.status}${unresolved(row) ? "; cleanup/attempt unresolved" : row.cleanupReconciledAt ? "; absence observed, original result retained" : ""}. Committed tree only; working edits unverified.`).join("\n")
  }

  private async claim(request: WorkspaceCheckCollectorClaimRequest): Promise<unknown> {
    const config = this.options.config()
    if (request.collectorID !== config.collectorID) throw new DispatchError("CHECK_COLLECTOR_MISMATCH", 403)
    return this.options.admission(async () => {
      const rows = await this.rows()
      const prior = rows.find(row => row.attempt?.collectorID === request.collectorID && row.attempt.claimRequestID === request.claimRequestID)
      let row: WorkspaceCheckExecution
      if (prior) row = prior
      else {
        if (request.imageID !== config.imageID) throw new DispatchError("CHECK_COLLECTOR_MISMATCH", 403)
        if (rows.some(unresolved)) throw new DispatchError("CHECK_ATTEMPT_UNRESOLVED")
        let next: WorkspaceCheckExecution | undefined
        for (const queued of rows.filter(row => row.status === "queued").sort((a, b) => a.queuedAt - b.queuedAt)) {
          const candidate = await this.options.checks.get(queued.requestID)
          if (!candidate || candidate.status !== "exported") throw new DispatchError("CHECK_SOURCE_UNAVAILABLE", 503)
          if (candidate.imageID === request.imageID) { next = queued; break }
        }
        if (!next) return null
        row = parseWorkspaceCheckExecution({ ...next, status: "claimed", attempt: { attemptID: crypto.randomUUID(), collectorID: request.collectorID,
          claimRequestID: request.claimRequestID, claimedAt: Date.now() } })
        // Persist before releasing an execution authorization to an external host.
        await this.options.storage.put(this.key(row.requestID), row)
      }
      const intent = await this.options.checks.get(row.requestID)
      if (!intent || intent.status !== "exported") throw new DispatchError("CHECK_SOURCE_UNAVAILABLE", 503)
      return parseWorkspaceCheckCollectorClaim({ ...request, attemptID: row.attempt!.attemptID, conversationKey: this.options.key(), workspaceCheck: intent })
    })
  }

  private async attempt(id: string): Promise<WorkspaceCheckExecution> {
    const row = (await this.rows()).find(row => row.attempt?.attemptID === id)
    if (!row || row.attempt?.collectorID !== this.options.config().collectorID) throw new DispatchError("CHECK_ATTEMPT_NOT_FOUND", 404)
    return row
  }

  private async complete(value: unknown, id: string): Promise<WorkspaceCheckExecution> {
    const completion = parseWorkspaceCheckCollectorCompletion(value)
    const completionSHA256 = await digest(JSON.stringify(completion))
    return this.options.admission(async () => {
      const row = await this.attempt(id), intent = await this.options.checks.get(row.requestID)
      if (completion.attemptID !== id || completion.collectorID !== row.attempt!.collectorID || completion.claimRequestID !== row.attempt!.claimRequestID) throw new DispatchError("CHECK_ATTEMPT_CONFLICT")
      if (row.status === "completed") {
        if (row.completionSHA256 !== completionSHA256) throw new DispatchError("CHECK_COMPLETION_CONFLICT")
        // Republish a missing wake safely; this never re-authorizes Docker execution.
        if (row.notification.status === "pending") await this.options.schedule(Date.now())
        return row
      }
      if (row.cleanupReconciledAt !== null) throw new DispatchError("CHECK_ATTEMPT_RECONCILED")
      const receipt = completion.receipt
      if (!intent?.source || !sameWorkspaceCheckRequest(receipt.request, intent) || JSON.stringify(receipt.binding) !== JSON.stringify(intent.binding) ||
        receipt.treeOID !== intent.source.treeOID || receipt.sourceSHA256 !== intent.source.sourceSHA256 || receipt.platform !== this.options.config().platform ||
        receipt.startedAt < row.attempt!.claimedAt - 60_000 || receipt.finishedAt > Date.now() + 60_000 ||
        receipt.finishedAt - receipt.startedAt > intent.timeoutMs + 180_000 || (receipt.outcome === "passed" && receipt.freshness.before !== "matched")) throw new DispatchError("CHECK_RECEIPT_CONFLICT")
      for (const name of ["stdout", "stderr"] as const) {
        const captured = bytes(completion.logs[`${name}Base64`])
        if (captured.length !== receipt.logs[name].capturedBytes || await digest(captured) !== receipt.logs[name].sha256) throw new DispatchError("CHECK_LOG_CONFLICT")
      }
      const key = await this.options.checkpoints.cryptoKey()
      if (!key) throw new DispatchError("CHECK_ENCRYPTION_REQUIRED", 503)
      const logJSON = JSON.stringify(completion.logs), logsSHA256 = await digest(logJSON)
      const logKey = `workspaces/${this.options.id}/checks/${row.requestID}/${id}.logs.json`
      const existing = await bounded(this.options.bucket.get(logKey))
      if (existing) {
        if (existing.customMetadata?.encrypted !== "1" || existing.customMetadata.completionSHA256 !== completionSHA256 || existing.size > 200_000) {
          try { void existing.body.cancel().catch(() => {}) } catch {}
          throw new DispatchError("CHECK_LOG_UNAVAILABLE", 503)
        }
        const clear = await this.options.checkpoints.decryptBody(existing.body, true, existing.customMetadata)
        if (await digest(await readWorkspaceCheckBytes(clear, 180_000)) !== logsSHA256) throw new DispatchError("CHECK_LOG_UNAVAILABLE", 503)
      } else {
        const cipher = await encryptBytes(encoder.encode(logJSON), key)
        await bounded(this.options.bucket.put(logKey, cipher, { customMetadata: archiveMetadata({ encrypted: "1", kind: "workspace-check-logs", completionSHA256 }, await this.options.checkpoints.keyId()) }))
      }
      const next = parseWorkspaceCheckExecution({ ...row, status: "completed", receipt, completedAt: Date.now(), completionSHA256,
        logs: { key: logKey, sha256: logsSHA256 }, notification: { ...row.notification, status: row.target ? "pending" : "not_requested", nextAttemptAt: Date.now() } })
      await this.options.storage.transaction(async txn => {
        await txn.put(this.key(row.requestID), next)
        if (next.target) await this.options.schedule(Date.now())
      })
      return next
    })
  }

  private async reconcile(value: unknown, id: string): Promise<WorkspaceCheckExecution> {
    const raw = value as Record<string, unknown>
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== 4 || raw.attemptID !== id || raw.cleanupConfirmed !== true ||
      typeof raw.collectorID !== "string" || !CHECK_UUID.test(raw.collectorID) || typeof raw.claimRequestID !== "string" || !CHECK_UUID.test(raw.claimRequestID)) throw new WorkspaceCheckDispatchError()
    return this.options.admission(async () => {
      const row = await this.attempt(id)
      if (row.attempt!.collectorID !== raw.collectorID || row.attempt!.claimRequestID !== raw.claimRequestID) throw new DispatchError("CHECK_ATTEMPT_CONFLICT")
      if (!unresolved(row) && row.cleanupReconciledAt === null) throw new DispatchError("CHECK_NOT_UNRESOLVED")
      const next = parseWorkspaceCheckExecution({ ...row, cleanupReconciledAt: row.cleanupReconciledAt ?? Date.now() })
      await this.options.storage.put(this.key(row.requestID), next)
      return next
    })
  }

  /** Collector-only routes, reached only after the entrypoint's separate capability check. */
  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname.slice("/workspace/check-collector".length)
      if (path === "/pending" && request.method === "GET") {
        const pending = await Promise.all((await this.rows()).filter(row => row.status === "queued" || unresolved(row)).map(async row => {
          const intent = await this.options.checks.get(row.requestID)
          if (!intent) throw new DispatchError("CHECK_SOURCE_UNAVAILABLE", 503)
          return {
          conversationKey: this.options.key(), requestID: row.requestID, imageID: intent.imageID, queuedAt: row.queuedAt,
          status: row.status === "queued" ? "queued" : "claimed", attemptID: row.attempt?.attemptID ?? null,
          collectorID: row.attempt?.collectorID ?? null, claimRequestID: row.attempt?.claimRequestID ?? null,
        } }))
        return response({ pending })
      }
      if (path === "/claim" && request.method === "POST") return response({ claim: await this.claim(parseWorkspaceCheckCollectorClaimRequest(await request.json())) })
      const match = /^\/attempts\/([a-f0-9-]+)\/(source|freshness|complete|reconcile)$/.exec(path)
      if (!match || !CHECK_UUID.test(match[1]!)) throw new DispatchError("CHECK_ROUTE_NOT_FOUND", 404)
      const id = match[1]!, operation = match[2]!
      if (operation === "complete" || operation === "reconcile") {
        if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } })
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await readWorkspaceCheckBytes(request.body, 200_000)))
        return response({ execution: operation === "complete" ? await this.complete(value, id) : await this.reconcile(value, id) })
      }
      if (request.method !== "GET") return new Response("method not allowed", { status: 405, headers: { allow: "GET" } })
      const row = await this.attempt(id)
      return this.options.checks.fetch(new Request(`https://conversation/workspace/checks/${row.requestID}/${operation}`))
    } catch (error) {
      const status = error instanceof DispatchError ? error.status : error instanceof WorkspaceCheckDispatchError || error instanceof WorkspaceCheckValidationError || error instanceof SyntaxError ? 400 : 503
      return response({ error: "Workspace check collector operation could not be completed.", code: error instanceof DispatchError ? error.code : "CHECK_COLLECTOR_UNAVAILABLE" }, status)
    }
  }

  /** Delivery outbox retries do not re-enter claim, export or execution. */
  async notify(): Promise<{ rescheduleAt: number } | undefined> {
    let earliest = Infinity
    for (const saved of await this.rows()) {
      if (saved.notification.status !== "pending" || !saved.target || !saved.receipt) continue
      if (saved.notification.nextAttemptAt > Date.now()) { earliest = Math.min(earliest, saved.notification.nextAttemptAt); continue }
      const selected = await this.options.admission(async () => {
        const current = await this.get(saved.requestID)
        if (current?.notification.status !== "pending") return undefined
        const next = parseWorkspaceCheckExecution({ ...current, notification: { ...current.notification,
          attempts: Math.min(32, current.notification.attempts + 1), nextAttemptAt: Date.now() + Math.min(300_000, 5000 * 2 ** Math.min(6, current.notification.attempts)) } })
        await this.options.storage.put(this.key(next.requestID), next)
        return next
      })
      if (!selected?.target || !selected.receipt) continue
      const receipt = selected.receipt
      const text = `Check ${selected.requestID}: ${receipt.outcome}. Commit ${receipt.request.commitOID.slice(0, 12)}. Cleanup ${receipt.cleanupConfirmed || selected.cleanupReconciledAt ? "confirmed" : "UNKNOWN"}; HEAD after check ${receipt.freshness.after}. Committed tree only; working edits unverified; baseline checks not run; test/config changes not evaluated.`
      let sent = false
      try { sent = await this.options.notify(selected.target, text) } catch {}
      if (sent) await this.options.admission(async () => {
        const current = await this.get(selected.requestID)
        if (current?.completionSHA256 === selected.completionSHA256 && current.notification.status === "pending") {
          await this.options.storage.put(this.key(current.requestID), { ...current, notification: { ...current.notification, status: "delivered" } })
        }
      })
      else earliest = Math.min(earliest, selected.notification.nextAttemptAt)
    }
    return Number.isFinite(earliest) ? { rescheduleAt: earliest } : undefined
  }

  async clear(): Promise<void> { for (const key of (await this.options.storage.list({ prefix: PREFIX })).keys()) await this.options.storage.delete(key) }
}
