import { parseWorkspaceDiscardRecord, parseWorkspaceDiscardAlias, parseWorkspaceProfile, WORKSPACE_DISCARD_ALIAS_PREFIX, WORKSPACE_DISCARD_PREFIX, WORKSPACE_PROFILE_KEY, WORKSPACE_UUID,
  type WorkspaceDiscardRecord, type WorkspaceDiscardAliasRecord, type WorkspaceProfile } from "../workspace-profile"
import { readWorkspaceCheckBytes } from "./workspace-checks"

const PENDING = "workspaceLifecycle:pendingDiscard", LEGACY = "workspaceLifecycle:legacyCleanup"
interface LegacyCleanup { schemaVersion: 1; operation: "reset" | "delete"; profileID: string; revision: number }
interface Options {
  id: string; storage: DurableObjectStorage
  admission<T>(task: () => Promise<T>): Promise<T>
  cleanupOwned(operation: "reset" | "delete", beforeCleanup: () => Promise<void>, resume: boolean): Promise<Response>
}
export class WorkspaceMaintenanceError extends Error { constructor() { super("Workspace cleanup is pending; resume the same operation before starting new work.") } }
class LifecycleError extends Error { constructor(readonly code: string, readonly status = 409) { super(code) } }
const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } })
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LifecycleError("INVALID_WORKSPACE_PROFILE", 400)
  return value as Record<string, unknown>
}
function expected(value: Record<string, unknown>): { expectedProfileID: string; expectedRevision: number } {
  if (typeof value.expectedProfileID !== "string" || !WORKSPACE_UUID.test(value.expectedProfileID) || !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 1) throw new LifecycleError("INVALID_WORKSPACE_PROFILE", 400)
  return { expectedProfileID: value.expectedProfileID, expectedRevision: value.expectedRevision as number }
}
function legacy(value: unknown): LegacyCleanup {
  const raw = object(value)
  if (Object.keys(raw).sort().join(",") !== "operation,profileID,revision,schemaVersion" || raw.schemaVersion !== 1 || (raw.operation !== "reset" && raw.operation !== "delete") ||
    typeof raw.profileID !== "string" || !WORKSPACE_UUID.test(raw.profileID) || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1) throw new LifecycleError("WORKSPACE_LIFECYCLE_UNAVAILABLE", 503)
  return { schemaVersion: 1, operation: raw.operation, profileID: raw.profileID, revision: raw.revision as number }
}

/** Retention is intent, never a TTL. Only explicit fenced cleanup removes work. */
export class ConversationWorkspaceLifecycle {
  cleanupActive = false
  private initial?: Promise<WorkspaceProfile>
  constructor(private readonly options: Options) {}
  private initialProfile(): Promise<WorkspaceProfile> {
    return this.initial ??= (async () => {
      const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("workspace-profile-v1:" + this.options.id)))].map(byte => byte.toString(16).padStart(2, "0")).join("")
      const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
      return { schemaVersion: 1, profileID: id, revision: 1, retention: "persistent", name: null, status: "active" }
    })()
  }
  private async storedProfile(): Promise<WorkspaceProfile> {
    const raw = await this.options.storage.get(WORKSPACE_PROFILE_KEY)
    if (raw === undefined) return this.initialProfile()
    const profile = parseWorkspaceProfile(raw)
    if (profile.status !== "active") throw new LifecycleError("WORKSPACE_LIFECYCLE_UNAVAILABLE", 503)
    return profile
  }
  private async canonical(id: string): Promise<string> {
    const raw = await this.options.storage.get(WORKSPACE_DISCARD_ALIAS_PREFIX + id)
    if (raw === undefined) return id
    const alias = parseWorkspaceDiscardAlias(raw)
    if (alias.requestID !== id) throw new LifecycleError("WORKSPACE_LIFECYCLE_UNAVAILABLE", 503)
    return alias.canonicalRequestID
  }
  private async discard(id: string): Promise<WorkspaceDiscardRecord | undefined> {
    const canonical = await this.canonical(id), raw = await this.options.storage.get(WORKSPACE_DISCARD_PREFIX + canonical)
    if (raw === undefined) return undefined
    const value = parseWorkspaceDiscardRecord(raw)
    if (value.requestID !== canonical) throw new LifecycleError("WORKSPACE_LIFECYCLE_UNAVAILABLE", 503)
    if (canonical !== id) {
      const alias = parseWorkspaceDiscardAlias(await this.options.storage.get(WORKSPACE_DISCARD_ALIAS_PREFIX + id))
      if (alias.expectedProfileID !== value.expectedProfileID || alias.expectedRevision !== value.expectedRevision || alias.createdAt !== value.createdAt || alias.status !== value.status || alias.completedAt !== value.completedAt) throw new LifecycleError("WORKSPACE_LIFECYCLE_UNAVAILABLE", 503)
    }
    return { ...value, requestID: id }
  }
  async hasPending(): Promise<boolean> {
    const [id, old] = await Promise.all([this.options.storage.get<string>(PENDING), this.options.storage.get(LEGACY)])
    if (old !== undefined) { legacy(old); return true }
    if (id === undefined) return false
    if (typeof id !== "string" || !WORKSPACE_UUID.test(id)) throw new LifecycleError("WORKSPACE_LIFECYCLE_UNAVAILABLE", 503)
    const record = await this.discard(id)
    if (!record || record.status !== "pending") throw new LifecycleError("WORKSPACE_LIFECYCLE_UNAVAILABLE", 503)
    return true
  }
  async profile(): Promise<WorkspaceProfile> {
    const profile = await this.storedProfile()
    return { ...profile, status: await this.hasPending() ? "discarding" : "active" }
  }
  private successor(): WorkspaceProfile { return { schemaVersion: 1, profileID: crypto.randomUUID(), revision: 1, retention: "persistent", name: null, status: "active" } }
  private async update(value: unknown): Promise<Response> {
    const raw = object(value), cas = expected(raw)
    if (Object.keys(raw).some(name => !["expectedProfileID", "expectedRevision", "retention", "name"].includes(name)) || (raw.retention !== "persistent" && raw.retention !== "disposable") ||
      (raw.name !== undefined && raw.name !== null && (typeof raw.name !== "string" || !raw.name.trim() || raw.name.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(raw.name)))) throw new LifecycleError("INVALID_WORKSPACE_PROFILE", 400)
    return this.options.admission(async () => {
      if (await this.hasPending()) throw new LifecycleError("WORKSPACE_DISCARD_PENDING")
      const current = await this.storedProfile(), name = raw.name === undefined ? current.name : raw.name === null ? null : (raw.name as string).trim()
      if (current.profileID !== cas.expectedProfileID) throw new LifecycleError("WORKSPACE_PROFILE_CONFLICT")
      if (current.retention === raw.retention && current.name === name) return reply({ workspace: current })
      if (current.revision !== cas.expectedRevision) throw new LifecycleError("WORKSPACE_PROFILE_CONFLICT")
      const next = parseWorkspaceProfile({ ...current, retention: raw.retention, name, revision: current.revision + 1 })
      await this.options.storage.put(WORKSPACE_PROFILE_KEY, next)
      return reply({ workspace: next })
    })
  }
  private async applyDiscard(value: unknown): Promise<Response> {
    const raw = object(value), cas = expected(raw)
    if (Object.keys(raw).sort().join(",") !== "expectedProfileID,expectedRevision,requestID" || typeof raw.requestID !== "string" || !WORKSPACE_UUID.test(raw.requestID)) throw new LifecycleError("INVALID_WORKSPACE_DISCARD", 400)
    const requestID = raw.requestID
    return this.options.admission(async () => {
      const previous = await this.discard(requestID)
      if (previous && (previous.expectedProfileID !== cas.expectedProfileID || previous.expectedRevision !== cas.expectedRevision)) throw new LifecycleError("WORKSPACE_DISCARD_REQUEST_CONFLICT")
      if (previous?.status === "complete") return reply({ discard: previous, workspace: await this.profile() })
      if (!previous) await this.options.storage.put(WORKSPACE_DISCARD_PREFIX + requestID, {
        schemaVersion: 1, requestID, ...cas, status: "prepared", createdAt: Date.now(), completedAt: null,
      } satisfies WorkspaceDiscardRecord)
      const current = await this.storedProfile()
      if (current.profileID !== cas.expectedProfileID || current.revision !== cas.expectedRevision || current.retention !== "disposable") throw new LifecycleError("WORKSPACE_DISCARD_CONFLICT")
      if (await this.options.storage.get(LEGACY) !== undefined) throw new LifecycleError("WORKSPACE_CLEANUP_PENDING")
      const pendingID = await this.options.storage.get<string>(PENDING)
      const canonicalID = pendingID ?? requestID
      const pending = pendingID ? await this.discard(pendingID) : undefined
      if (pendingID && (!pending || pending.status !== "pending" || pending.expectedProfileID !== cas.expectedProfileID || pending.expectedRevision !== cas.expectedRevision)) throw new LifecycleError("WORKSPACE_DISCARD_PENDING_CHANGED")
      const beforeCleanup = async () => {
        if (!pendingID) {
          const entry: WorkspaceDiscardRecord = { schemaVersion: 1, requestID, ...cas, status: "pending", createdAt: Date.now(), completedAt: null }
          await this.options.storage.transaction(async txn => { await txn.put(WORKSPACE_DISCARD_PREFIX + requestID, entry); await txn.put(PENDING, requestID) })
        } else if (requestID !== canonicalID && await this.canonical(requestID) !== canonicalID) {
          const alias: WorkspaceDiscardAliasRecord = { ...pending!, requestID, canonicalRequestID: canonicalID }
          await this.options.storage.transaction(async txn => {
            await txn.put(WORKSPACE_DISCARD_ALIAS_PREFIX + requestID, alias)
            await txn.delete(WORKSPACE_DISCARD_PREFIX + requestID)
          })
        }
      }
      this.cleanupActive = true
      let result: Response
      try { result = await this.options.cleanupOwned("delete", beforeCleanup, Boolean(pendingID)) } finally { this.cleanupActive = false }
      if (!result.ok) return result
      const saved = await this.discard(canonicalID)
      if (!saved || saved.status !== "pending") throw new LifecycleError("WORKSPACE_DISCARD_PENDING_CHANGED")
      const complete: WorkspaceDiscardRecord = { ...saved, status: "complete", completedAt: Date.now() }, successor = this.successor()
      await this.options.storage.transaction(async txn => {
        if (await txn.get(PENDING) !== canonicalID) throw new LifecycleError("WORKSPACE_DISCARD_PENDING_CHANGED")
        await txn.put(WORKSPACE_DISCARD_PREFIX + canonicalID, complete)
        for (const [key, raw] of await txn.list({ prefix: WORKSPACE_DISCARD_ALIAS_PREFIX })) {
          const alias = parseWorkspaceDiscardAlias(raw)
          if (alias.canonicalRequestID === canonicalID) await txn.put(key, { ...alias, status: "complete", completedAt: complete.completedAt })
        }
        await txn.put(WORKSPACE_PROFILE_KEY, successor); await txn.delete(PENDING)
      })
      return reply({ discard: { ...complete, requestID }, workspace: successor })
    })
  }
  /** Same existing cleanup, with an incarnation fence retained on uncertain I/O. */
  async legacyCleanup(operation: "reset" | "delete"): Promise<Response> {
    return this.options.admission(async () => {
      if (await this.options.storage.get(PENDING) !== undefined) throw new LifecycleError("WORKSPACE_DISCARD_PENDING")
      const prior = await this.options.storage.get(LEGACY), profile = await this.storedProfile()
      if (prior !== undefined) {
        const intent = legacy(prior)
        if (intent.operation !== operation || intent.profileID !== profile.profileID || intent.revision !== profile.revision) throw new LifecycleError("WORKSPACE_CLEANUP_PENDING")
      }
      this.cleanupActive = true
      let response: Response
      try { response = await this.options.cleanupOwned(operation, async () => {
        if (prior === undefined) await this.options.storage.put(LEGACY, { schemaVersion: 1, operation, profileID: profile.profileID, revision: profile.revision } satisfies LegacyCleanup)
      }, prior !== undefined) } finally { this.cleanupActive = false }
      if (!response.ok) return response
      await this.options.storage.transaction(async txn => { await txn.put(WORKSPACE_PROFILE_KEY, this.successor()); await txn.delete(LEGACY) })
      return response
    }).catch(error => reply({ error: "Workspace cleanup is pending or unavailable.", code: error instanceof LifecycleError ? error.code : "WORKSPACE_LIFECYCLE_UNAVAILABLE" }, error instanceof LifecycleError ? error.status : 503))
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url)
      if (url.pathname === "/workspace/profile") {
        if (request.method === "GET") return reply({ workspace: await this.profile() })
        if (request.method === "PUT") return await this.update(JSON.parse(new TextDecoder().decode(await readWorkspaceCheckBytes(request.body, 4096))))
        return new Response("method not allowed", { status: 405, headers: { allow: "GET, PUT" } })
      }
      if (url.pathname === "/workspace/discard") {
        if (request.method === "GET") {
          const id = url.searchParams.get("requestID")
          if (id !== null && !WORKSPACE_UUID.test(id)) throw new LifecycleError("INVALID_WORKSPACE_DISCARD", 400)
          const selected = id ?? await this.options.storage.get<string>(PENDING)
          return reply({ discard: selected ? await this.discard(selected) ?? null : null })
        }
        if (request.method === "POST") return await this.applyDiscard(JSON.parse(new TextDecoder().decode(await readWorkspaceCheckBytes(request.body, 4096))))
        return new Response("method not allowed", { status: 405, headers: { allow: "GET, POST" } })
      }
      return reply({ error: "not found" }, 404)
    } catch (error) {
      return reply({ error: "Workspace lifecycle operation was refused or remains pending.", code: error instanceof LifecycleError ? error.code : "WORKSPACE_LIFECYCLE_UNAVAILABLE" }, error instanceof LifecycleError ? error.status : 503)
    }
  }
}
