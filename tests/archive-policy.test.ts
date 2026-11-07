import { describe, expect, test } from "bun:test"
import { encryptionRequired, plaintextArchivesAllowed } from "../src/archive-policy"

describe("archive encryption policy", () => {
  test("requires encryption when the vault key is configured", () => {
    expect(plaintextArchivesAllowed({ VAULT_MASTER_KEY: "aa" })).toBe(false)
    expect(encryptionRequired({ VAULT_MASTER_KEY: "aa" })).toBe(false)
  })

  test("fails closed when the key is missing", () => {
    expect(plaintextArchivesAllowed({})).toBe(false)
    expect(encryptionRequired({})).toBe(true)
  })

  test("allows plaintext only with an explicit opt-out and no key", () => {
    expect(plaintextArchivesAllowed({ ALLOW_PLAINTEXT_ARCHIVES: "1" })).toBe(true)
    expect(encryptionRequired({ ALLOW_PLAINTEXT_ARCHIVES: "1" })).toBe(false)
    // A configured key still wins over the opt-out.
    expect(
      plaintextArchivesAllowed({ VAULT_MASTER_KEY: "aa", ALLOW_PLAINTEXT_ARCHIVES: "1" }),
    ).toBe(false)
  })

  test("does not accept a truthy-looking value as the opt-out", () => {
    expect(plaintextArchivesAllowed({ ALLOW_PLAINTEXT_ARCHIVES: "true" })).toBe(false)
    expect(encryptionRequired({ ALLOW_PLAINTEXT_ARCHIVES: "true" })).toBe(true)
  })
})
