import { describe, expect, it, vi } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { driveConversationJobs } from "./helpers/conversation-jobs"
import { deriveWorkspaceKey } from "@chester-hill-solutions/vault/core"
import { decryptBytes } from "../src/archive-crypto"
import type { CheckpointManifest, ConversationState } from "../src/state"
import { usageLogResponse } from "./helpers/usage-log"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"

/**
 * Split checkpoints keep the workspace and harness state in separate R2
 * objects. The manifest names both; restore writes each archive back to its
 * own root, never across them.
 */

const WORKSPACE = new TextEncoder().encode("workspace-archive-v1")
const STATE = new TextEncoder().encode("state-archive-v1")

function fakeContainer(options: { changingWorkspace?: boolean; changingState?: boolean } = {}) {
  let initialized = true
  let prompted = false
  const restores: Array<{ part: string; body: string }> = []
  const controls: string[] = []
  let workspaceRevision = 0
  let stateRevision = 0

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
        controls.push(`${request.method} ${url.pathname}${url.search}`)
        if (url.pathname === "/status") return json({ initialized })
        if (url.pathname === "/configure") return json({ ok: true })

        if (url.pathname === "/start") return json(accountingPolicyStart)
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
            if (options.changingState) stateRevision++
            if (since === "state-fp-1" && !options.changingState) {
              return new Response(null, {
                status: 204,
                headers: { "x-state-fingerprint": "state-fp-1" },
              })
            }
            return new Response(STATE.slice(), {
              headers: {
                "content-type": "application/gzip",
                "content-length": String(STATE.byteLength),
                "x-state-fingerprint": options.changingState
                  ? `state-fp-${stateRevision}`
                  : "state-fp-1",
              },
            })
          }
          if (options.changingWorkspace) workspaceRevision++
          if (since === "workspace-fp-1") {
            if (!options.changingWorkspace) {
              return new Response(null, { status: 204, headers: { "x-aboiteau-checkpoint": "split" } })
            }
          }
          return new Response(WORKSPACE.slice(), {
            headers: {
              "content-type": "application/gzip",
              "content-length": String(WORKSPACE.byteLength),
              "x-workspace-fingerprint": options.changingWorkspace
                ? `workspace-fp-${workspaceRevision}`
                : "workspace-fp-1",
              "x-aboiteau-checkpoint": "split",
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

  return {
    transport,
    restores,
    controls,
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
  it("prunes exact checkpoint basenames across pages while retaining active old parts", async () => {
    const stub = env.CONVERSATION.getByName("C1:split-prune-pages")
    const list = env.CHECKPOINTS.list.bind(env.CHECKPOINTS)
    let prunePageCount = 0
    const listSpy = vi.spyOn(env.CHECKPOINTS, "list").mockImplementation((options) => {
      prunePageCount++
      return list({ ...options, limit: Math.min(options?.limit ?? 1000, 5) })
    })
    let keys: { prefix: string; workspaces: string[]; states: string[]; unknown: string }
    try {
      keys = await runInDurableObject(stub, async (instance, state) => {
        const prefix = `workspaces/${state.id.toString()}/`
        const workspaces = Array.from({ length: 7 }, (_, i) => `${prefix}workspace-${100 + i}.tar.gz`)
        const states = Array.from({ length: 7 }, (_, i) => `${prefix}state-${100 + i}.tar.gz`)
        for (const key of [...workspaces, ...states]) await env.CHECKPOINTS.put(key, "part")
        // A small real R2 page size forces pagination without a thousand writes.
        const unknown = `${prefix}backup-workspace-101.tar.gz`
        await env.CHECKPOINTS.put(unknown, "unknown")
        for (let i = 0; i < 11; i++) {
          await env.CHECKPOINTS.put(`${prefix}foreign-${String(i).padStart(4, "0")}`, "foreign")
        }
        await state.storage.put("state", {
          checkpointManifest: {
            workspace: { key: workspaces[0]!, size: 1, encrypted: false },
            state: { key: states[0]!, size: 1, encrypted: false },
            createdAt: 100,
          },
        })
        const checkpoints = (instance as unknown as { checkpoints: { prune(): Promise<void> } }).checkpoints
        await checkpoints.prune()
        return { prefix, workspaces, states, unknown }
      })
    } finally {
      listSpy.mockRestore()
    }
    expect(prunePageCount).toBeGreaterThan(1)

    const all = await runInDurableObject(stub, async (_instance, state) => {
      const prefix = `workspaces/${state.id.toString()}/`
      let cursor: string | undefined
      const found: string[] = []
      do {
        const page = await env.CHECKPOINTS.list({ prefix, cursor })
        found.push(...page.objects.map(({ key }) => key))
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor)
      return found
    })
    expect(all.filter((key) => keys.workspaces.includes(key))).toEqual([
      keys.workspaces[0], ...keys.workspaces.slice(2),
    ])
    expect(all.filter((key) => keys.states.includes(key))).toEqual([
      keys.states[0], ...keys.states.slice(2),
    ])
    expect(all).toContain(keys.unknown)
    expect(all).toHaveLength(11 + 1 + 12)
  })

  it("retains the recorded legacy checkpoint alongside the newest five workspaces", async () => {
    const stub = env.CONVERSATION.getByName("C1:legacy-checkpoint-prune")
    const result = await runInDurableObject(stub, async (instance, state) => {
      const prefix = `workspaces/${state.id.toString()}/`
      const activeKey = `${prefix}workspace-100.tar.gz`
      const newerKeys = Array.from({ length: 7 }, (_, i) => `${prefix}workspace-${200 + i}.tar.gz`)
      for (const key of [activeKey, ...newerKeys]) await env.CHECKPOINTS.put(key, "legacy")
      await state.storage.put("state", { checkpointKey: activeKey })
      const checkpoints = (instance as unknown as {
        checkpoints: { prune(): Promise<void>; latest(): Promise<{ workspace: { key: string } } | null> }
      }).checkpoints
      await checkpoints.prune()
      const latest = await checkpoints.latest()
      const listed = await env.CHECKPOINTS.list({ prefix })
      return { activeKey, newerKeys, latestKey: latest?.workspace.key, retained: listed.objects.map(({ key }) => key) }
    })
    expect(result.latestKey).toBe(result.activeKey)
    expect(result.retained.sort()).toEqual([result.activeKey, ...result.newerKeys.slice(2)].sort())
  })

  it("keeps one unchanged state across six newer workspace archives", async () => {
    const stub = env.CONVERSATION.getByName("C1:split-six-workspaces")
    const fake = fakeContainer({ changingWorkspace: true })
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000)
    try {
      const result = await runInDurableObject(stub, async (instance, state) => {
        instance.transport = fake.transport
        const checkpoint = (instance as unknown as { checkpoints: { capture(): Promise<boolean> } }).checkpoints.capture.bind(
          (instance as unknown as { checkpoints: object }).checkpoints,
        )
        const saved: string[] = []
        for (let i = 0; i < 7; i++) {
          now.mockReturnValue(10_000 + i)
          // The fixture returns changing workspace content each time; state
          // content is unchanged after its first archive.
          await checkpoint()
          saved.push((await state.storage.get<ConversationState>("state"))!.checkpointManifest!.workspace.key)
        }
        return {
          prefix: `workspaces/${state.id.toString()}/`,
          manifest: (await state.storage.get<ConversationState>("state"))!.checkpointManifest!,
          saved,
        }
      })
      expect(result.saved).toHaveLength(7)
      expect(new Set(result.saved).size).toBe(7)
      expect(result.manifest.state?.key).toContain("state-10000.tar.gz")
      expect(fake.controls.filter((entry) => entry.includes("part=state"))).toHaveLength(7)
      const listed = await env.CHECKPOINTS.list({ prefix: result.prefix })
      expect(listed.objects.filter(({ key }) => key.includes("/workspace-")).length).toBe(5)
      expect(listed.objects.filter(({ key }) => key.includes("/state-")).length).toBe(1)
    } finally {
      now.mockRestore()
    }
  })

  it("keeps one unchanged workspace across six newer state archives", async () => {
    const stub = env.CONVERSATION.getByName("C1:split-six-states")
    const fake = fakeContainer({ changingState: true })
    const now = vi.spyOn(Date, "now").mockReturnValue(20_000)
    try {
      const result = await runInDurableObject(stub, async (instance, state) => {
        instance.transport = fake.transport
        const checkpoint = (instance as unknown as { checkpoints: { capture(): Promise<boolean> } }).checkpoints.capture.bind(
          (instance as unknown as { checkpoints: object }).checkpoints,
        )
        const saved: string[] = []
        for (let i = 0; i < 7; i++) {
          now.mockReturnValue(20_000 + i)
          await checkpoint()
          saved.push((await state.storage.get<ConversationState>("state"))!.checkpointManifest!.state!.key)
        }
        return {
          prefix: `workspaces/${state.id.toString()}/`,
          manifest: (await state.storage.get<ConversationState>("state"))!.checkpointManifest!,
          saved,
        }
      })
      expect(result.saved).toHaveLength(7)
      expect(new Set(result.saved).size).toBe(7)
      expect(result.manifest.workspace.key).toContain("workspace-20000.tar.gz")
      expect(fake.controls.filter((entry) => entry.includes("part=workspace"))).toHaveLength(7)
      const listed = await env.CHECKPOINTS.list({ prefix: result.prefix })
      expect(listed.objects.filter(({ key }) => key.includes("/workspace-")).length).toBe(1)
      expect(listed.objects.filter(({ key }) => key.includes("/state-")).length).toBe(5)
    } finally {
      now.mockRestore()
    }
  })

  it("fails preflight when either manifest part is missing before restore or startup", async () => {
    for (const missing of ["workspace", "state"] as const) {
      const stub = env.CONVERSATION.getByName(`C1:missing-${missing}-part`)
      const fake = fakeContainer()
      const result = await runInDurableObject(stub, async (instance, state) => {
        const prefix = `workspaces/${state.id.toString()}/`
        const workspace = `${prefix}workspace-200.tar.gz`
        const stateKey = `${prefix}state-200.tar.gz`
        if (missing !== "workspace") await env.CHECKPOINTS.put(workspace, WORKSPACE)
        if (missing !== "state") await env.CHECKPOINTS.put(stateKey, STATE)
        await state.storage.put("state", {
          phase: "idle",
          checkpointManifest: {
            workspace: { key: workspace, size: WORKSPACE.byteLength, encrypted: false },
            state: { key: stateKey, size: STATE.byteLength, encrypted: false },
            createdAt: 200,
          },
        })
        instance.transport = fake.transport
        fake.stop()
        await send(instance, "hello")
        return fake.controls
      })
      expect(result.some((call) => /\/(restore|configure|start)(\?|$)/.test(call))).toBe(false)
    }
  })

  it("restores an intentionally stateless manifest and a recorded legacy archive", async () => {
    const statelessStub = env.CONVERSATION.getByName("C1:stateless-checkpoint")
    const statelessFake = fakeContainer()
    const stateless = await runInDurableObject(statelessStub, async (instance, state) => {
      const key = `workspaces/${state.id.toString()}/workspace-300.tar.gz`
      await env.CHECKPOINTS.put(key, WORKSPACE)
      await state.storage.put("state", {
        phase: "idle",
        checkpointManifest: {
          workspace: { key, size: WORKSPACE.byteLength, encrypted: false },
          createdAt: 300,
        },
      })
      instance.transport = statelessFake.transport
      statelessFake.stop()
      await send(instance, "hello")
      return statelessFake.restores.map(({ part }) => part)
    })
    expect(stateless).toEqual(["workspace"])

    const legacyStub = env.CONVERSATION.getByName("C1:recorded-legacy-checkpoint")
    const legacyFake = fakeContainer()
    const legacy = await runInDurableObject(legacyStub, async (instance, state) => {
      const key = `workspaces/${state.id.toString()}/workspace-301.tar.gz`
      await env.CHECKPOINTS.put(key, WORKSPACE)
      await state.storage.put("state", { phase: "idle", checkpointKey: key })
      instance.transport = legacyFake.transport
      legacyFake.stop()
      await send(instance, "hello")
      return legacyFake.restores.map(({ part, body }) => ({ part, body }))
    })
    expect(legacy).toEqual([{ part: "workspace", body: new TextDecoder().decode(WORKSPACE) }])
  })

  it("keeps unrecorded split names out of legacy restore and recognizes old legacy keys", async () => {
    const unknownStub = env.CONVERSATION.getByName("C1:unrecorded-split-name")
    const unknownFake = fakeContainer()
    const unknown = await runInDurableObject(unknownStub, async (instance, state) => {
      await env.CHECKPOINTS.put(`workspaces/${state.id.toString()}/workspace-400.tar.gz`, WORKSPACE)
      instance.transport = unknownFake.transport
      unknownFake.stop()
      await send(instance, "hello")
      return unknownFake.restores
    })
    expect(unknown).toEqual([])

    for (const [name, key] of [
      ["numeric-legacy-name", (id: string) => `workspaces/${id}/401.tar.gz`],
      ["fixed-legacy-key", (id: string) => `workspaces/${id}.tar.gz`],
    ] as const) {
      const stub = env.CONVERSATION.getByName(`C1:${name}`)
      const fake = fakeContainer()
      const restored = await runInDurableObject(stub, async (instance, state) => {
        await env.CHECKPOINTS.put(key(state.id.toString()), WORKSPACE)
        instance.transport = fake.transport
        fake.stop()
        await send(instance, "hello")
        return fake.restores.map(({ part }) => part)
      })
      expect(restored).toEqual(["workspace"])
    }
  })

  it("stores both archives plus a manifest and restores each to its own root", async () => {
    const stub = env.CONVERSATION.getByName("C1:split-checkpoint")
    const fake = fakeContainer()

    const checkpointed = await runInDurableObject(stub, async (instance, state) => {
      instance.transport = fake.transport
      await send(instance, "hello")
      await driveConversationJobs(instance, state.storage, ["turn:observe"])
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
      await driveConversationJobs(instance, state.storage, ["turn:observe"])
      return (await state.storage.get<ConversationState>("state"))?.checkpointManifest
    })
    expect(first?.state).toBeTruthy()

    await env.CHECKPOINTS.delete(first!.state!.key)

    const second = await runInDurableObject(stub, async (instance, state) => {
      instance.transport = fake.transport
      await (instance as unknown as { checkpoints: { capture(): Promise<boolean> } }).checkpoints.capture()
      return (await state.storage.get<ConversationState>("state"))?.checkpointManifest
    })

    expect(second!.workspace.key).toBe(first!.workspace.key)
    expect(second!.state!.key).not.toBe(first!.state!.key)
    expect(await env.CHECKPOINTS.head(second!.state!.key)).toBeTruthy()
  })
})
