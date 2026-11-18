import { beforeEach, describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"

const settings = () => env.SETTINGS.getByName("global")
/** The published vault key: a JSON tuple, not the pre-swap `vault:<ws>:<key>` string. */
const recordKey = (key: string) => JSON.stringify(["vault:", "default", key])

/**
 * A stored credential the current ciphertext format cannot read must be named,
 * not thrown. Production learned this the expensive way: a pre-v2 GitHub token
 * made `/api/onboarding/status` return a 1101 and made every clone silently
 * unauthenticated, with nothing in the response to say why.
 */
describe("Settings vault reads", () => {
  beforeEach(async () => {
    await runInDurableObject(settings(), async (_instance, runtime) => {
      await runtime.storage.deleteAll()
    })
  })

  it("names an unreadable stored credential instead of failing the DO", async () => {
    await runInDurableObject(settings(), async (_instance, runtime) => {
      const now = new Date().toISOString()
      await runtime.storage.put(recordKey("github.token"), {
        key: "github.token",
        encryptedValue: "pre-v2-ciphertext",
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null,
        expiresAt: null,
      })
    })

    const list = await settings().fetch("https://settings/secrets")
    expect(list.status).toBe(500)
    expect(await list.json()).toMatchObject({ code: "VAULT_UNREADABLE" })

    const read = await settings().fetch("https://settings/secrets/get", {
      method: "POST",
      body: JSON.stringify({ key: "github.token" }),
    })
    expect(read.status).toBe(500)
    expect(await read.json()).toMatchObject({ code: "VAULT_UNREADABLE" })
  })
})
