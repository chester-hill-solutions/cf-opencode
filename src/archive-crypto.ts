/**
 * Chunked AES-256-GCM for workspace/state archives.
 *
 * The vault's `encrypt` is string-based. Archives are streams, so this module
 * defines a framed format that can be encrypted and decrypted chunk by chunk:
 *
 *   "ABO1" | u32 chunkSize
 *   repeat: iv[12] | u32 flagsAndLength | ciphertext+tag
 *
 * The high bit of `flagsAndLength` marks the final frame; the low 31 bits are
 * the ciphertext length. Each frame is bound to its index as additional data,
 * and the final frame is bound to a fixed sentinel, so reordering, truncation,
 * or dropping the final marker fails authentication.
 */

const MAGIC = [0x41, 0x42, 0x4f, 0x31] as const // "ABO1"
const HEADER = 8
const IV_LENGTH = 12
const TAG_LENGTH = 16
const FINAL_FLAG = 0x80000000
const FINAL_AAD = 0xffffffff
export const DEFAULT_CHUNK_SIZE = 1024 * 1024

export class ArchiveCryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ArchiveCryptoError"
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function header(chunkSize: number): Uint8Array {
  const bytes = new Uint8Array(HEADER)
  bytes.set(MAGIC, 0)
  new DataView(bytes.buffer).setUint32(4, chunkSize)
  return bytes
}

/** Exact ciphertext length for a plaintext of `plaintextLength` bytes. */
export function encryptedLength(
  plaintextLength: number,
  chunkSize = DEFAULT_CHUNK_SIZE,
): number {
  if (!Number.isFinite(plaintextLength) || plaintextLength < 0) {
    throw new ArchiveCryptoError("plaintextLength must be a non-negative number")
  }
  const chunks = plaintextLength === 0 ? 0 : Math.ceil(plaintextLength / chunkSize)
  return HEADER + plaintextLength + chunks * (IV_LENGTH + 4 + TAG_LENGTH) + (IV_LENGTH + 4 + TAG_LENGTH)
}

function aadFor(index: number, final: boolean): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(4))
  new DataView(bytes.buffer).setUint32(0, final ? FINAL_AAD : index)
  return bytes
}

async function seal(
  key: CryptoKey,
  plaintext: Uint8Array,
  index: number,
  final: boolean,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
  const data = new Uint8Array(plaintext)
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aadFor(index, final) },
      key,
      data,
    ),
  )
  const frame = new Uint8Array(IV_LENGTH + 4 + ciphertext.length)
  frame.set(iv, 0)
  new DataView(frame.buffer).setUint32(
    IV_LENGTH,
    ciphertext.length | (final ? FINAL_FLAG : 0),
  )
  frame.set(ciphertext, IV_LENGTH + 4)
  return frame
}

async function open(
  key: CryptoKey,
  frame: Uint8Array,
  index: number,
  final: boolean,
): Promise<Uint8Array> {
  const iv = new Uint8Array(frame.subarray(0, IV_LENGTH))
  const ciphertext = new Uint8Array(frame.subarray(IV_LENGTH + 4))
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: aadFor(index, final) },
      key,
      ciphertext,
    )
    return new Uint8Array(plaintext)
  } catch {
    throw new ArchiveCryptoError("archive frame failed authentication")
  }
}

export async function encryptBytes(
  plaintext: Uint8Array,
  key: CryptoKey,
  chunkSize = DEFAULT_CHUNK_SIZE,
): Promise<Uint8Array> {
  const frames: Uint8Array[] = [header(chunkSize)]
  let index = 0
  for (let offset = 0; offset < plaintext.length; offset += chunkSize) {
    frames.push(await seal(key, plaintext.subarray(offset, offset + chunkSize), index++, false))
  }
  frames.push(await seal(key, new Uint8Array(0), 0, true))
  return concat(frames)
}

export async function decryptBytes(ciphertext: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  if (ciphertext.length < HEADER) throw new ArchiveCryptoError("archive is truncated")
  for (let i = 0; i < MAGIC.length; i++) {
    if (ciphertext[i] !== MAGIC[i]) throw new ArchiveCryptoError("archive has no Aboiteau header")
  }
  const chunkSize = new DataView(
    ciphertext.buffer,
    ciphertext.byteOffset,
    ciphertext.byteLength,
  ).getUint32(4)
  if (chunkSize === 0) throw new ArchiveCryptoError("archive has an invalid chunk size")

  const out: Uint8Array[] = []
  let offset = HEADER
  let index = 0
  let sawFinal = false
  while (offset < ciphertext.length) {
    if (offset + IV_LENGTH + 4 > ciphertext.length) {
      throw new ArchiveCryptoError("archive is truncated")
    }
    const view = new DataView(ciphertext.buffer, ciphertext.byteOffset + offset)
    const flagsAndLength = view.getUint32(IV_LENGTH)
    const final = (flagsAndLength & FINAL_FLAG) !== 0
    const length = flagsAndLength & 0x7fffffff
    const frameLength = IV_LENGTH + 4 + length
    if (offset + frameLength > ciphertext.length) {
      throw new ArchiveCryptoError("archive is truncated")
    }
    const frame = ciphertext.subarray(offset, offset + frameLength)
    const plaintext = await open(key, frame, index, final)
    if (final) {
      if (plaintext.length !== 0) throw new ArchiveCryptoError("archive final frame is not empty")
      sawFinal = true
      offset += frameLength
      if (offset !== ciphertext.length) throw new ArchiveCryptoError("archive has trailing data")
      break
    }
    out.push(plaintext)
    index++
    offset += frameLength
  }
  if (!sawFinal) throw new ArchiveCryptoError("archive final frame is missing")
  return concat(out)
}

/**
 * Streaming encryption. Feed plaintext chunks; the output is the framed
 * ciphertext. The final marker is written on flush.
 */
export function encryptTransform(
  key: CryptoKey,
  chunkSize = DEFAULT_CHUNK_SIZE,
): TransformStream<Uint8Array, Uint8Array> {
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  let index = 0
  let started = false
  return new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      if (!started) {
        controller.enqueue(header(chunkSize))
        started = true
      }
      pending = concat([pending, chunk])
      while (pending.length >= chunkSize) {
        const block = pending.slice(0, chunkSize)
        pending = pending.slice(chunkSize)
        controller.enqueue(await seal(key, block, index++, false))
      }
    },
    async flush(controller) {
      if (!started) {
        controller.enqueue(header(chunkSize))
        started = true
      }
      if (pending.length > 0) {
        controller.enqueue(await seal(key, pending, index++, false))
        pending = new Uint8Array(0)
      }
      controller.enqueue(await seal(key, new Uint8Array(0), 0, true))
    },
  })
}

/** Streaming decryption. Throws on truncation, reordering, or tampering. */
export function decryptTransform(key: CryptoKey): TransformStream<Uint8Array, Uint8Array> {
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
  let started = false
  let index = 0
  let sawFinal = false
  return new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      if (sawFinal) throw new ArchiveCryptoError("archive has trailing data")
      pending = concat([pending, chunk])
      if (!started) {
        if (pending.length < HEADER) return
        for (let i = 0; i < MAGIC.length; i++) {
          if (pending[i] !== MAGIC[i]) throw new ArchiveCryptoError("archive has no Aboiteau header")
        }
        started = true
        pending = pending.slice(HEADER)
      }
      for (;;) {
        if (pending.length < IV_LENGTH + 4) return
        const view = new DataView(pending.buffer, pending.byteOffset)
        const flagsAndLength = view.getUint32(IV_LENGTH)
        const final = (flagsAndLength & FINAL_FLAG) !== 0
        const length = flagsAndLength & 0x7fffffff
        const frameLength = IV_LENGTH + 4 + length
        if (pending.length < frameLength) return
        const frame = pending.slice(0, frameLength)
        pending = pending.slice(frameLength)
        const plaintext = await open(key, frame, index, final)
        if (final) {
          if (plaintext.length !== 0) throw new ArchiveCryptoError("archive final frame is not empty")
          if (pending.length !== 0) throw new ArchiveCryptoError("archive has trailing data")
          sawFinal = true
          return
        }
        controller.enqueue(plaintext)
        index++
      }
    },
    flush() {
      if (!started) throw new ArchiveCryptoError("archive is empty")
      if (!sawFinal) throw new ArchiveCryptoError("archive final frame is missing")
    },
  })
}
