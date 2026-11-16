import { beforeEach, describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import type { Conversation } from "../src/conversation"
import type { ConversationState } from "../src/state"
import type { ContainerPort } from "../src/opencode"
import { ACCOUNTING_POLICY_ID } from "../src/accounting-policy"
import { runtimeCache } from "./helpers/runtime-cache"
import { driveConversationJobs, waitForConversationJobs } from "./helpers/conversation-jobs"

const SESSION = "ses_idle_integration"
const GENERATION = "idle-integration-generation"
const WORKSPACE_ARCHIVE = new TextEncoder().encode("encrypted-workspace-fixture")
const STATE_ARCHIVE = new TextEncoder().encode("encrypted-state-fixture")

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

async function clearSettings(): Promise<void> {
  await runInDurableObject(env.SETTINGS.getByName("global"), async (_instance, state) => state.storage.deleteAll())
  await env.SETTINGS.getByName("global").fetch("https://settings/put", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ streaming: false, dailyBudgetUSD: 0 }),
  })
}

describe("native idle close Worker integration", () => {
  beforeEach(clearSettings)

  it("keeps passive reads from moving the idle deadline, then archives before stop and releases its lease", async () => {
    const key = "C1:idle-close-integration"
    const stub = env.CONVERSATION.getByName(key)
    const events: string[] = []
    const id = await runInDurableObject(stub, async (instance, runtime) => {
      await runtime.storage.deleteAll()
      const settings = await env.SETTINGS.getByName("global").fetch("https://settings/get").then((response) => response.json()) as { version: number }
      await runtime.storage.put("state", {
        sessionID: SESSION,
        phase: "idle",
        settingsVersion: settings.version,
        seen: [],
        pending: {},
      } satisfies ConversationState)

      let running = true
      const apiPort: ContainerPort = {
        async fetch(input) {
          const request = input instanceof Request ? input : new Request(input)
          const url = new URL(request.url)
          events.push(`api:${url.pathname}`)
          if (url.pathname.endsWith(`/experimental/session/${SESSION}/log`)) {
            return new Response(`data: ${JSON.stringify({ type: "log.synced", aggregateID: SESSION, seq: 0 })}\n\n`, {
              headers: { "content-type": "text/event-stream" },
            })
          }
          if (url.pathname.endsWith(`/experimental/session/${SESSION}/wait`)) return new Response(null, { status: 204 })
          if (url.pathname.endsWith(`/session/${SESSION}/context`)) return json({ data: [] })
          if (url.pathname.endsWith(`/session/${SESSION}/inbox`)) return json({ data: [] })
          if (url.pathname.endsWith(`/session/${SESSION}/form`)) return json({ data: [] })
          if (url.pathname.endsWith("/permission/request")) return json({ data: [] })
          if (url.pathname.endsWith(`/session/${SESSION}`)) return json({ data: {
            id: SESSION,
            location: { directory: "/workspace" },
            time: { created: Date.now(), updated: Date.now(), idle: Date.now() },
          } })
          return json({ error: "not found" }, 404)
        },
      }
      const controlPort: ContainerPort = {
        async fetch(input) {
          const request = input instanceof Request ? input : new Request(input)
          const url = new URL(request.url)
          events.push(`control:${url.pathname}${url.search}`)
          if (url.pathname === "/health") return json({ ok: true })
          if (url.pathname.startsWith("/opencode/")) {
            url.pathname = url.pathname.slice("/opencode".length)
            return apiPort.fetch(new Request(url, request))
          }
          if (url.pathname === "/start") return json({
            ok: true,
            accountingPolicy: ACCOUNTING_POLICY_ID,
            opencodeGeneration: GENERATION,
            eventPersistence: true,
          })
          if (url.pathname === "/checkpoint") {
            const statePart = url.searchParams.get("part") === "state"
            return new Response((statePart ? STATE_ARCHIVE : WORKSPACE_ARCHIVE).slice(), {
              headers: {
                "content-type": "application/gzip",
                "x-aboiteau-checkpoint": "split",
                ...(statePart ? { "x-state-fingerprint": "b".repeat(64) } : { "x-workspace-fingerprint": "a".repeat(64) }),
              },
            })
          }
          return json({ error: "not found" }, 404)
        },
      }
      const container = {
        running: true,
        async destroy() {
          events.push("container:destroy")
          running = false
          this.running = false
        },
        async setInactivityTimeout() {},
        async snapshotContainer() { return { id: "unused-fast-snapshot", size: 1 } },
        getTcpPort(port: number) { return port === 4001 ? controlPort : apiPort },
      }
      const conversation = instance as unknown as {
        ctx: object
        key?: string
        transport?: unknown
        runtime: { markVerified(port: ContainerPort, generation: string, eventPersistence: boolean): void }
        leases: { ensureHeld(): Promise<void> }
        idleClose: { touch(): Promise<boolean> }
        scheduler: { has(id: string): boolean }
      }
      Object.defineProperty(conversation.ctx, "container", { configurable: true, value: container })
      conversation.key = key
      conversation.transport = undefined
      runtimeCache(instance).invalidate()
      conversation.runtime.markVerified(apiPort, GENERATION, true)
      await conversation.leases.ensureHeld()
      expect(conversation.scheduler.has("lease:renew")).toBe(true)
      expect(await conversation.idleClose.touch()).toBe(true)
      expect(conversation.scheduler.has("container:idle")).toBe(true)
      return runtime.id.toString()
    })

    const first = await runInDurableObject(stub, async (_instance, runtime) => runtime.storage.get<{ id: string; dueAt: number; generation: string; phase: string }>("containerIdle"))
    expect(first).toMatchObject({ generation: GENERATION, phase: "waiting" })
    await stub.fetch("https://conversation/health")
    await stub.fetch("https://conversation/state")
    await stub.fetch("https://conversation/debug")
    const afterHealth = await runInDurableObject(stub, async (_instance, runtime) => runtime.storage.get("containerIdle"))
    expect(afterHealth).toEqual(first)

    await runInDurableObject(stub, async (instance, runtime) => {
      try {
        await driveConversationJobs(instance, runtime.storage, ["container:idle"], { idle: true })
        await waitForConversationJobs(runtime.storage)
      } catch (error) {
        throw new Error(`${String(error)}\n${JSON.stringify({
          idle: await runtime.storage.get("containerIdle"),
          lease: await runtime.storage.get("containerLease"),
          claims: await runtime.storage.get("conversationJobClaims"),
          jobs: [...runtime.storage.sql.exec<{ id: string; fn: string; time: number }>(
            "SELECT id, fn, time FROM cf_agents_jobs WHERE capability = ?",
            "conversation-jobs",
          )],
          events,
        })}`)
      }
    })

    const final = await runInDurableObject(stub, async (instance, runtime) => {
      const conversation = instance as unknown as {
        scheduler: { has(id: string): boolean }
        ctx: { container?: { running?: boolean } }
      }
      const state = await runtime.storage.get<ConversationState>("state")
      const manifest = state?.checkpointManifest
      const workspace = manifest?.workspace ? await env.CHECKPOINTS.get(manifest.workspace.key) : null
      const stateObject = manifest?.state ? await env.CHECKPOINTS.get(manifest.state.key) : null
      return {
        idle: await runtime.storage.get("containerIdle"),
        lease: await runtime.storage.get("containerLease"),
        state,
        encrypted: manifest?.workspace.encrypted === true && manifest.state?.encrypted === true,
        archiveMetadata: workspace?.customMetadata?.encrypted === "1" && stateObject?.customMetadata?.encrypted === "1",
        stopped: conversation.ctx.container?.running === false,
        idleJob: conversation.scheduler.has("container:idle"),
        leaseJob: conversation.scheduler.has("lease:renew"),
      }
    })
    expect(final.idle).toBeUndefined()
    expect(final.lease).toBeUndefined()
    expect(final.encrypted).toBe(true)
    expect(final.archiveMetadata).toBe(true)
    expect(final.stopped).toBe(true)
    expect(final.idleJob).toBe(false)
    expect(final.leaseJob).toBe(false)
    expect(final.state?.sessionID).toBe(SESSION)
    const stateCheckpoint = events.findIndex((event) => event.startsWith("control:/checkpoint?part=state&since="))
    expect(events.some((event) => event.startsWith("control:/checkpoint?part=workspace&since="))).toBe(true)
    expect(stateCheckpoint).toBeGreaterThan(-1)
    expect(events.indexOf("container:destroy")).toBeGreaterThan(stateCheckpoint)
    expect(events.some((event) => event.startsWith(`api:/api/experimental/session/${SESSION}/log`))).toBe(true)
    expect(events.some((event) => event.startsWith(`api:/api/session/${SESSION}/context`))).toBe(true)
    expect(id).toBeTruthy()
  }, 20_000)
})
