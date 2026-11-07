/**
 * Driver-free entry point: the vault core plus a key/value store adapter.
 *
 * The upstream package's root entry also exports the Postgres store, which
 * pulls drizzle into a Worker bundle. This entry keeps the Worker build to the
 * encryption core and the storage adapter it actually uses.
 */

export { Vault, createInMemoryVaultStore } from "./vault.js"
export type {
  VaultStore,
  VaultEntry,
  SecretStore,
  SecretReader,
  SecretMetadata,
  VaultKeyring,
} from "./vault.js"
export {
  encrypt,
  decrypt,
  deriveWorkspaceKey,
  keyFingerprint,
  parseCiphertext,
  parseMasterKey,
  VaultKeyError,
  CIPHERTEXT_VERSION,
} from "./encryption.js"
export type { ParsedCiphertext } from "./encryption.js"

import type { SecretMetadata, VaultStore } from "./vault.js"

/**
 * Minimal subset of Cloudflare Durable Object storage (and similar key/value
 * surfaces). Structural so `ctx.storage` can be passed directly.
 */
export interface VaultKeyValueStorage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  list<T>(options: { prefix: string }): Promise<Map<string, T>>
}

interface StoredSecret {
  value: string
  createdAt: string
  updatedAt: string
}

/**
 * Store ciphertext in a key/value backend, namespaced by workspace id.
 *
 * Values are wrapped with their timestamps so `listSecretMetadata` can describe
 * a secret without decrypting it. A legacy raw string is still returned by
 * `get`; the vault refuses pre-v2 formats with an actionable error.
 */
export function createKeyValueVaultStore(
  storage: VaultKeyValueStorage,
  prefix = "vault:",
): VaultStore {
  const record = (workspaceId: string, key: string) => `${prefix}${workspaceId}:${key}`
  const workspacePrefix = (workspaceId: string) => `${prefix}${workspaceId}:`

  return {
    async get(workspaceId, key) {
      const stored = await storage.get<string | StoredSecret>(record(workspaceId, key))
      if (!stored) return null
      return typeof stored === "string" ? stored : stored.value
    },
    async set(workspaceId, key, value) {
      const now = new Date().toISOString()
      const existing = await storage.get<StoredSecret>(record(workspaceId, key))
      await storage.put(record(workspaceId, key), {
        value,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      } satisfies StoredSecret)
    },
    async delete(workspaceId, key) {
      await storage.delete(record(workspaceId, key))
    },
    async listMetadata(workspaceId): Promise<SecretMetadata[]> {
      const entries = await storage.list<StoredSecret | string>({
        prefix: workspacePrefix(workspaceId),
      })
      const base = workspacePrefix(workspaceId).length
      return Array.from(entries.entries()).map(([name, stored]) => {
        const key = name.slice(base)
        if (typeof stored === "string") {
          return { key, createdAt: "", updatedAt: "" }
        }
        return { key, createdAt: stored.createdAt, updatedAt: stored.updatedAt }
      })
    },
  }
}
