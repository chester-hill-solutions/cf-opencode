import { describe, expect, test } from "bun:test"
import { decideSecretRead, READABLE_SECRET_KEYS } from "../src/secret-read-policy"
import { GITHUB_TOKEN_KEY } from "../src/vault"

describe("READABLE_SECRET_KEYS", () => {
  test("is exactly the GitHub token today", () => {
    expect([...READABLE_SECRET_KEYS]).toEqual([GITHUB_TOKEN_KEY])
  })
})

describe("decideSecretRead", () => {
  test("allows the key the harness actually reads", () => {
    expect(decideSecretRead(GITHUB_TOKEN_KEY)).toEqual({ allowed: true, key: GITHUB_TOKEN_KEY })
  })

  test("refuses any other credential by name", () => {
    for (const key of ["provider:openai:apiKey", "provider:opencode:apiKey", "github.login", "VAULT_MASTER_KEY"]) {
      expect(decideSecretRead(key)).toEqual({ allowed: false, reason: "not-readable" })
    }
  })

  test("refuses a key that is not a usable name", () => {
    for (const key of [undefined, null, 42, "", "x".repeat(257)]) {
      expect(decideSecretRead(key)).toEqual({ allowed: false, reason: "invalid-key" })
    }
  })
})
