import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { deriveWorkspaceKey } from "@chester-hill-solutions/vault/core"
import { decryptBytes } from "../src/archive-crypto"
import type { CheckpointManifest, ConversationState } from "../src/state"

/**
 * Split checkpoints keep the workspace and harness state in separate R2
 * objects. The manifest names both; restore writes each archive back to its
 * own root, never across them.
 */

const WORKSPACE = new TextEncoder().encode("workspace-archive-v1")
const STATE = new TextEncoder().encode("state-archive-v1")

function fakeContainer() {
  let initialized = true
  let prompted = false
  const restores: Array<{ part: string; body: string }> = []

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
        if (url.pathname === "/status") return json({ initialized })
        if (url.pathname === "/configure" || url.pathname === "/start") return json({ ok: true })
        if (url.pathname === "/restore" && request.method === "POST") {
          restores.push({
            part: url.searchParams.get("part") ?? "workspace",
            body: await request.text(),
          })
          initialized = true
          return json({ ok: true })
        }
        if (url.pathname === "/checkpoint") {
          const part = url.searchParams.get("part")
          const since = url.searchParams.get("since")
          if (part === "state") {
            if (since === "state-fp-1") {
              return new Response(null, {
                status: 204,
                headers: { "x-state-fingerprint": "state-fp-1" },
              })
            }
            return new Response(STATE.slice(), {
              headers: {
                "content-type": "application/gzip",
                "content-length": String(STATE.byteLength),
                "x-state-fingerprint": "state-fp-1",
              },
            })
          }
          if (since === "workspace-fp-1") {
            return new Response(null, { status: 204, headers: { "x-aboiteau-checkpoint": "split" } })
          }
          return new Response(WORKSPACE.slice(), {
            headers: {
              "content-type": "application/gzip",
              "content-length": String(WORKSPACE.byteLength),
              "x-workspace-fingerprint": "workspace-fp-1",
              "x-aboiteau-checkpoint": "split",
            },
          })
        }
        return json({ error: "not found" }, 404)
      }

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
        return json({
          data: prompted
            ? [
                { id: "u1", type: "user", content: [{ type: "text", text: "hello" }] },
                {
                  id: "a1",
                  type: "assistant",
                  time: { created: 1, completed: 2 },
                  finish: "stop",
                  content: [{ type: "text", text: "done" }],
                },
              ]
            : [],
        })
      }
      if (url.pathname === "/api/session/ses_1/permission") return json({ data: [] })
      if (url.pathname === "/api/event") return new Response("", { status: 200 })
      return json({ error: "not found" }, 404)
    },
  })

  return {
    transport,
    restores,
    stop: () => {
      initialized = false
    },
  }
}

async function send(instance: any, text: string) {
  const response = await instance.fetch(
    new Request("https://conversation/message", {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  )
  await response.text()
}

describe("split checkpoints", () => {
  it("stores both archives plus a manifest and restores each to its own root", async () => {
    const stub = env.CONVERSATION.getByName("C1:split-checkpoint")
    const fake = fakeContainer()

    const checkpointed = await runInDurableObject(stub, async (instance, state) => {
      instance.transport = fake.transport
      await send(instance, "hello")
      await instance.alarm()
      return {
        stored: await state.storage.get<ConversationState>("state"),
        prefix: `workspaces/${state.id.toString()}/`,
      }
    })

    const manifest = checkpointed.stored?.checkpointManifest
    expect(manifest?.workspace.key).toContain("/workspace-")
    expect(manifest?.state?.key).toContain("/state-")
    expect(manifest?.fingerprint).toBe("workspace-fp-1")
    expect(manifest?.stateFingerprint).toBe("state-fp-1")

    const listed = await env.CHECKPOINTS.list({ prefix: checkpointed.prefix })
    expect(listed.objects.map((entry) => entry.key).sort()).toEqual(
      [manifest!.workspace.key, manifest!.state!.key].sort(),
    )

    // Both objects are framed ciphertext under the tenant key.
    const key = await deriveWorkspaceKey(env.VAULT_MASTER_KEY!, "default")
    const workspace = await env.CHECKPOINTS.get(manifest!.workspace.key)
    const stateObject = await env.CHECKPOINTS.get(manifest!.state!.key)
    expect(
      await decryptBytes(new Uint8Array(await workspace!.arrayBuffer()), key),
    ).toEqual(WORKSPACE)
    expect(
      await decryptBytes(new Uint8Array(await stateObject!.arrayBuffer()), key),
    ).toEqual(STATE)

    // Force the next start to take the restore path.
    await runInDurableObject(stub, async (instance) => {
      instance.transport = fake.transport
      fake.stop()
      ;(instance as unknown as { ready: boolean }).ready = false
      ;(instance as unknown as { opencodePort?: unknown }).opencodePort = undefined
      await send(instance, "again")
    })

    expect(fake.restores.map((entry) => entry.part)).toEqual(["workspace", "state"])
    expect(fake.restores[0]!.body).toBe(new TextDecoder().decode(WORKSPACE))
    expect(fake.restores[1]!.body).toBe(new TextDecoder().decode(STATE))
  })

  it("re-archives a deleted state part without re-uploading the workspace", async () => {
    const stub = env.CONVERSATION.getByName("C1:split-rearchive")
    const fake = fakeContainer()

    const first = await runInDurableObject(stub, async (instance, state) => {
      instance.transport = fake.transport
      await send(instance, "hello")
      await instance.alarm()
      return (await state.storage.get<ConversationState>("state"))?.checkpointManifest
    })
    expect(first?.state).toBeTruthy()

    await env.CHECKPOINTS.delete(first!.state!.key)

    const second = await runInDurableObject(stub, async (instance, state) => {
      instance.transport = fake.transport
      await (instance as unknown as { checkpoint(): Promise<boolean> }).checkpoint()
      return (await state.storage.get<ConversationState>("state"))?.checkpointManifest
    })

    expect(second!.workspace.key).toBe(first!.workspace.key)
    expect(second!.state!.key).not.toBe(first!.state!.key)
    expect(await env.CHECKPOINTS.head(second!.state!.key)).toBeTruthy()
  })
})
