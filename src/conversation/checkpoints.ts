import { deriveWorkspaceKey } from "@chester-hill-solutions/vault/core"
import { plaintextArchivesAllowed, type ArchivePolicyEnv } from "../archive-policy"
import {
  decryptTransform,
  encryptBytes,
  encryptTransform,
  encryptedLength,
} from "../archive-crypto"
import type { ContainerPort } from "../opencode"
import { withRetries } from "../retry"
import { logEvent } from "../log"
import { withSpan } from "../telemetry"
import { ConversationStore, type CheckpointManifest } from "../state"

const CHECKPOINT_RETRY_MS = 30_000
const CHECKPOINT_RETRY_LIMIT = 3
const CHECKPOINT_KEEP = 5

export interface CheckpointRetryPort {
  schedule(at: number, reason: string): Promise<void>
  cancel(): Promise<void>
}

export interface ConversationCheckpointsOptions {
  conversationID: string
  workspaceID: string
  store: ConversationStore
  storage: DurableObjectStorage
  bucket: R2Bucket
  archiveEnv: ArchivePolicyEnv
  getControl(): Promise<ContainerPort>
  retry: CheckpointRetryPort
  count(name: string): Promise<void>
  deliverError(message: string): Promise<unknown>
}

export interface RestorableCheckpoint {
  workspace: R2ObjectBody
  state: R2ObjectBody | null
  split: boolean
}

/** Owns checkpoint archive crypto, publication ordering, retries, and pruning. */
export class ConversationCheckpoints {
  private checkpointTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: ConversationCheckpointsOptions) {}

  private prefix(): string {
    return `workspaces/${this.options.conversationID}/`
  }

  async latest(): Promise<RestorableCheckpoint | null> {
    const state = await this.options.store.get()
    const manifest = state.checkpointManifest
    if (manifest?.workspace) {
      const workspace = await this.options.bucket.get(manifest.workspace.key)
      if (!workspace) {
        logEvent("checkpoint.manifest.missing", { key: manifest.workspace.key })
        throw new Error(`checkpoint manifest workspace is missing: ${manifest.workspace.key}`)
      }
      const stateObject = manifest.state ? await this.options.bucket.get(manifest.state.key) : null
      if (manifest.state && !stateObject) {
        logEvent("checkpoint.manifest.missing", { key: manifest.state.key })
        throw new Error(`checkpoint manifest state is missing: ${manifest.state.key}`)
      }
      return { workspace, state: stateObject, split: true }
    }
    const objects = await this.objects()
    if (state.checkpointKey) {
      const recorded = await this.options.bucket.get(state.checkpointKey)
      if (!recorded) throw new Error(`recorded checkpoint is missing: ${state.checkpointKey}`)
      return { workspace: recorded, state: null, split: false }
    }
    const newest = objects
      .map((object) => object.key)
      .filter((key) => /^\d+\.tar\.gz$/.test(key.slice(this.prefix().length)))
      .sort()
      .at(-1)
    const legacy = newest
      ? await this.options.bucket.get(newest)
      : await this.options.bucket.get(`workspaces/${this.options.conversationID}.tar.gz`)
    return legacy ? { workspace: legacy, state: null, split: false } : null
  }

  async objects(): Promise<R2Object[]> {
    const objects: R2Object[] = []
    let cursor: string | undefined
    do {
      const page = await this.options.bucket.list({ prefix: this.prefix(), cursor })
      objects.push(...page.objects)
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    return objects
  }

  async deleteAll(): Promise<void> {
    const prefix = this.prefix()
    let cursor: string | undefined
    do {
      const page = await this.options.bucket.list({ prefix, cursor })
      for (const object of page.objects) await this.options.bucket.delete(object.key)
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    await this.options.bucket.delete(`workspaces/${this.options.conversationID}.tar.gz`)
  }

  async cryptoKey(): Promise<CryptoKey | undefined> {
    const master = this.options.archiveEnv.VAULT_MASTER_KEY
    if (!master) {
      if (plaintextArchivesAllowed(this.options.archiveEnv)) return undefined
      throw new Error(
        "VAULT_MASTER_KEY is required to encrypt checkpoints; set it or explicitly allow plaintext archives",
      )
    }
    return deriveWorkspaceKey(master, this.options.workspaceID)
  }

  async decryptBody(body: ReadableStream, encrypted: boolean): Promise<ReadableStream> {
    if (!encrypted) return body
    const key = await this.cryptoKey()
    if (!key) throw new Error("checkpoint is encrypted but VAULT_MASTER_KEY is not configured")
    return body.pipeThrough(decryptTransform(key))
  }

  async retry(): Promise<boolean> {
    const state = await this.options.store.get()
    if (!state.checkpointPending) return false
    if ((state.phase ?? "idle") !== "idle") return false
    const attempts = state.checkpointAttempts ?? 0
    if (attempts >= CHECKPOINT_RETRY_LIMIT) {
      await this.options.store.patch({ checkpointPending: undefined, checkpointAttempts: undefined, checkpointRetryAt: undefined })
      await this.options.retry.cancel()
      logEvent("checkpoint.abandoned", { attempts })
      await this.options.deliverError("workspace checkpoint failed repeatedly; recent changes may not be recoverable").catch(() => {})
      return false
    }
    const saved = await this.capture()
    if (saved) {
      await this.options.store.patch({ checkpointPending: undefined, checkpointAttempts: undefined, checkpointRetryAt: undefined })
      await this.options.retry.cancel()
      logEvent("checkpoint.recovered", { attempts })
      return false
    }
    await this.options.store.patch({ checkpointAttempts: attempts + 1 })
    logEvent("checkpoint.retry", { attempts: attempts + 1 })
    return false
  }

  async capture(): Promise<boolean> {
    const previous = this.checkpointTail
    let release!: () => void
    this.checkpointTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await this.captureLocked()
    } finally {
      release()
    }
  }

  private async prune(): Promise<void> {
    const objects = await this.objects()
    const state = await this.options.store.get()
    const manifest = state.checkpointManifest
    const active = new Set([
      state.checkpointKey,
      manifest?.workspace.key,
      manifest?.state?.key,
    ].filter((key): key is string => Boolean(key)))
    const workspaceKeys: string[] = []
    const stateKeys: string[] = []
    for (const { key } of objects) {
      const basename = key.slice(this.prefix().length)
      if (/^workspace-\d+\.tar\.gz$/.test(basename)) workspaceKeys.push(key)
      else if (/^state-\d+\.tar\.gz$/.test(basename)) stateKeys.push(key)
    }
    workspaceKeys.sort()
    stateKeys.sort()
    const keep = (keys: string[]) => new Set([
      ...keys.slice(Math.max(0, keys.length - CHECKPOINT_KEEP)),
      ...keys.filter((key) => active.has(key)),
    ])
    const retained = new Set([...keep(workspaceKeys), ...keep(stateKeys)])
    const stale = [...workspaceKeys, ...stateKeys].filter((key) => !retained.has(key))
    for (const key of stale) await this.options.bucket.delete(key)
    if (stale.length) logEvent("checkpoint.pruned", { count: stale.length })
  }

  private async uploadPart(key: string, response: Response, cryptoKey: CryptoKey | undefined): Promise<number> {
    if (!response.body) throw new Error("checkpoint part has no body")
    const encrypted = Boolean(cryptoKey)
    const length = Number(response.headers.get("content-length"))
    const metadata = { customMetadata: { encrypted: encrypted ? "1" : "0" } }
    let bytes: number
    if (cryptoKey) {
      if (Number.isFinite(length) && length > 0) {
        const sealed = response.body.pipeThrough(encryptTransform(cryptoKey))
        const cipherLength = encryptedLength(length)
        const fixed = new FixedLengthStream(cipherLength)
        const piping = sealed.pipeTo(fixed.writable)
        await Promise.all([this.options.bucket.put(key, fixed.readable, metadata), piping])
        bytes = cipherLength
      } else {
        const plain = new Uint8Array(await response.arrayBuffer())
        const sealed = await encryptBytes(plain, cryptoKey)
        await this.options.bucket.put(key, sealed, metadata)
        bytes = sealed.byteLength
      }
    } else if (Number.isFinite(length) && length > 0) {
      const counted = countedStream(response.body)
      const fixed = new FixedLengthStream(length)
      const piping = counted.stream.pipeTo(fixed.writable)
      await Promise.all([this.options.bucket.put(key, fixed.readable, metadata), piping])
      bytes = counted.bytes()
    } else {
      const buffer = await response.arrayBuffer()
      await this.options.bucket.put(key, buffer, metadata)
      bytes = buffer.byteLength
    }
    const stored = await this.options.bucket.head(key)
    if (!stored) throw new Error("checkpoint upload disappeared")
    if (stored.size !== bytes) {
      await this.options.bucket.delete(key)
      throw new Error(`checkpoint size mismatch: ${stored.size} != ${bytes}`)
    }
    return bytes
  }

  private async requirePart(part: { key: string } | undefined, kind: "workspace" | "state"): Promise<void> {
    if (!part) return
    const head = await this.options.bucket.head(part.key)
    if (head) return
    logEvent("checkpoint.missing", { key: part.key })
    await this.options.store.patch(
      kind === "workspace"
        ? { checkpointFingerprint: undefined, checkpointKey: undefined }
        : { checkpointStateFingerprint: undefined },
    )
    throw new Error("checkpoint was skipped but the archive is missing")
  }

  private async captureLocked(): Promise<boolean> {
    return withSpan("conversation.checkpoint", async (span) => {
      const stamp = Date.now()
      const prefix = this.prefix()
      const workspaceKey = `${prefix}workspace-${stamp}.tar.gz`
      const stateKey = `${prefix}state-${stamp}.tar.gz`
      try {
        await this.cryptoKey()
        await withRetries(async () => {
          const state = await this.options.store.get()
          const cryptoKey = await this.cryptoKey()
          const encrypted = Boolean(cryptoKey)
          const matching = state.checkpointEncrypted === encrypted
          const workspaceSince = matching ? state.checkpointFingerprint ?? "" : ""
          const stateSince = matching ? state.checkpointStateFingerprint ?? "" : ""
          const control = await this.options.getControl()
          const response = await control.fetch(
            `http://container/checkpoint?part=workspace&since=${encodeURIComponent(workspaceSince)}`,
            { signal: AbortSignal.timeout(120_000) },
          )
          const split = response.headers.get("x-aboiteau-checkpoint") === "split"

          if (!split) {
            if (response.status === 204) {
              await this.requirePart(state.checkpointKey ? { key: state.checkpointKey } : undefined, "workspace")
              void this.options.count("checkpoint.skipped")
              logEvent("checkpoint.skipped")
              return
            }
            if (!response.ok) throw new Error(`checkpoint returned ${response.status}`)
            const bytes = await this.uploadPart(workspaceKey, response, cryptoKey)
            span.setAttribute("checkpoint.bytes", bytes)
            void this.options.count("checkpoint.saved")
            logEvent("checkpoint.saved", { bytes })
            await this.options.store.patch({
              checkpointSize: bytes,
              checkpointKey: workspaceKey,
              checkpointManifest: undefined,
              checkpointEncrypted: encrypted,
            })
            const fingerprint = response.headers.get("x-workspace-fingerprint")
            if (fingerprint) await this.options.store.patch({ checkpointFingerprint: fingerprint })
            await this.prune()
            return
          }

          const manifest = state.checkpointManifest
          let workspacePart = manifest?.workspace
          let statePart = manifest?.state
          let uploaded = false
          if (response.status === 204) {
            if (!workspacePart) {
              await this.options.store.patch({ checkpointFingerprint: undefined })
              throw new Error("checkpoint was skipped but no manifest exists")
            }
            await this.requirePart(workspacePart, "workspace")
          } else if (response.ok) {
            const bytes = await this.uploadPart(workspaceKey, response, cryptoKey)
            workspacePart = { key: workspaceKey, size: bytes, encrypted }
            uploaded = true
          } else {
            throw new Error(`checkpoint returned ${response.status}`)
          }

          const stateResponse = await control.fetch(
            `http://container/checkpoint?part=state&since=${encodeURIComponent(stateSince)}`,
            { signal: AbortSignal.timeout(120_000) },
          )
          let stateFingerprint = manifest?.stateFingerprint
          if (stateResponse.status === 204) {
            if (!statePart) {
              await this.options.store.patch({ checkpointStateFingerprint: undefined })
              throw new Error("state checkpoint was skipped but no archive exists")
            }
            await this.requirePart(statePart, "state")
            stateFingerprint = stateResponse.headers.get("x-state-fingerprint") ?? stateFingerprint
          } else if (stateResponse.status === 404) {
            statePart = undefined
            stateFingerprint = undefined
          } else if (stateResponse.ok) {
            const bytes = await this.uploadPart(stateKey, stateResponse, cryptoKey)
            statePart = { key: stateKey, size: bytes, encrypted }
            stateFingerprint = stateResponse.headers.get("x-state-fingerprint") ?? stateFingerprint
            uploaded = true
          } else {
            throw new Error(`state checkpoint returned ${stateResponse.status}`)
          }

          const fingerprint = response.headers.get("x-workspace-fingerprint") ?? manifest?.fingerprint
          if (!uploaded) {
            void this.options.count("checkpoint.skipped")
            logEvent("checkpoint.skipped")
            return
          }
          const next: CheckpointManifest = {
            workspace: workspacePart!,
            ...(statePart ? { state: statePart } : {}),
            ...(fingerprint ? { fingerprint } : {}),
            ...(stateFingerprint ? { stateFingerprint } : {}),
            createdAt: Date.now(),
          }
          const bytes = next.workspace.size + (next.state?.size ?? 0)
          span.setAttribute("checkpoint.bytes", bytes)
          void this.options.count("checkpoint.saved")
          logEvent("checkpoint.saved", { bytes })
          await this.options.store.patch({
            checkpointManifest: next,
            checkpointKey: next.workspace.key,
            checkpointSize: bytes,
            checkpointEncrypted: encrypted,
            ...(fingerprint ? { checkpointFingerprint: fingerprint } : {}),
            ...(stateFingerprint ? { checkpointStateFingerprint: stateFingerprint } : {}),
          })
          await this.prune()
        }, { attempts: 3, delayMs: 1000 })
        await this.options.store.patch({
          checkpointPending: undefined,
          checkpointAttempts: undefined,
          checkpointRetryAt: undefined,
        })
        return true
      } catch (err) {
        span.recordException(err as Error)
        console.warn("checkpoint failed", err)
        void this.options.count("checkpoint.failed")
        logEvent("checkpoint.failed")
        const retryAt = Date.now() + CHECKPOINT_RETRY_MS
        await this.options.storage.transaction(async () => {
          await this.options.store.patch({ checkpointPending: true, checkpointRetryAt: retryAt })
          await this.options.retry.schedule(retryAt, "checkpoint-upload-retry")
        })
        return false
      }
    })
  }
}

function countedStream(stream: ReadableStream<Uint8Array>): {
  stream: ReadableStream<Uint8Array>
  bytes: () => number
} {
  let bytes = 0
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength
      controller.enqueue(chunk)
    },
  })
  return { stream: stream.pipeThrough(transform), bytes: () => bytes }
}
