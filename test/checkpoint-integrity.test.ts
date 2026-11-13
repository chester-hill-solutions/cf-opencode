import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { driveConversationJobs } from "./helpers/conversation-jobs"
import { usageLogResponse } from "./helpers/usage-log"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"

/**
 * A 204 from the control server means "nothing changed since this
 * fingerprint". That is only safe if the archive the fingerprint refers to
 * still exists; a deleted R2 object must force a fresh archive.
 */

function fakeContainer() {
  const since: Array<string> = []
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
          const value = url.searchParams.get("since") ?? ""
          since.push(value)
          if (value === "fp1") return new Response(null, { status: 204 })
          return new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: {
              "x-workspace-fingerprint": "fp2",
              "content-type": "application/gzip",
              "content-length": "3",
            },
          })
        }
        return json({ error: "not found" }, 404)
      }

      if (url.pathname === "/api/config") return json(accountingPolicyConfig)

      if (url.pathname === "/api/session/ses_1") return json({ data: { id: "ses_1" } })
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
  return { transport, since }
}

async function send(instance: { fetch(request: Request): Promise<Response> }, text: string) {
  const response = await instance.fetch(
    new Request("https://conversation/message", {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  )
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe("checkpoint integrity", () => {
  it("re-archives when a 204 refers to an archive that no longer exists", async () => {
    const stub = env.CONVERSATION.getByName("C1:checkpoint-missing")
    const result = await runInDurableObject(stub, async (instance, state) => {
      const id = state.id.toString()
      const prefix = `workspaces/${id}/`
      const lost = `${prefix}gone.tar.gz`
      await state.storage.put("state", {
        phase: "idle",
        sessionID: "ses_1",
        seen: [],
        pending: {},
        checkpointFingerprint: "fp1",
        checkpointKey: lost,
        checkpointEncrypted: true,
      })

      const fake = fakeContainer()
      instance.transport = fake.transport
      const sent = await send(instance, "hello")
      expect(sent.status).toBe(200)

      await driveConversationJobs(instance, state.storage, ["turn:observe"])

      const saved = await state.storage.get<{
        checkpointFingerprint?: string
        checkpointKey?: string
      }>("state")
      const objects = await env.CHECKPOINTS.list({ prefix })
      return {
        since: fake.since,
        fingerprint: saved?.checkpointFingerprint,
        key: saved?.checkpointKey,
        keys: objects.objects.map((object) => object.key),
      }
    })

    // The first call is the failed 204, the retry archives from scratch.
    expect(result.since).toEqual(["fp1", ""])
    expect(result.fingerprint).toBe("fp2")
    expect(result.key).toBeTruthy()
    expect(result.keys).toEqual([result.key])
  })

  it("trusts a 204 when the referenced archive exists", async () => {
    const stub = env.CONVERSATION.getByName("C1:checkpoint-present")
    const result = await runInDurableObject(stub, async (instance, state) => {
      const id = state.id.toString()
      const key = `workspaces/${id}/present.tar.gz`
      await env.CHECKPOINTS.put(key, "archive")
      await state.storage.put("state", {
        phase: "idle",
        sessionID: "ses_1",
        seen: [],
        pending: {},
        checkpointFingerprint: "fp1",
        checkpointKey: key,
        checkpointEncrypted: true,
      })

      const fake = fakeContainer()
      instance.transport = fake.transport
      expect((await send(instance, "hello")).status).toBe(200)
      await driveConversationJobs(instance, state.storage, ["turn:observe"])
      return { since: fake.since }
    })

    expect(result.since).toEqual(["fp1"])
  })
})
