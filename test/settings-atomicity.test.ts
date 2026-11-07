import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"

/**
 * The Settings Durable Object is a singleton shared by every conversation.
 * Two requests can arrive together and both read the same record before either
 * writes, so the object must serialize its read-modify-write routes.
 */

const settings = () => env.SETTINGS.getByName("global")

function put(body: unknown): Promise<Response> {
  return settings().fetch("https://settings/put", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

async function reset(): Promise<void> {
  await runInDurableObject(settings(), async (_instance, state) => {
    await state.storage.deleteAll()
  })
}

describe("settings atomicity", () => {
  it("bumps the version once per concurrent save without losing one", async () => {
    await reset()
    const before = (await (await settings().fetch("https://settings/get")).json()) as {
      version: number
    }

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) => put({ pollSeconds: 2 + index })),
    )
    expect(responses.every((response) => response.ok)).toBe(true)

    const after = (await (await settings().fetch("https://settings/get")).json()) as {
      version: number
    }
    expect(after.version).toBe(before.version + 10)
  })

  it("grants at most maxContainers leases when callers acquire together", async () => {
    await reset()
    expect((await put({ maxContainers: 2 })).ok).toBe(true)

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        settings().fetch("https://settings/leases/acquire", {
          method: "POST",
          body: JSON.stringify({ id: `conversation-${index}` }),
        }),
      ),
    )

    const statuses = responses.map((response) => response.status)
    expect(statuses.filter((status) => status === 200)).toHaveLength(2)
    expect(statuses.filter((status) => status === 429)).toHaveLength(18)
  })
})
