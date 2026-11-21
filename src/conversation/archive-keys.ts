import { deriveWorkspaceKey } from "@chester-hill-solutions/vault/core"
import type { ArchivePolicyEnv } from "../archive-policy"
import { archiveKeyId } from "../vault"

/**
 * Archive keys by identity, so the master secret can be rotated without
 * orphaning retained checkpoints.
 *
 * A stored archive records the *fingerprint* of the key that sealed it. Rotation
 * sets the new secret as `VAULT_MASTER_KEY` and keeps the old one in
 * `VAULT_MASTER_KEY_PREVIOUS` until no archive still names it. Reading selects a
 * key by identity instead of trial-decrypting a stream, because a failed AES-GCM
 * frame aborts the stream rather than rewinding it.
 */

export interface ArchiveKey {
  id: string
  key: CryptoKey
}

export interface ArchiveKeyRing {
  active: ArchiveKey
  previous: ArchiveKey[]
}

/** Archive custom metadata: the base fields plus the key identity when known. */
export function archiveMetadata(base: Record<string, string>, keyId: string | undefined): Record<string, string> {
  return keyId ? { ...base, keyId } : base
}

/** Active secret first, then the retained ones, without duplicates. */
export function configuredMasters(env: ArchivePolicyEnv): string[] {
  const previous = (env.VAULT_MASTER_KEY_PREVIOUS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean)
  return [...new Set([...(env.VAULT_MASTER_KEY ? [env.VAULT_MASTER_KEY] : []), ...previous])]
}

/**
 * Select the key that can read an archive.
 *
 * An archive written before key ids carries none, and guessing is not safe on a
 * stream: with exactly one configured secret it is unambiguous, with more than
 * one it is refused rather than silently failing mid-frame.
 */
export function selectArchiveKey(ring: ArchiveKeyRing, keyId: string | undefined): ArchiveKey {
  if (!keyId) {
    if (ring.previous.length > 0) {
      throw new Error("archive has no key id and more than one master key is configured; restore the single key that wrote it")
    }
    return ring.active
  }
  const match = [ring.active, ...ring.previous].find((entry) => entry.id === keyId)
  if (!match) {
    throw new Error(`archive key ${keyId} is not configured; set VAULT_MASTER_KEY_PREVIOUS to the secret that wrote it`)
  }
  return match
}

export async function archiveKeyRing(env: ArchivePolicyEnv, workspaceID: string): Promise<ArchiveKeyRing> {
  const masters = configuredMasters(env)
  const derived = await Promise.all(masters.map(async (master) => ({
    id: await archiveKeyId(master, workspaceID),
    key: await deriveWorkspaceKey(master, workspaceID),
  })))
  const [active, ...previous] = derived
  if (!active) throw new Error("no archive master key is configured")
  return { active, previous }
}
