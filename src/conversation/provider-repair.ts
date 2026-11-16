import type { CredentialEntry } from "@opencode/client"
import { makeClient } from "../opencode"
import type { ContainerPort } from "../opencode"
import { portFetch } from "../opencode"
import type { ConversationStore } from "../state"
import type { ConversationCheckpoints } from "./checkpoints"
import { encryptBytes } from "../archive-crypto"
import { readWorkspaceCheckBytes } from "./workspace-checks"

const PREFIX = "providerCredentialRepair:", PENDING = "providerCredentialRepairPending", LATEST = "providerCredentialRepairLatest"
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const SHA = /^[a-f0-9]{64}$/, CID = /^[A-Za-z0-9_-]{1,160}$/
type Client = ReturnType<typeof makeClient>
type KeyCredential = CredentialEntry & { value: Extract<CredentialEntry["value"], { type: "key" }> }
interface RepairRequest { requestID: string; previewID: string; sourceCredentialID: string; expectedCurrentCredentialID: string }
interface Repair extends RepairRequest {
  schemaVersion: 1; status: "pending" | "complete"; createdAt: number; completedAt: number | null
  sourceFingerprint: string; previousFingerprint: string; sessionID: string | null; repositoryBindingID: string | null
}
export class ProviderRepairError extends Error { constructor(readonly code: string, readonly status = 409) { super(code) } }
interface Options {
  id: string; storage: DurableObjectStorage; store: ConversationStore; bucket: R2Bucket
  checkpoints: Pick<ConversationCheckpoints, "cryptoKey" | "decryptBody" | "captureOwned">
  enabled(): boolean
  admission<T>(task: () => Promise<T>): Promise<T>
  usage<T>(task: () => Promise<T>): Promise<T>
  exclusive<T>(task: () => Promise<T>): Promise<T>
  warmPort(): ContainerPort | undefined
  prepareOwned(): Promise<ContainerPort>
  blocked(): Promise<boolean>
  stopStream(): Promise<boolean>
  source(): Promise<unknown>
}
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } })
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProviderRepairError("PROVIDER_REPAIR_METADATA_UNAVAILABLE", 503); return value as Record<string, unknown> }
function stable(value: unknown, depth = 0): string {
  if (depth > 16) throw new ProviderRepairError("PROVIDER_REPAIR_METADATA_UNAVAILABLE", 503)
  if (Array.isArray(value)) return "[" + value.map(item => stable(item, depth + 1)).join(",") + "]"
  if (value !== null && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stable((value as Record<string, unknown>)[key], depth + 1)).join(",") + "}"
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value)
  throw new ProviderRepairError("PROVIDER_REPAIR_METADATA_UNAVAILABLE", 503)
}
async function sha(value: unknown): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(value))))].map(byte => byte.toString(16).padStart(2, "0")).join("") }
function keyCredential(value: unknown): KeyCredential {
  const raw = record(value), key = record(raw.value)
  if (typeof raw.id !== "string" || !CID.test(raw.id) || raw.integrationID !== "opencode" || typeof raw.label !== "string" || raw.label.length > 256 || typeof raw.active !== "boolean" ||
    key.type !== "key" || typeof key.key !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(key.key) || Object.keys(key).some(name => !["type", "key", "metadata"].includes(name)) ||
    stable(key).length > 16384) throw new ProviderRepairError("PROVIDER_REPAIR_KEY_UNSUPPORTED", 409)
  return raw as unknown as KeyCredential
}
function parseRequest(value: unknown): RepairRequest {
  const raw = record(value)
  if (Object.keys(raw).sort().join(",") !== "expectedCurrentCredentialID,previewID,requestID,sourceCredentialID" || typeof raw.requestID !== "string" || !UUID.test(raw.requestID) ||
    typeof raw.previewID !== "string" || !SHA.test(raw.previewID) || typeof raw.sourceCredentialID !== "string" || !CID.test(raw.sourceCredentialID) ||
    typeof raw.expectedCurrentCredentialID !== "string" || !CID.test(raw.expectedCurrentCredentialID)) throw new ProviderRepairError("INVALID_PROVIDER_REPAIR", 400)
  return { requestID: raw.requestID, previewID: raw.previewID, sourceCredentialID: raw.sourceCredentialID, expectedCurrentCredentialID: raw.expectedCurrentCredentialID }
}
function parseRepair(value: unknown): Repair {
  const raw = record(value), request = parseRequest(Object.fromEntries(["requestID", "previewID", "sourceCredentialID", "expectedCurrentCredentialID"].map(name => [name, raw[name]])))
  if (raw.schemaVersion !== 1 || (raw.status !== "pending" && raw.status !== "complete") || !Number.isSafeInteger(raw.createdAt) ||
    typeof raw.sourceFingerprint !== "string" || !SHA.test(raw.sourceFingerprint) || typeof raw.previousFingerprint !== "string" || !SHA.test(raw.previousFingerprint) ||
    (raw.sessionID !== null && typeof raw.sessionID !== "string") || (raw.repositoryBindingID !== null && typeof raw.repositoryBindingID !== "string") ||
    (raw.status === "pending" ? raw.completedAt !== null : !Number.isSafeInteger(raw.completedAt))) throw new ProviderRepairError("PROVIDER_REPAIR_STATE_UNAVAILABLE", 503)
  return { ...request, schemaVersion: 1, status: raw.status, createdAt: raw.createdAt as number, completedAt: raw.completedAt as number | null,
    sourceFingerprint: raw.sourceFingerprint, previousFingerprint: raw.previousFingerprint, sessionID: raw.sessionID as string | null, repositoryBindingID: raw.repositoryBindingID as string | null }
}

/** Explicit canary-only repair. Automatic onboarding synchronization remains additive. */
export class ConversationProviderRepair {
  active = false
  constructor(private readonly options: Options) {}
  private async get(id: string): Promise<Repair | undefined> { const value = await this.options.storage.get(PREFIX + id); return value === undefined ? undefined : parseRepair(value) }
  async hasPending(): Promise<boolean> {
    const id = await this.options.storage.get<string>(PENDING)
    if (id === undefined) return false
    const row = await this.get(id)
    if (!row) throw new ProviderRepairError("PROVIDER_REPAIR_STATE_UNAVAILABLE", 503)
    return row.status === "pending"
  }
  private async eligible(allowCheckpointPending = false): Promise<void> {
    const state = await this.options.store.get()
    if (await this.options.blocked() || state.budgetReservation || (state.phase ?? "idle") !== "idle" || state.queue?.length || Object.keys(state.pending).length || (state.checkpointPending && !allowCheckpointPending) || state.lifecycleJobsSealed) throw new ProviderRepairError("PROVIDER_REPAIR_WORKSPACE_BUSY")
  }
  private async identity(): Promise<{ sessionID: string | null; repositoryBindingID: string | null }> {
    const state = await this.options.store.get()
    return { sessionID: state.sessionID ?? null, repositoryBindingID: state.workspaceRepository?.bindingID ?? null }
  }
  private async selected(client: Client): Promise<KeyCredential> {
    const [credentials, integration] = await Promise.all([client.credential.list(), client.integration.get({ integrationID: "opencode", location: { directory: "/workspace" } })])
    const connection = integration.data.connections[0]
    if (!connection || connection.type !== "credential") throw new ProviderRepairError("PROVIDER_REPAIR_SELECTION_UNSUPPORTED")
    const matches = credentials.filter(entry => entry.id === connection.id && entry.integrationID === "opencode" && entry.active)
    if (matches.length !== 1) throw new ProviderRepairError("PROVIDER_REPAIR_SELECTION_UNSUPPORTED")
    return keyCredential(matches[0])
  }
  private async source(id: string): Promise<KeyCredential> {
    const value = await this.options.source()
    if (!Array.isArray(value) || value.length > 128) throw new ProviderRepairError("PROVIDER_REPAIR_SOURCE_UNAVAILABLE", 503)
    const matches = value.filter(entry => record(entry).id === id && record(entry).integrationID === "opencode" && record(entry).active === true)
    if (matches.length !== 1) throw new ProviderRepairError("PROVIDER_REPAIR_SOURCE_CHANGED")
    return keyCredential(matches[0])
  }
  private async preview(client: Client, sourceID: string) {
    const [source, current, identity] = await Promise.all([this.source(sourceID), this.selected(client), this.identity()])
    const sourceFingerprint = await sha(source.value), previousFingerprint = await sha(current.value)
    const previewID = await sha({ integrationID: "opencode", sourceCredentialID: source.id, expectedCurrentCredentialID: current.id, sourceFingerprint, previousFingerprint, ...identity })
    return { previewID, sourceCredentialID: source.id, expectedCurrentCredentialID: current.id, sourceFingerprint, previousFingerprint, ...identity }
  }
  private capsuleKey(row: Repair): string { return `workspaces/${this.options.id}/provider-repairs/${row.requestID}.json` }
  private async capsule(row: Repair, cryptoKey: CryptoKey, mayWrite = true): Promise<KeyCredential> {
    const object = await this.options.bucket.get(this.capsuleKey(row))
    if (object) {
      if (object.customMetadata?.encrypted !== "1" || object.customMetadata.kind !== "provider-credential-repair" || object.customMetadata.previewID !== row.previewID || object.size > 32768) { void object.body.cancel().catch(() => {}); throw new ProviderRepairError("PROVIDER_REPAIR_BUNDLE_UNAVAILABLE", 503) }
      const clear = await this.options.checkpoints.decryptBody(object.body, true)
      const credential = keyCredential(JSON.parse(new TextDecoder().decode(await readWorkspaceCheckBytes(clear, 24000))))
      if (credential.id !== row.sourceCredentialID || await sha(credential.value) !== row.sourceFingerprint) throw new ProviderRepairError("PROVIDER_REPAIR_BUNDLE_UNAVAILABLE", 503)
      return credential
    }
    if (!mayWrite) throw new ProviderRepairError("PROVIDER_REPAIR_BUNDLE_UNAVAILABLE", 503)
    const credential = await this.source(row.sourceCredentialID)
    if (await sha(credential.value) !== row.sourceFingerprint) throw new ProviderRepairError("PROVIDER_REPAIR_SOURCE_CHANGED")
    const encrypted = await encryptBytes(new TextEncoder().encode(JSON.stringify(credential)), cryptoKey)
    await this.options.bucket.put(this.capsuleKey(row), encrypted, { customMetadata: { encrypted: "1", kind: "provider-credential-repair", previewID: row.previewID } })
    // Read through authenticated storage before changing the Linux credential store.
    return this.capsule(row, cryptoKey, false)
  }
  private async checkpoint(): Promise<void> {
    await this.options.store.patch({ checkpointStateFingerprint: undefined })
    if (!await this.options.checkpoints.captureOwned()) throw new ProviderRepairError("PROVIDER_REPAIR_CHECKPOINT_PENDING", 503)
    const state = await this.options.store.get()
    if (state.checkpointEncrypted !== true || state.checkpointManifest?.state?.encrypted !== true || state.checkpointManifest.workspace.encrypted !== true) throw new ProviderRepairError("PROVIDER_REPAIR_CHECKPOINT_UNVERIFIED", 503)
  }
  async clear(): Promise<void> {
    for (const name of (await this.options.storage.list({ prefix: PREFIX })).keys()) await this.options.storage.delete(name)
    await this.options.storage.delete([PENDING, LATEST])
  }
  async verifyPrepared(port: ContainerPort): Promise<void> {
    const latest = await this.options.storage.get<string>(LATEST)
    if (!latest) return
    const row = await this.get(latest)
    if (!row || row.status !== "complete") throw new ProviderRepairError("PROVIDER_REPAIR_STATE_UNAVAILABLE", 503)
    const selected = await this.selected(makeClient(portFetch(port)))
    if (selected.id !== row.sourceCredentialID || await sha(selected.value) !== row.sourceFingerprint) throw new ProviderRepairError("PROVIDER_REPAIR_RESTORED_CREDENTIAL_MISMATCH")
  }
  async fetch(request: Request): Promise<Response> {
    if (!this.options.enabled()) return reply({ error: "Provider repair is unavailable for this conversation." }, 404)
    if (request.method !== "GET" && request.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "GET, POST" } })
    try {
      const url = new URL(request.url)
      if (request.method === "GET" && url.searchParams.has("requestID")) {
        const id = url.searchParams.get("requestID")!
        if (!UUID.test(id)) throw new ProviderRepairError("INVALID_PROVIDER_REPAIR", 400)
        return reply({ repair: await this.get(id) ?? null })
      }
      const body = request.method === "POST" ? parseRequest(JSON.parse(new TextDecoder().decode(await readWorkspaceCheckBytes(request.body, 16384)))) : undefined
      const sourceID = body?.sourceCredentialID ?? url.searchParams.get("sourceCredentialID")
      if (!sourceID || !CID.test(sourceID)) throw new ProviderRepairError("INVALID_PROVIDER_REPAIR", 400)
      return await this.options.admission(() => this.options.usage(() => this.options.exclusive(async () => {
        const existing = body ? await this.get(body.requestID) : undefined
        if (existing && stable(body) !== stable(parseRequest({ requestID: existing.requestID, previewID: existing.previewID, sourceCredentialID: existing.sourceCredentialID, expectedCurrentCredentialID: existing.expectedCurrentCredentialID }))) throw new ProviderRepairError("PROVIDER_REPAIR_REQUEST_CONFLICT")
        if (existing?.status === "complete") return reply({ repair: existing, historicalReceipt: true })
        await this.eligible(existing?.status === "pending")
        this.active = true
        try {
          if (!body) {
            if (await this.hasPending()) throw new ProviderRepairError("PROVIDER_REPAIR_PENDING")
            const port = this.options.warmPort()
            if (!port) throw new ProviderRepairError("PROVIDER_REPAIR_RUNTIME_NOT_WARM")
            return reply({ integrationID: "opencode", ...await this.preview(makeClient(portFetch(port)), sourceID), noInference: true })
          }
          if (!await this.options.stopStream()) throw new ProviderRepairError("PROVIDER_REPAIR_STREAM_UNRESOLVED")
          const key = await this.options.checkpoints.cryptoKey()
          if (!key) throw new ProviderRepairError("PROVIDER_REPAIR_ENCRYPTION_REQUIRED", 503)
          const port = await this.options.prepareOwned(), client = makeClient(portFetch(port))
          let row = existing
          if (!row) {
            if (await this.hasPending()) throw new ProviderRepairError("PROVIDER_REPAIR_PENDING")
            const preview = await this.preview(client, sourceID)
            if (preview.previewID !== body.previewID || preview.expectedCurrentCredentialID !== body.expectedCurrentCredentialID) throw new ProviderRepairError("PROVIDER_REPAIR_PREVIEW_CHANGED")
            row = { ...body, ...preview, schemaVersion: 1, status: "pending", createdAt: Date.now(), completedAt: null }
            const saved = row
            await this.options.storage.transaction(async txn => {
              if (await txn.get(PENDING) || (await txn.list({ prefix: PREFIX, limit: 21 })).size >= 20) throw new ProviderRepairError("PROVIDER_REPAIR_PENDING_OR_LIMIT")
              await txn.put(PREFIX + saved.requestID, saved); await txn.put(PENDING, saved.requestID)
            })
          }
          if (stable(await this.identity()) !== stable({ sessionID: row.sessionID, repositoryBindingID: row.repositoryBindingID })) throw new ProviderRepairError("PROVIDER_REPAIR_HISTORY_CHANGED")
          const credential = await this.capsule(row, key)
          let current = await this.selected(client)
          const currentDigest = await sha(current.value)
          if (current.id !== row.sourceCredentialID || currentDigest !== row.sourceFingerprint) {
            if (current.id !== row.expectedCurrentCredentialID || currentDigest !== row.previousFingerprint) throw new ProviderRepairError("PROVIDER_REPAIR_LOCAL_CREDENTIAL_CHANGED")
            // Save existing sessions/history before the first credential mutation.
            await this.checkpoint()
            const credentials = await client.credential.list()
            const prior = credentials.find(entry => entry.id === row!.sourceCredentialID)
            if (prior) {
              if (prior.integrationID !== "opencode" || await sha(keyCredential(prior).value) !== row.sourceFingerprint) throw new ProviderRepairError("PROVIDER_REPAIR_DESTINATION_CONFLICT")
            } else await client.credential.create({ id: credential.id, integrationID: "opencode", label: credential.label, value: credential.value, activate: false })
            await client.credential.activate({ credentialID: credential.id })
            current = await this.selected(client)
          }
          if (current.id !== row.sourceCredentialID || await sha(current.value) !== row.sourceFingerprint) throw new ProviderRepairError("PROVIDER_REPAIR_ACTIVATION_UNVERIFIED", 503)
          // Ordinary lifecycle checkpointing; never overwrite the global account seed.
          await this.checkpoint()
          if (stable(await this.identity()) !== stable({ sessionID: row.sessionID, repositoryBindingID: row.repositoryBindingID })) throw new ProviderRepairError("PROVIDER_REPAIR_HISTORY_CHANGED")
          const complete: Repair = { ...row, status: "complete", completedAt: Date.now() }
          await this.options.storage.transaction(async txn => {
            if (await txn.get(PENDING) !== complete.requestID) throw new ProviderRepairError("PROVIDER_REPAIR_PENDING_CHANGED")
            await txn.put(PREFIX + complete.requestID, complete); await txn.put(LATEST, complete.requestID); await txn.delete(PENDING)
          })
          return reply({ repair: complete })
        } finally { this.active = false }
      })))
    } catch (error) {
      return reply({ error: "Provider credential repair was refused or remains pending. No history was reset.", code: error instanceof ProviderRepairError ? error.code : "PROVIDER_REPAIR_UNAVAILABLE" }, error instanceof ProviderRepairError ? error.status : 503)
    }
  }
}
