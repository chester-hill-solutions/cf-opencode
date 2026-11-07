import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"

/**
 * A reset clears the Durable Object, so it must also clear the R2 workspace
 * archives; otherwise the next cold start restores the workspace the operator
 * just reset.
 */

describe("conversation reset", () => {
  it("deletes the conversation's R2 checkpoints", async () => {
    const stub = env.CONVERSATION.getByName("C1:reset")
    const result = await runInDurableObject(stub, async (instance, state) => {
      const id = state.id.toString()
      const prefix = `workspaces/${id}/`
      await env.CHECKPOINTS.put(`${prefix}1.tar.gz`, "one")
      await env.CHECKPOINTS.put(`${prefix}2.tar.gz`, "two")
      await env.CHECKPOINTS.put(`workspaces/${id}.tar.gz`, "legacy")
      await env.CHECKPOINTS.put("workspaces/other/1.tar.gz", "keep")

      const response = await instance.fetch(
        new Request("https://conversation/reset", { method: "POST" }),
      )
      const own = await env.CHECKPOINTS.list({ prefix })
      const legacy = await env.CHECKPOINTS.get(`workspaces/${id}.tar.gz`)
      const other = await env.CHECKPOINTS.get("workspaces/other/1.tar.gz")
      return {
        status: response.status,
        remaining: own.objects.length,
        legacy: Boolean(legacy),
        other: Boolean(other),
      }
    })

    expect(result.status).toBe(200)
    expect(result.remaining).toBe(0)
    expect(result.legacy).toBe(false)
    expect(result.other).toBe(true)
  })
})
