import { describe, expect, test } from "bun:test"
import { deriveWorkspaceKey } from "@chester-hill-solutions/vault/core"
import {
  ArchiveCryptoError,
  decryptBytes,
  decryptTransform,
  encryptBytes,
  encryptedLength,
  encryptTransform,
} from "../src/archive-crypto"

const MASTER = "aa".repeat(32)

async function keyFor(workspace = "tenant-1") {
  return deriveWorkspaceKey(MASTER, workspace)
}

describe("archive crypto", () => {
  test("round-trips an empty, small and multi-chunk archive", async () => {
    const key = await keyFor()
    for (const plain of [new Uint8Array(0), new TextEncoder().encode("hello"), new Uint8Array(5000).fill(7)]) {
      const sealed = await encryptBytes(plain, key, 1024)
      expect(sealed.byteLength).toBe(encryptedLength(plain.byteLength, 1024))
      expect(await decryptBytes(sealed, key)).toEqual(plain)
    }
  })

  test("rejects a different tenant key", async () => {
    const sealed = await encryptBytes(new TextEncoder().encode("secret"), await keyFor("tenant-1"))
    await expect(decryptBytes(sealed, await keyFor("tenant-2"))).rejects.toBeInstanceOf(
      ArchiveCryptoError,
    )
  })

  test("rejects truncation and tampering", async () => {
    const key = await keyFor()
    const sealed = await encryptBytes(new TextEncoder().encode("secret"), key, 4)
    await expect(decryptBytes(sealed.slice(0, sealed.length - 1), key)).rejects.toBeInstanceOf(
      ArchiveCryptoError,
    )
    const tampered = sealed.slice()
    tampered[tampered.length - 20] ^= 1
    await expect(decryptBytes(tampered, key)).rejects.toBeInstanceOf(ArchiveCryptoError)
  })

  test("streams both ways with the same format", async () => {
    const key = await keyFor()
    const plain = new TextEncoder().encode("streamed archive body ".repeat(200))
    const sealed = await new Response(
      new Blob([plain]).stream().pipeThrough(encryptTransform(key, 512)),
    ).arrayBuffer()
    expect(sealed.byteLength).toBe(encryptedLength(plain.byteLength, 512))
    const restored = new Uint8Array(
      await new Response(
        new Blob([new Uint8Array(sealed)]).stream().pipeThrough(decryptTransform(key)),
      ).arrayBuffer(),
    )
    expect(restored).toEqual(plain)
  })

  test("rejects a stream without the final frame", async () => {
    const key = await keyFor()
    const sealed = await encryptBytes(new TextEncoder().encode("secret"), key, 4)
    // Cut the final frame off; the decoder must not return a partial archive.
    await expect(
      new Response(
        new Blob([sealed.slice(0, sealed.length - 32)]).stream().pipeThrough(decryptTransform(key)),
      ).arrayBuffer(),
    ).rejects.toBeInstanceOf(ArchiveCryptoError)
  })

  test("the ciphertext does not contain the plaintext", async () => {
    const key = await keyFor()
    const plain = new TextEncoder().encode("unique-plaintext-marker")
    const sealed = await encryptBytes(plain, key)
    expect(new TextDecoder().decode(sealed)).not.toContain("unique-plaintext-marker")
  })
})
