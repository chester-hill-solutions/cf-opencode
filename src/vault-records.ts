/**
 * Converts the vault records written before the package swap, and guards what
 * cannot be converted.
 *
 * The vendored 0.2.0 build keyed records as `vault:<workspaceId>:<key>` and
 * stored `{ value, createdAt, updatedAt }`. The published package keys them as
 * a JSON tuple, `["vault:","<workspaceId>","<key>"]`, and stores
 * `{ key, encryptedValue, createdAt, updatedAt, lastUsedAt, expiresAt }`.
 *
 * The ciphertext does not change: both builds derive the workspace key from the
 * same HKDF salt and info and frame the payload as `v2:<keyRef>:<base64>`. A
 * migration therefore rewrites the key and the record wrapper and moves the
 * existing ciphertext across. No secret is decrypted and no master key is
 * needed, so a migration cannot corrupt a credential it cannot read.
 *
 * Kept pure so a test can exercise it: constructing a Durable Object with a
 * fake context is not possible (the base class validates its arguments), and
 * the conversion is the part worth testing, not the constructor that calls it.
 */
import type { VaultKeyValueStorage } from "@chester-hill-solutions/vault/core"
import { logEvent } from "./log"

const LEGACY_PREFIX = "vault:"
const NEW_FORMAT_PREFIX = "["

interface LegacyRecord {
  value?: unknown
  createdAt?: unknown
  updatedAt?: unknown
}

export interface VaultMigration {
  /** Records rewritten under the tuple key. */
  migrated: number
  /** Keys left untouched because they cannot be read; the guard still fails. */
  skipped: string[]
}

/** The keys that predate the package swap. */
export function staleVaultKeys(keys: Iterable<string>): string[] {
  return [...keys].filter((key) => !key.startsWith(NEW_FORMAT_PREFIX))
}

/**
 * Throws if any record predates the swap and could not be converted.
 *
 * The message names the count and one key so the operator can find the records,
 * and never a value: the whole point of the store is that its payload is
 * ciphertext nobody should be reading while diagnosing.
 */
export function assertNoStaleVaultRecords(keys: Iterable<string>): void {
  const stale = staleVaultKeys(keys)
  if (stale.length === 0) return
  throw new Error(
    `Found ${stale.length} vault record(s) that predate the package swap; sample key: ${stale[0]}. ` +
      "Delete them or re-enter the credential.",
  )
}

/** Split `vault:<workspaceId>:<key>`, keeping any colons in the secret key. */
function legacyIdentity(key: string): [workspaceId: string, secretKey: string] | undefined {
  if (!key.startsWith(LEGACY_PREFIX)) return undefined
  const rest = key.slice(LEGACY_PREFIX.length)
  const separator = rest.indexOf(":")
  if (separator <= 0 || separator === rest.length - 1) return undefined
  return [rest.slice(0, separator), rest.slice(separator + 1)]
}

function storedISO(record: LegacyRecord | string | undefined, field: "createdAt" | "updatedAt", fallback: string): string {
  if (typeof record !== "object" || record === null) return fallback
  const value = record[field]
  return typeof value === "string" && value.length > 0 ? value : fallback
}

/**
 * Convert legacy records and then refuse to run on anything unreadable.
 *
 * Called once from the Settings constructor inside `blockConcurrencyWhile`, so
 * no route can observe a half-converted store.
 */
export async function prepareVaultRecords(storage: VaultKeyValueStorage): Promise<void> {
  const migration = await migrateLegacyVaultRecords(storage)
  if (migration.migrated > 0 || migration.skipped.length > 0) {
    logEvent("vault.records.migrated", { migrated: migration.migrated, skipped: migration.skipped.length })
  }
  const records = await storage.list({ prefix: LEGACY_PREFIX })
  assertNoStaleVaultRecords(records.keys())
}

/**
 * Rewrite every readable legacy record under the published key and wrapper.
 *
 * A record is skipped when its key is not `vault:<workspaceId>:<key>` or it
 * carries no ciphertext. Skipped keys are left in place so
 * `assertNoStaleVaultRecords` still refuses to run on data nobody can read.
 */
export async function migrateLegacyVaultRecords(storage: VaultKeyValueStorage): Promise<VaultMigration> {
  const entries = await storage.list<LegacyRecord | string>({ prefix: LEGACY_PREFIX })
  // Records are independent, so they convert concurrently; each key's own
  // read-then-write stays ordered inside migrateOne.
  const outcomes = await Promise.all(
    [...entries]
      .filter(([legacyKey]) => !legacyKey.startsWith(NEW_FORMAT_PREFIX))
      .map(([legacyKey, stored]) => migrateOne(storage, legacyKey, stored)),
  )
  const migration: VaultMigration = { migrated: 0, skipped: [] }
  for (const outcome of outcomes) {
    if (outcome === "migrated") migration.migrated += 1
    else migration.skipped.push(outcome)
  }
  return migration
}

/** Returns "migrated", or the key left behind for the guard to refuse. */
async function migrateOne(
  storage: VaultKeyValueStorage,
  legacyKey: string,
  stored: LegacyRecord | string | undefined,
): Promise<"migrated" | string> {
  const identity = legacyIdentity(legacyKey)
  const ciphertext = typeof stored === "string" ? stored : stored?.value
  if (!identity || typeof ciphertext !== "string" || ciphertext.length === 0) return legacyKey
  const [workspaceID, secretKey] = identity
  const target = JSON.stringify([LEGACY_PREFIX, workspaceID, secretKey])
  const existing = await storage.get<unknown>(target)
  if (existing === undefined) {
    const now = new Date().toISOString()
    await storage.put(target, {
      key: secretKey,
      encryptedValue: ciphertext,
      createdAt: storedISO(stored, "createdAt", now),
      updatedAt: storedISO(stored, "updatedAt", now),
      lastUsedAt: null,
      expiresAt: null,
    })
  }
  await storage.delete(legacyKey)
  return "migrated"
}
