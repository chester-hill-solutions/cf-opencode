import type { ContainerPort } from "../opencode"
import type { ConversationStore } from "../state"
import type { ConversationCheckpoints } from "./checkpoints"
import { archiveMetadata } from "./archive-keys"
import { encryptBytes } from "../archive-crypto"
import {
  parseWorkspaceCheckIntent, parseWorkspaceCheckRequest, sameWorkspaceCheckRequest, workspaceCheckRequestSHA256,
  WorkspaceCheckValidationError, type WorkspaceCheckIntent, type WorkspaceCheckRequest,
} from "../workspace-check"
import { parseWorkspaceRepositoryReceipt } from "../workspace-repository"
import { verifyWorkspaceCheckSnapshot, type VerifiedWorkspaceCheckSnapshot } from "../workspace-check-snapshot"

const ROW_PREFIX = "workspaceCheck:"
const MAX_INTENTS = 10
const MAX_SOURCE_BYTES = 4 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

class CheckError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}

interface WorkspaceChecksOptions {
  id: string
  storage: DurableObjectStorage
  store: ConversationStore
  bucket: R2Bucket
  checkpoints: Pick<ConversationCheckpoints, "cryptoKey" | "decryptBody" | "keyId">
  admission<T>(operation: () => Promise<T>): Promise<T>
  usage<T>(operation: () => Promise<T>): Promise<T>
  isWarm(): boolean
  useWarmRuntime<T>(operation: () => Promise<T>): Promise<T>
  control(): ContainerPort
  blocked(): Promise<boolean>
}

function reply(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } })
}

function cancel(stream: ReadableStream<Uint8Array> | null): void { try { void stream?.cancel().catch(() => {}) } catch {} }

async function within<T>(operation: Promise<T>, timeoutMs = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CheckError(503, "WORKSPACE_CHECK_SOURCE_TIMEOUT")), timeoutMs)
    })])
  } finally { if (timer) clearTimeout(timer) }
}

/** Total body deadline; tests may lower, never raise, the production limit. */
export async function readWorkspaceCheckBytes(stream: ReadableStream<Uint8Array> | null, limit: number, timeoutMs = 30_000): Promise<Uint8Array> {
  if (!stream) throw new CheckError(503, "WORKSPACE_CHECK_SOURCE_UNAVAILABLE")
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CheckError(503, "WORKSPACE_CHECK_SOURCE_TIMEOUT")), Math.min(timeoutMs, 30_000))
  })
  // The same deadline is shared by every read, so trickled bytes cannot renew it.
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), deadline])
      if (part.done) break
      size += part.value.byteLength
      if (size > limit) throw new CheckError(413, "WORKSPACE_CHECK_SIZE_LIMIT")
      parts.push(part.value)
    }
  } catch (error) {
    try { void reader.cancel().catch(() => {}) } catch {}
    throw error
  } finally { if (timer) clearTimeout(timer); try { reader.releaseLock() } catch {} }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
  return bytes
}

async function readJSON(stream: ReadableStream<Uint8Array> | null, limit: number, timeoutMs = 30_000): Promise<unknown> {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await readWorkspaceCheckBytes(stream, limit, timeoutMs)))
}

/** Immutable export intents only. This module never executes or accepts check results. */
export class ConversationWorkspaceChecks {
  constructor(private readonly options: WorkspaceChecksOptions) {}

  private key(id: string): string { return `${ROW_PREFIX}${id}` }
  private sourceKey(id: string): string { return `workspaces/${this.options.id}/checks/${id}.json` }

  async get(id: string): Promise<WorkspaceCheckIntent | undefined> {
    const value = await this.options.storage.get<unknown>(this.key(id))
    if (value === undefined) return undefined
    let intent: WorkspaceCheckIntent
    try { intent = parseWorkspaceCheckIntent(value) }
    catch { throw new CheckError(503, "WORKSPACE_CHECK_STATE_UNAVAILABLE") }
    if (intent.requestID !== id) throw new CheckError(503, "WORKSPACE_CHECK_STATE_UNAVAILABLE")
    return intent
  }

  private async eligible(bindingID: string): Promise<WorkspaceCheckIntent["binding"]> {
    const state = await this.options.store.get()
    let binding: WorkspaceCheckIntent["binding"]
    try { binding = parseWorkspaceRepositoryReceipt(state.workspaceRepository) }
    catch { throw new CheckError(409, "WORKSPACE_CHECK_REQUIRES_BOUND_REPOSITORY") }
    if (binding.bindingID !== bindingID) throw new CheckError(409, "WORKSPACE_CHECK_BINDING_CONFLICT")
    if (await this.options.blocked() || (state.phase ?? "idle") !== "idle" || state.budgetReservation ||
      state.queue?.length || Object.keys(state.pending).length || state.checkpointPending || state.lifecycleJobsSealed) {
      throw new CheckError(409, "WORKSPACE_CHECK_WORKSPACE_BUSY")
    }
    return binding
  }

  private matchSource(intent: WorkspaceCheckIntent, source: VerifiedWorkspaceCheckSnapshot): void {
    if (JSON.stringify(source.workspaceRepository) !== JSON.stringify(intent.binding) || source.commit !== intent.commitOID ||
      (intent.source && (intent.source.treeOID !== source.tree || intent.source.sourceSHA256 !== source.snapshotSHA256))) {
      throw new CheckError(409, "WORKSPACE_CHECK_SOURCE_CONFLICT")
    }
  }

  private async storedSource(intent: WorkspaceCheckIntent): Promise<VerifiedWorkspaceCheckSnapshot | undefined> {
    const object = await within(this.options.bucket.get(this.sourceKey(intent.requestID)))
    if (!object) return undefined
    const metadata = object.customMetadata
    if (object.size > MAX_SOURCE_BYTES + 128 * 1024 || metadata?.encrypted !== "1" || metadata.kind !== "workspace-check-source" ||
      metadata.requestID !== intent.requestID || metadata.requestSHA256 !== await workspaceCheckRequestSHA256(intent)) {
      cancel(object.body)
      throw new CheckError(503, "WORKSPACE_CHECK_SOURCE_UNAVAILABLE")
    }
    try {
      const clear = await this.options.checkpoints.decryptBody(object.body, true, metadata)
      const source = await verifyWorkspaceCheckSnapshot(await readJSON(clear, MAX_SOURCE_BYTES))
      this.matchSource(intent, source)
      if (metadata.sourceSHA256 !== source.snapshotSHA256) throw new Error("source digest mismatch")
      return source
    } catch { throw new CheckError(503, "WORKSPACE_CHECK_SOURCE_UNAVAILABLE") }
  }

  private async exported(intent: WorkspaceCheckIntent, source: VerifiedWorkspaceCheckSnapshot): Promise<WorkspaceCheckIntent> {
    this.matchSource(intent, source)
    return this.options.storage.transaction(async txn => {
      const current = parseWorkspaceCheckIntent(await txn.get(this.key(intent.requestID)))
      if (!sameWorkspaceCheckRequest(current, intent) || JSON.stringify(current.binding) !== JSON.stringify(intent.binding)) {
        throw new CheckError(409, "WORKSPACE_CHECK_REQUEST_CONFLICT")
      }
      this.matchSource(current, source)
      const next = parseWorkspaceCheckIntent({ ...current, status: "exported", source: { treeOID: source.tree, sourceSHA256: source.snapshotSHA256 } })
      await txn.put(this.key(intent.requestID), next)
      return next
    })
  }

  async create(request: WorkspaceCheckRequest): Promise<Response> {
    return this.options.admission(async () => {
      let intent = await this.get(request.requestID)
      const created = !intent
      if (intent && !sameWorkspaceCheckRequest(intent, request)) throw new CheckError(409, "WORKSPACE_CHECK_REQUEST_CONFLICT")
      if (intent?.status === "exported") return reply({ workspaceCheck: intent })
      if (!intent) {
        const binding = await this.eligible(request.expectedBindingID)
        if (!this.options.isWarm()) throw new CheckError(409, "WORKSPACE_CHECK_RUNTIME_NOT_WARM")
        intent = parseWorkspaceCheckIntent({ ...request, schemaVersion: 1, binding, status: "requested", checksNotRun: true, mode: "committed_only",
          createdAt: Date.now(), source: null, worktreeChanges: "unverified" })
        const selected = intent
        await this.options.storage.transaction(async txn => {
          if ((await txn.list({ prefix: ROW_PREFIX, limit: MAX_INTENTS + 1 })).size >= MAX_INTENTS) {
            throw new CheckError(429, "WORKSPACE_CHECK_INTENT_LIMIT")
          }
          await txn.put(this.key(request.requestID), selected)
        })
      }
      const selected = intent
      // A prior put may have succeeded despite losing its acknowledgement. Reuse
      // only the exact authenticated object; never overwrite conflicting bytes.
      const recovered = await this.storedSource(selected)
      if (recovered) return reply({ workspaceCheck: await this.exported(selected, recovered) }, created ? 201 : 200)
      await this.eligible(request.expectedBindingID)
      if (!this.options.isWarm()) throw new CheckError(409, "WORKSPACE_CHECK_RUNTIME_NOT_WARM")
      const key = await this.options.checkpoints.cryptoKey()
      if (!key) throw new CheckError(503, "WORKSPACE_CHECK_ENCRYPTION_REQUIRED")
      const result = await this.options.usage(() => this.options.useWarmRuntime(async () => {
        const current = await this.eligible(request.expectedBindingID)
        if (JSON.stringify(current) !== JSON.stringify(selected.binding)) throw new CheckError(409, "WORKSPACE_CHECK_BINDING_CONFLICT")
        const response = await within(this.options.control().fetch("http://container/workspace/checks/snapshot", {
          method: "POST", body: JSON.stringify({ workspaceRepository: selected.binding, commit: selected.commitOID }),
          headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(30_000), redirect: "manual",
        }))
        if (!response.ok) {
          cancel(response.body)
          throw new CheckError(response.status === 409 ? 409 : 503, "WORKSPACE_CHECK_SOURCE_UNAVAILABLE")
        }
        let source: VerifiedWorkspaceCheckSnapshot
        try { source = await verifyWorkspaceCheckSnapshot(await readJSON(response.body, MAX_SOURCE_BYTES)) }
        catch (error) {
          if (error instanceof CheckError) throw error
          throw new CheckError(503, "WORKSPACE_CHECK_SOURCE_UNAVAILABLE")
        }
        this.matchSource(selected, source)
        const ciphertext = await encryptBytes(new TextEncoder().encode(source.canonicalJSON), key)
        try {
          await this.options.bucket.put(this.sourceKey(selected.requestID), ciphertext, { customMetadata: archiveMetadata({
            encrypted: "1", kind: "workspace-check-source", requestID: selected.requestID,
            requestSHA256: await workspaceCheckRequestSHA256(selected), sourceSHA256: source.snapshotSHA256,
          }, await this.options.checkpoints.keyId()) })
        } catch {
          const acknowledged = await this.storedSource(selected)
          if (!acknowledged || acknowledged.snapshotSHA256 !== source.snapshotSHA256) throw new CheckError(503, "WORKSPACE_CHECK_SOURCE_UNAVAILABLE")
        }
        return this.exported(selected, source)
      }))
      return reply({ workspaceCheck: result }, created ? 201 : 200)
    })
  }

  async freshness(intent: WorkspaceCheckIntent): Promise<Response> {
    let status: "current" | "stale" | "unknown" = "unknown"
    let observedCommitOID: string | null = null, observedTreeOID: string | null = null
    try {
      const binding = parseWorkspaceRepositoryReceipt((await this.options.store.get()).workspaceRepository)
      if (JSON.stringify(binding) !== JSON.stringify(intent.binding)) status = "stale"
      else await this.options.useWarmRuntime(async () => {
        const response = await within(this.options.control().fetch("http://container/workspace/checks/head", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRepository: intent.binding }),
          signal: AbortSignal.timeout(10_000), redirect: "manual",
        }), 10_000)
        if (!response.ok) { cancel(response.body); return }
        const body = await readJSON(response.body, 16 * 1024, 10_000) as Record<string, unknown>
        const receipt = parseWorkspaceRepositoryReceipt(body?.workspaceRepository)
        if (JSON.stringify(receipt) !== JSON.stringify(intent.binding) || body.mode !== "committed_only" || body.worktreeChanges !== "unverified" ||
          typeof body.commit !== "string" || !OID.test(body.commit) || typeof body.tree !== "string" || !OID.test(body.tree) || body.commit.length !== body.tree.length) return
        observedCommitOID = body.commit; observedTreeOID = body.tree
        status = body.commit === intent.commitOID && (!intent.source || body.tree === intent.source.treeOID) ? "current" : "stale"
      })
    } catch { /* Missing/cold/unverifiable runtime is unknown, never fresh. */ }
    return reply({ requestID: intent.requestID, expectedBindingID: intent.expectedBindingID, commitOID: intent.commitOID,
      observedCommitOID, observedTreeOID, status, mode: "committed_only", checksNotRun: true, worktreeChanges: "unverified" })
  }

  /** Selects only an already warm, idle, bound checkout. No readiness/preparation. */
  async currentHead(): Promise<{ binding: WorkspaceCheckIntent["binding"]; commit: string }> {
    return this.options.admission(async () => {
      const state = await this.options.store.get()
      const binding = parseWorkspaceRepositoryReceipt(state.workspaceRepository)
      await this.eligible(binding.bindingID)
      if (!this.options.isWarm()) throw new CheckError(409, "WORKSPACE_CHECK_RUNTIME_NOT_WARM")
      return this.options.usage(() => this.options.useWarmRuntime(async () => {
        const response = await within(this.options.control().fetch("http://container/workspace/checks/head", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceRepository: binding }),
          signal: AbortSignal.timeout(10_000), redirect: "manual",
        }), 10_000)
        if (!response.ok) { cancel(response.body); throw new CheckError(409, "WORKSPACE_CHECK_HEAD_UNAVAILABLE") }
        const body = await readJSON(response.body, 16 * 1024, 10_000) as Record<string, unknown>
        if (JSON.stringify(parseWorkspaceRepositoryReceipt(body.workspaceRepository)) !== JSON.stringify(binding) || body.mode !== "committed_only" ||
          body.worktreeChanges !== "unverified" || typeof body.commit !== "string" || !OID.test(body.commit) || typeof body.tree !== "string" ||
          !OID.test(body.tree) || body.commit.length !== body.tree.length) throw new CheckError(409, "WORKSPACE_CHECK_HEAD_UNAVAILABLE")
        return { binding, commit: body.commit }
      }))
    })
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const segments = new URL(request.url).pathname.split("/").filter(Boolean)
      const id = segments[2], operation = segments[3]
      if (segments.length === 2) {
        if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } })
        if (!request.body) throw new WorkspaceCheckValidationError()
        return await this.create(parseWorkspaceCheckRequest(await readJSON(request.body, 16 * 1024)))
      }
      if (!id || !UUID.test(id)) throw new CheckError(400, "INVALID_WORKSPACE_CHECK")
      if (segments.length > 4 || (operation !== undefined && operation !== "source" && operation !== "freshness")) throw new CheckError(404, "WORKSPACE_CHECK_NOT_FOUND")
      if (request.method !== "GET") return new Response("method not allowed", { status: 405, headers: { allow: "GET" } })
      const intent = await this.get(id)
      if (!intent) throw new CheckError(404, "WORKSPACE_CHECK_NOT_FOUND")
      if (!operation) return reply({ workspaceCheck: intent })
      if (operation === "freshness") return await this.freshness(intent)
      if (intent.status !== "exported") throw new CheckError(409, "WORKSPACE_CHECK_NOT_EXPORTED")
      return await this.options.admission(async () => {
        const retained = await this.get(id)
        if (!retained || retained.status !== "exported") throw new CheckError(404, "WORKSPACE_CHECK_NOT_FOUND")
        const source = await this.storedSource(retained)
        if (!source) throw new CheckError(503, "WORKSPACE_CHECK_SOURCE_UNAVAILABLE")
        return new Response(source.canonicalJSON, { headers: { "content-type": "application/json", "cache-control": "no-store" } })
      })
    } catch (error) {
      if (error instanceof CheckError) return reply({ error: "Workspace check operation could not be completed.", code: error.code }, error.status)
      if (error instanceof WorkspaceCheckValidationError || error instanceof SyntaxError) return reply({ error: "Workspace check metadata is invalid.", code: "INVALID_WORKSPACE_CHECK" }, 400)
      return reply({ error: "Workspace check data is unavailable or could not be verified.", code: "WORKSPACE_CHECK_UNAVAILABLE" }, 503)
    }
  }

  /** Called only by the existing guarded hard reset/delete lifecycle. */
  async clear(): Promise<void> {
    for (const key of (await this.options.storage.list({ prefix: ROW_PREFIX })).keys()) await this.options.storage.delete(key)
  }
}
