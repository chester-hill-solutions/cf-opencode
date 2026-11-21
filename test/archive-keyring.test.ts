import { describe, expect, it } from "vitest"
import { archiveKeyId } from "../src/vault"
import { archiveKeyRing, archiveMetadata, configuredMasters, selectArchiveKey } from "../src/conversation/archive-keys"

/**
 * Rotation must be possible without orphaning retained archives. Archives record
 * a fingerprint of the key that sealed them, so reading selects a key by identity
 * instead of trial-decrypting a stream (a failed frame aborts the stream).
 */

/** The vault accepts only 32-byte hex secrets. */
const KEY_A = "a".repeat(64)
const KEY_B = "b".repeat(64)

describe("archive key ring", () => {
  it("names a key without exposing the secret", async () => {
    const first = await archiveKeyId(KEY_A, "workspace")
    const again = await archiveKeyId(KEY_A, "workspace")
    const other = await archiveKeyId(KEY_B, "workspace")
    const scoped = await archiveKeyId(KEY_A, "another-workspace")
    expect(first).toBe(again)
    expect(first).toMatch(/^[a-f0-9]{16}$/)
    expect(new Set([first, other, scoped]).size).toBe(3)
    expect(first).not.toContain(KEY_A.slice(0, 8))
  })

  it("orders the active secret first and keeps the retained ones", async () => {
    expect(configuredMasters({})).toEqual([])
    expect(configuredMasters({ VAULT_MASTER_KEY: KEY_B })).toEqual([KEY_B])
    expect(configuredMasters({ VAULT_MASTER_KEY: KEY_B, VAULT_MASTER_KEY_PREVIOUS: `${KEY_A}, c ,,${KEY_B}` }))
      .toEqual([KEY_B, KEY_A, "c"])
  })

  it("reads a retained archive by its key id after rotation", async () => {
    const ring = await archiveKeyRing({ VAULT_MASTER_KEY: KEY_B, VAULT_MASTER_KEY_PREVIOUS: KEY_A }, "workspace")
    const oldId = await archiveKeyId(KEY_A, "workspace")
    const newId = await archiveKeyId(KEY_B, "workspace")
    expect(ring.active.id).toBe(newId)
    expect(selectArchiveKey(ring, newId)).toBe(ring.active)
    expect(selectArchiveKey(ring, oldId)).toBe(ring.previous[0])
  })

  it("refuses to guess for an unnamed archive when more than one key is configured", async () => {
    const single = await archiveKeyRing({ VAULT_MASTER_KEY: KEY_A }, "workspace")
    expect(selectArchiveKey(single, undefined)).toBe(single.active)

    const rotated = await archiveKeyRing({ VAULT_MASTER_KEY: KEY_B, VAULT_MASTER_KEY_PREVIOUS: KEY_A }, "workspace")
    expect(() => selectArchiveKey(rotated, undefined)).toThrow(/no key id and more than one master key/)
    expect(() => selectArchiveKey(rotated, "deadbeefdeadbeef")).toThrow(/VAULT_MASTER_KEY_PREVIOUS/)
  })

  it("stamps the key identity only when one is known", () => {
    expect(archiveMetadata({ encrypted: "1" }, "abc")).toEqual({ encrypted: "1", keyId: "abc" })
    expect(archiveMetadata({ encrypted: "0" }, undefined)).toEqual({ encrypted: "0" })
  })
})
