import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { deriveWorkspaceKey } from "@chester-hill-solutions/vault/core"
import { decryptBytes } from "../src/archive-crypto"
import { usageLogResponse } from "./helpers/usage-log"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"
import { driveConversationJobs } from "./helpers/conversation-jobs"

/**
 * Workspace archives carry source and (today) OpenCode state. With a vault key
 * configured, the R2 object must be framed ciphertext, not the plaintext tar.
 */

const PLAINTEXT = new TextEncoder().encode("plain-workspace-archive")

function fakeContainer() {
  let prompted = false
  const transport = (port: number) => ({
    async fetch(input: Request | string | URL): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input)
      const url = new URL(request.url)
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        })

      if (port === 4001) {
        if (url.pathname === "/status") return json({ initialized: true })
        if (url.pathname === "/configure") return json({ ok: true })

        if (url.pathname === "/start") return json(accountingPolicyStart)
        if (url.pathname === "/checkpoint") {
          return new Response(PLAINTEXT.slice(), {
            status: 200,
            headers: {
              "content-type": "application/gzip",
              "content-length": String(PLAINTEXT.byteLength),
              "x-workspace-fingerprint": "fp-encrypted",
            },
          })
        }
        return json({ error: "not found" }, 404)
      }

      if (url.pathname === "/api/config") return json(accountingPolicyConfig)

      if (url.pathname === "/api/session/ses_1") return json({ data: { id: "ses_1" } })
      if (url.pathname === "/api/session" && request.method === "POST") {
        return json({ data: { id: "ses_1" } })
      }
      if (url.pathname === "/api/session/ses_1/model") return new Response(null, { status: 204 })
      if (url.pathname === "/api/session/ses_1/prompt") {
        prompted = true
        return json({ data: {} })
      }
      if (url.pathname === "/api/session/ses_1/context") {
        const now = Date.now()
        return json({
          data: prompted
            ? [
                { id: "u1", type: "user", content: [{ type: "text", text: "hello" }] },
                {
                  id: "a1",
                  type: "assistant",
                  time: { created: now - 1, completed: now },
                  finish: "stop",
                  cost: 0,
                  content: [{ type: "text", text: "done" }],
                },
              ]
            : [],
        })
      }
      if (url.pathname === "/api/experimental/session/ses_1/log") {
        const now = Date.now()
        return usageLogResponse(input, "ses_1", prompted
          ? [{ id: "a1", type: "assistant", cost: 0, time: { created: now - 1, completed: now } }]
          : [])
      }
      if (url.pathname === "/api/session/ses_1/permission") return json({ data: [] })
      if (url.pathname === "/api/event") return new Response("", { status: 200 })
      return json({ error: "not found" }, 404)
    },
  })
  return { transport }
}

describe("checkpoint encryption", () => {
  it("stores framed ciphertext and can decrypt it with the tenant key", async () => {
    const stub = env.CONVERSATION.getByName("C1:checkpoint-encryption")
    const result = await runInDurableObject(stub, async (instance, state) => {
      const fake = fakeContainer()
      instance.transport = fake.transport

      const sent = await instance.fetch(
        new Request("https://conversation/message", {
          method: "POST",
          body: JSON.stringify({ text: "hello" }),
        }),
      )
      await sent.text()
      await driveConversationJobs(instance, state.storage, ["turn:observe"])

      const saved = await state.storage.get<{ checkpointKey?: string }>("state")
      const prefix = `workspaces/${state.id.toString()}/`
      const listed = await env.CHECKPOINTS.list({ prefix })
      const object = listed.objects[0]
      const head = object ? await env.CHECKPOINTS.head(object.key) : undefined
      const body = object ? await (await env.CHECKPOINTS.get(object.key))?.arrayBuffer() : undefined
      return {
        checkpointKey: saved?.checkpointKey,
        keys: listed.objects.map((entry) => entry.key),
        encrypted: head?.customMetadata?.encrypted,
        bytes: body ? new Uint8Array(body) : undefined,
      }
    })

    expect(result.keys).toEqual([result.checkpointKey])
    expect(result.encrypted).toBe("1")
    expect(result.bytes).toBeTruthy()
    // The stored object must not contain the plaintext archive.
    expect(new TextDecoder().decode(result.bytes)).not.toContain("plain-workspace-archive")
    const key = await deriveWorkspaceKey(env.VAULT_MASTER_KEY!, "default")
    expect(await decryptBytes(result.bytes!, key)).toEqual(PLAINTEXT)
  })
})
