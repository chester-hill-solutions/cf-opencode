import { describe, expect, test } from "bun:test"
import { accountArchiveBoundary, isFreshStoppedRuntime } from "./account-seed-contract"

const BLOCK = 512
function field(block: Uint8Array, start: number, length: number, value: string): void {
  block.set(new TextEncoder().encode(value), start)
}
function octal(block: Uint8Array, start: number, length: number, value: number): void {
  field(block, start, length, value.toString(8).padStart(length - 1, "0") + "\0")
}
function header(name: string, type = "0", size = 0): Uint8Array {
  const block = new Uint8Array(BLOCK)
  field(block, 0, 100, name)
  octal(block, 100, 8, 0o644)
  octal(block, 108, 8, 1001)
  octal(block, 116, 8, 1001)
  octal(block, 124, 12, size)
  octal(block, 136, 12, 0)
  block.fill(32, 148, 156)
  block[156] = type.charCodeAt(0)
  field(block, 257, 6, "ustar\0")
  field(block, 263, 2, "00")
  let checksum = 0
  for (const byte of block) checksum += byte
  field(block, 148, 8, checksum.toString(8).padStart(6, "0") + "\0 ")
  return block
}
function archive(...headers: Uint8Array[]): Uint8Array {
  return new Uint8Array([...headers.flatMap((item) => [...item]), ...new Uint8Array(BLOCK * 2)])
}

describe("account seed archive boundary", () => {
  test("accepts a complete standard account archive without excluded state", () => {
    expect(accountArchiveBoundary(archive(header("./"), header("./account-seed-marker")))).toBe(true)
  })

  test("rejects Stow state and initialization markers", () => {
    expect(accountArchiveBoundary(archive(header("./stow/identity.json")))).toBe(false)
    expect(accountArchiveBoundary(archive(header("./initialized")))).toBe(false)
  })

  test("rejects truncated terminators, corrupted checksums and unsupported member types", () => {
    const good = archive(header("./settings.json"))
    expect(accountArchiveBoundary(good.slice(0, good.length - BLOCK))).toBe(false)
    const corrupt = good.slice()
    corrupt[0] ^= 1
    expect(accountArchiveBoundary(corrupt)).toBe(false)
    expect(accountArchiveBoundary(archive(header("./link", "2")))).toBe(false)
  })
})

describe("account seed recipient freshness", () => {
  test("only admits an unstarted conversation with no persisted startup token or prior attempt", () => {
    expect(isFreshStoppedRuntime({ running: false, hasControlToken: false })).toBe(true)
    expect(isFreshStoppedRuntime({ running: true, hasControlToken: false })).toBe(false)
    expect(isFreshStoppedRuntime({ running: false, hasControlToken: true })).toBe(false)
    expect(isFreshStoppedRuntime({ running: false, hasControlToken: false, verificationAttempted: true })).toBe(false)
  })
})
