import { describe, expect, test } from "bun:test"
import type { VaultKeyValueStorage } from "@chester-hill-solutions/vault/core"
import { accountVault, GITHUB_TOKEN_KEY, workspaceID, type VaultEnv } from "../src/vault"

const MASTER_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

function fakeStorage(): VaultKeyValueStorage & { entries: Map<string, unknown> } {
  const entries = new Map<string, unknown>()
  return {
    entries,
    async get<T>(key: string) {
      return entries.get(key) as T | undefined
    },
    async put(key: string, value: unknown) {
      entries.set(key, value)
    },
    async delete(key: string) {
      return entries.delete(key)
    },
    async list<T>(options: { prefix: string }) {
      const result = new Map<string, T>()
      for (const [key, value] of entries) {
        if (key.startsWith(options.prefix)) result.set(key, value as T)
      }
      return result
    },
  }
}

const env = (overrides: Partial<VaultEnv> = {}) => overrides

describe("workspaceID", () => {
  test("defaults to a single tenant", () => {
    expect(workspaceID(env())).toBe("default")
  })

  test("uses WORKSPACE_ID when set", () => {
    expect(workspaceID(env({ WORKSPACE_ID: "acme" }))).toBe("acme")
  })
})

describe("accountVault", () => {
  test("is unavailable without a master key", () => {
    expect(accountVault(env(), fakeStorage())).toBeUndefined()
  })

  test("rejects a master key that is not 32 bytes of hex", () => {
    expect(() => accountVault(env({ VAULT_MASTER_KEY: "too-short" }), fakeStorage())).toThrow(
      /Master key/
    )
  })

  test("round-trips a secret without storing plaintext", async () => {
    const storage = fakeStorage()
    const vault = accountVault(env({ VAULT_MASTER_KEY: MASTER_KEY }), storage)
    expect(vault).toBeDefined()

    await vault!.setSecret("default", GITHUB_TOKEN_KEY, "ghs_secret_value")
    expect(await vault!.getSecret("default", GITHUB_TOKEN_KEY)).toBe("ghs_secret_value")
    expect(JSON.stringify([...storage.entries])).not.toContain("ghs_secret_value")
  })
})
