import { afterEach, describe, expect, it, vi } from "vitest"
import { env, runInDurableObject, SELF } from "cloudflare:test"
import type { Conversation } from "../src/conversation"
import type { ConversationRuntimeAccess } from "../src/conversation/runtime-access"
import { runtimeCache } from "./helpers/runtime-cache"

const API = { authorization: "Bearer test-token" }
const PATH = "/workspace/preflight"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function internals(instance: Conversation) {
  return instance as unknown as {
    ctx: object
    runtimeAccess: ConversationRuntimeAccess
    controlPlane: { token(): Promise<string>; clearCache(): void }
    env: { CONTAINER_URL?: string }
  }
}

async function installWarm(instance: Conversation, inspect: (request: Request) => Response | Promise<Response>) {
  const calls: string[] = []
  let starts = 0
  const container = {
    running: true,
    start() { starts++; throw new Error("passive inspection attempted startup") },
    async setInactivityTimeout() { throw new Error("passive inspection extended idle time") },
    getTcpPort(port: number) {
      return { async fetch(input: Request | string | URL, init?: RequestInit) {
        const request = input instanceof Request ? input : new Request(input, init)
        const path = new URL(request.url).pathname
        calls.push(`${port} ${request.method} ${path}`)
        if (path === "/health") throw new Error("passive inspection must not probe or retry health")
        expect(port).toBe(4001)
        expect(request.headers.get("authorization")).toBe(`Bearer ${token}`)
        expect(path).toBe(PATH)
        return inspect(request)
      } }
    },
  }
  Object.defineProperty(internals(instance).ctx, "container", { configurable: true, value: container })
  const token = await internals(instance).controlPlane.token()
  runtimeCache(instance).markVerified({ fetch: async () => { throw new Error("OpenCode must not be called") } }, "preflight-generation", true)
  return { calls, container, starts: () => starts }
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe("passive workspace preflight", () => {
  it("uses API authentication/key validation and allows only GET without registering conversations", async () => {
    const settings = env.SETTINGS.getByName("global")
    const before = await (await settings.fetch("https://settings/conversations")).json()
    const url = "https://harness.test/api/conversations/preflight-passive/workspace/preflight"
    expect((await SELF.fetch(url)).status).toBe(401)
    expect((await SELF.fetch("https://harness.test/api/conversations/bad%2Fkey/workspace/preflight", { headers: API })).status).toBe(400)
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      const response = await SELF.fetch(url, { method, headers: API })
      expect(response.status).toBe(405)
      expect(response.headers.get("allow")).toBe("GET")
    }
    const response = await SELF.fetch(url, { headers: API })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: "WORKSPACE_NOT_RUNNING" })
    const after = await (await settings.fetch("https://settings/conversations")).json()
    expect(after).toEqual(before)
  })

  it("keeps a cold DO inspection passive, including lifecycle, tokens, jobs and reservation state", async () => {
    const stub = env.CONVERSATION.getByName("C1:preflight-cold")
    await runInDurableObject(stub, async (instance, state) => {
      let starts = 0
      Object.defineProperty(internals(instance).ctx, "container", { configurable: true, value: {
        running: false,
        start() { starts++; throw new Error("must not start") },
        getTcpPort() { throw new Error("must not contact runtime") },
      } })
      const before = await state.storage.list()
      const alarmBefore = await state.storage.getAlarm()
      const epoch = internals(instance).runtimeAccess.activityEpoch
      const response = await instance.fetch(new Request(`https://conversation${PATH}`))
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: "WORKSPACE_NOT_RUNNING", message: expect.stringContaining("message/start") })
      expect(await state.storage.list()).toEqual(before)
      expect(await state.storage.getAlarm()).toBe(alarmBefore)
      expect(internals(instance).runtimeAccess.activityEpoch).toBe(epoch)
      expect(starts).toBe(0)
    })
  })

  it("preserves a warm report through the authenticated public route without registry mutation", async () => {
    const key = "C1:preflight-public-warm"
    const stub = env.CONVERSATION.getByName(key)
    const body = JSON.stringify({ version: 1, readiness: "blocked", checks: [] })
    await runInDurableObject(stub, async (instance) => {
      await installWarm(instance, () => new Response(body, { status: 422, headers: {
        "content-type": "application/json", "x-preflight-version": "1",
      } }))
    })
    const settings = env.SETTINGS.getByName("global")
    const before = await (await settings.fetch("https://settings/conversations")).json()
    const response = await SELF.fetch(`https://harness.test/api/conversations/${key}/workspace/preflight`, { headers: API })
    expect(response.status).toBe(422)
    expect(response.headers.get("x-preflight-version")).toBe("1")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.text()).toBe(body)
    expect(await (await settings.fetch("https://settings/conversations")).json()).toEqual(before)
  })

  it("forwards warm control output/status/headers without OpenCode, idle renewal or storage writes", async () => {
    const stub = env.CONVERSATION.getByName("C1:preflight-warm")
    await runInDurableObject(stub, async (instance, state) => {
      const body = JSON.stringify({ version: 1, readiness: "needs_verification", checks: [] })
      const installed = await installWarm(instance, () => new Response(body, {
        status: 202, headers: { "content-type": "application/json", "cache-control": "no-store", "x-preflight-version": "1" },
      }))
      const before = await state.storage.list()
      const access = internals(instance).runtimeAccess
      const epoch = access.activityEpoch
      const response = await instance.fetch(new Request(`https://conversation${PATH}`))
      expect(response.status).toBe(202)
      expect(response.headers.get("x-preflight-version")).toBe("1")
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(await response.text()).toBe(body)
      expect(installed.calls).toEqual(["4001 GET /workspace/preflight"])
      expect(installed.starts()).toBe(0)
      expect(access.activityEpoch).toBe(epoch)
      expect(access.activeUses).toBe(0)
      expect(await state.storage.list()).toEqual(before)
    })
  })

  it("does not start or probe when the platform stops between identity and passive port access", async () => {
    const stub = env.CONVERSATION.getByName("C1:preflight-platform-stop")
    await runInDurableObject(stub, async (instance) => {
      const installed = await installWarm(instance, () => { throw new Error("must not inspect stopped execution") })
      let runningReads = 0
      Object.defineProperty(installed.container, "running", {
        configurable: true,
        get: () => ++runningReads === 1,
      })
      const response = await instance.fetch(new Request(`https://conversation${PATH}`))
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ code: "WORKSPACE_NOT_RUNNING" })
      expect(runningReads).toBeGreaterThanOrEqual(2)
      expect(installed.starts()).toBe(0)
      expect(installed.calls).toEqual([])
      expect(internals(instance).runtimeAccess.activeUses).toBe(0)
    })
  })

  it("forwards the bounded abort signal through the external control adapter without health probes", async () => {
    const stub = env.CONVERSATION.getByName("C1:preflight-external-abort")
    await runInDurableObject(stub, async (instance) => {
      const installed = await installWarm(instance, () => { throw new Error("native adapter must not be used") })
      const internal = internals(instance)
      const previous = internal.env
      const isolated = Object.create(previous) as typeof previous
      Object.defineProperty(isolated, "CONTAINER_URL", { value: "http://synthetic-runtime.invalid", enumerable: true })
      internal.env = isolated
      const controller = new AbortController()
      const started = deferred()
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal)
      let signal: AbortSignal | undefined
      const upstream = vi.fn(async (input: Request | string | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        expect(request.url).toBe("http://synthetic-runtime.invalid:4001/workspace/preflight")
        expect(request.method).toBe("GET")
        expect(request.redirect).toBe("manual")
        signal = request.signal
        started.resolve()
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(new Error("synthetic aborted request")), { once: true })
        })
      })
      vi.stubGlobal("fetch", upstream)
      try {
        const pending = instance.fetch(new Request(`https://conversation${PATH}`))
        await started.promise
        expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000)
        controller.abort()
        const response = await pending
        expect(response.status).toBe(503)
        expect(await response.json()).toMatchObject({ code: "WORKSPACE_PREFLIGHT_UNAVAILABLE" })
        expect(signal?.aborted).toBe(true)
        expect(upstream).toHaveBeenCalledTimes(1)
        expect(installed.calls).toEqual([])
        expect(installed.starts()).toBe(0)
        expect(internal.runtimeAccess.activeUses).toBe(0)
      } finally {
        internal.env = previous
      }
    })
  })

  it("holds its borrow through the response body and refuses a queued inspection after exclusive stop", async () => {
    const stub = env.CONVERSATION.getByName("C1:preflight-stop-fence")
    await runInDurableObject(stub, async (instance) => {
      const bodyStarted = deferred()
      const releaseBody = deferred()
      const installed = await installWarm(instance, () => new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          bodyStarted.resolve()
          await releaseBody.promise
          controller.enqueue(new TextEncoder().encode('{"version":1,"readiness":"blocked"}'))
          controller.close()
        },
      })))
      const access = internals(instance).runtimeAccess
      const first = instance.fetch(new Request(`https://conversation${PATH}`))
      await bodyStarted.promise
      let stopped = false
      const stop = access.exclusive(() => {
        stopped = true
        installed.container.running = false
        runtimeCache(instance).invalidate()
      })
      const queued = instance.fetch(new Request(`https://conversation${PATH}`))
      expect(access.activeUses).toBe(1)
      expect(stopped).toBe(false)
      releaseBody.resolve()
      expect((await first).status).toBe(200)
      await stop
      expect((await queued).status).toBe(409)
      expect(installed.calls.filter((call) => call.endsWith(PATH))).toHaveLength(1)
      expect(installed.starts()).toBe(0)
    })
  })

  it("rechecks warm identity after a queued exclusive transition and never creates missing auth", async () => {
    const stub = env.CONVERSATION.getByName("C1:preflight-generation-fence")
    await runInDurableObject(stub, async (instance, state) => {
      const installed = await installWarm(instance, () => Response.json({ version: 1, readiness: "blocked" }))
      const access = internals(instance).runtimeAccess
      const entered = deferred()
      const release = deferred()
      const transition = access.exclusive(async () => {
        entered.resolve()
        await release.promise
        runtimeCache(instance).invalidate()
      })
      await entered.promise
      const pending = instance.fetch(new Request(`https://conversation${PATH}`))
      release.resolve()
      await transition
      expect((await pending).status).toBe(409)
      expect(installed.calls).toEqual([])
      runtimeCache(instance).markVerified({ fetch: async () => new Response() }, "new-generation", true)
      internals(instance).controlPlane.clearCache()
      await state.storage.delete("controlToken")
      const before = await state.storage.list()
      expect((await instance.fetch(new Request(`https://conversation${PATH}`))).status).toBe(409)
      expect(await state.storage.list()).toEqual(before)
      expect(installed.calls).toEqual([])
    })
  })

  it("sanitizes control failures and rejects oversized output while releasing the borrow", async () => {
    for (const oversized of [false, true]) {
      const stub = env.CONVERSATION.getByName(`C1:preflight-failure-${oversized}`)
      await runInDurableObject(stub, async (instance) => {
        await installWarm(instance, () => {
          if (oversized) return new Response(new Uint8Array(256 * 1024 + 1))
          throw new Error("raw container stderr: secret-provider-value")
        })
        const response = await instance.fetch(new Request(`https://conversation${PATH}`))
        expect(response.status).toBe(503)
        expect(await response.json()).toEqual({ error: "WORKSPACE_PREFLIGHT_UNAVAILABLE", code: "WORKSPACE_PREFLIGHT_UNAVAILABLE", message: "Workspace inspection is unavailable; retry later." })
        expect(internals(instance).runtimeAccess.activeUses).toBe(0)
        const method = await instance.fetch(new Request(`https://conversation${PATH}`, { method: "POST" }))
        expect(method.status).toBe(405)
        expect(method.headers.get("allow")).toBe("GET")
      })
    }
  })
})
