import { describe, expect, test } from "bun:test"
import { Vault, createKeyValueVaultStore, type VaultKeyValueStorage } from "@chester-hill-solutions/vault/core"
import { assertNoStaleVaultRecords, migrateLegacyVaultRecords, staleVaultKeys } from "../src/vault-records"

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

const tupleKey = (workspaceID: string, key: string) => JSON.stringify(["vault:", workspaceID, key])

describe("migrateLegacyVaultRecords", () => {
  test("rewrites the legacy key and wrapper without touching the ciphertext", async () => {
    const storage = fakeStorage()
    storage.entries.set("vault:default:github.login", {
      value: "v2:abcd:1234",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-02T00:00:00.000Z",
    })

    const migration = await migrateLegacyVaultRecords(storage)

    expect(migration).toEqual({ migrated: 1, skipped: [] })
    expect(storage.entries.has("vault:default:github.login")).toBe(false)
    expect(storage.entries.get(tupleKey("default", "github.login"))).toEqual({
      key: "github.login",
      encryptedValue: "v2:abcd:1234",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-02T00:00:00.000Z",
      lastUsedAt: null,
      expiresAt: null,
    })
    expect(() => assertNoStaleVaultRecords(storage.entries.keys())).not.toThrow()
  })

  test("keeps a credential readable through the published vault", async () => {
    const storage = fakeStorage()
    const legacy = new Vault(createKeyValueVaultStore(storage), MASTER_KEY)
    // The published store writes the tuple shape; simulate the old writer by
    // moving the same ciphertext under the colon key it used to own.
    await legacy.setSecret("default", "github.token", "ghp_example")
    const written = storage.entries.get(tupleKey("default", "github.token")) as { encryptedValue: string }
    storage.entries.delete(tupleKey("default", "github.token"))
    storage.entries.set("vault:default:github.token", { value: written.encryptedValue })

    await migrateLegacyVaultRecords(storage)

    const migrated = new Vault(createKeyValueVaultStore(storage), MASTER_KEY)
    expect(await migrated.getSecret("default", "github.token")).toBe("ghp_example")
  })

  test("accepts a bare string payload from the oldest layout", async () => {
    const storage = fakeStorage()
    storage.entries.set("vault:acme:key:with:colons", "v2:ref:payload")

    const migration = await migrateLegacyVaultRecords(storage)

    expect(migration.migrated).toBe(1)
    const record = storage.entries.get(tupleKey("acme", "key:with:colons")) as Record<string, unknown>
    expect(record.encryptedValue).toBe("v2:ref:payload")
    expect(record.key).toBe("key:with:colons")
    expect(typeof record.createdAt).toBe("string")
  })

  test("leaves records it cannot read for the guard to refuse", async () => {
    const storage = fakeStorage()
    storage.entries.set("vault:default:broken", { createdAt: "2026-11-01T00:00:00.000Z" })
    storage.entries.set("vault:malformed", { value: "v2:ref:payload" })

    const migration = await migrateLegacyVaultRecords(storage)

    expect(migration).toEqual({ migrated: 0, skipped: ["vault:default:broken", "vault:malformed"] })
    expect(() => assertNoStaleVaultRecords(storage.entries.keys())).toThrow(/predate the package swap/)
  })

  test("converges on the published record when both shapes exist", async () => {
    const storage = fakeStorage()
    storage.entries.set(tupleKey("default", "github.login"), {
      key: "github.login",
      encryptedValue: "v2:new:value",
      createdAt: "2026-11-10T00:00:00.000Z",
      updatedAt: "2026-11-10T00:00:00.000Z",
      lastUsedAt: null,
      expiresAt: null,
    })
    storage.entries.set("vault:default:github.login", { value: "v2:old:value" })

    await migrateLegacyVaultRecords(storage)

    expect(storage.entries.has("vault:default:github.login")).toBe(false)
    expect((storage.entries.get(tupleKey("default", "github.login")) as { encryptedValue: string }).encryptedValue)
      .toBe("v2:new:value")
  })

  test("is a no-op without legacy records", async () => {
    const storage = fakeStorage()
    storage.entries.set(tupleKey("default", "github.login"), { key: "github.login", encryptedValue: "v2:ref:value" })

    expect(await migrateLegacyVaultRecords(storage)).toEqual({ migrated: 0, skipped: [] })
    expect(staleVaultKeys(storage.entries.keys())).toEqual([])
  })
})
