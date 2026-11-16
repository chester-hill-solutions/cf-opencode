/// <reference types="@cloudflare/workers-types" />
/// <reference path="./baseline/bindings.generated.d.ts" />
import { expect, mock, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildPermissionRules } from "../../src/permissions"
import { FROZEN_PROTOCOL_SHA256 } from "./baseline/freeze.generated"
import { taskAttemptID } from "./baseline/task-request"
import type { Env } from "../../src/env"

// These tests exercise the benchmark adapter, not a simulated claim that the
// real product ran. The protected-hook regression runs in Cloudflare Vitest.
const nativeStates = new WeakSet<object>()
class ProductDouble {
  transport?: unknown
  constructor(protected ctx: DurableObjectState, protected env: Env) {
    if (!nativeStates.has(ctx)) throw new TypeError("product constructor requires the original state object")
  }
  protected runtimeContainer(): DurableObjectState["container"] { return this.ctx.container }
  protected startOptions(): ContainerStartupOptions { return { image: this.ctx.container!.images.evented, enableInternet: true } }
  protected snapshotHandle(): Promise<ContainerSnapshot | undefined> { return Promise.resolve(undefined) }
  async alarm() {}
  async fetch(request: Request): Promise<Response> {
    const trace = (this.env as Env & { trace: Trace }).trace
    const path = new URL(request.url).pathname
    trace.calls.push(`product:${path}`)
    if (path === "/state") return Response.json(trace.state)
    if (path === "/events") return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(trace.replayText ?? ": connected\n\n")) },
      cancel() { trace.replayCancelled = true },
    }), { headers: { "content-type": "text/event-stream" } })
    if (path === "/delete") {
      if (trace.cleanupBlocked) return Response.json({ error: "real product hold remains" }, { status: 409 })
      await this.ctx.container!.destroy()
      return Response.json({ ok: true })
    }
    if (path !== "/message") throw new Error("unexpected product route")
    trace.prompts.push(await request.json())
    await trace.messageGate?.()
    const container = this.runtimeContainer()!
    container.start(this.startOptions())
    const control = container.getTcpPort(4001)
    for (const name of ["configure", "start"]) {
      const response = await control.fetch(new Request(`http://container/${name}`, { method: "POST" }))
      if (!response.ok) throw new Error("product readiness rejected")
    }
    return Response.json({ ok: true, sessionID: "session-smoke" })
  }
}
mock.module("../../src/conversation", () => ({ Conversation: ProductDouble }))
const { SmokeConversation, parseSmokeRequest, smokeProviderOverlay, smokeContainerFacade, SMOKE_CONFIG_SCRIPT, boundedPermissionReplay } = await import("./baseline/aboiteau-arm")

type Trace = {
  calls: string[]; prompts: unknown[]; state: Record<string, unknown>; running: boolean
  nativeInitialized: boolean; cleanupBlocked?: boolean; configureFails?: boolean
  messageGate?: () => Promise<void>; options?: ContainerStartupOptions; scopes: unknown[]
  replayText?: string; replayCancelled?: boolean
}

function fixture(taskID = "L1") {
  const identity = { id: taskAttemptID(taskID, "cold", 1, FROZEN_PROTOCOL_SHA256), taskID, protocolSHA256: FROZEN_PROTOCOL_SHA256, condition: "cold" as const, repetition: 1 }
  const trace: Trace = { calls: [], prompts: [], state: { phase: "idle" }, running: false, nativeInitialized: false, scopes: [] }
  const objects = new Map<string, string>()
  const native = {
    images: { base: "pinned-image", evented: "pinned-image" },
    get running() { expect(this).toBe(native); return trace.running },
    start(options: ContainerStartupOptions) { expect(this).toBe(native); trace.options = options; trace.running = true; trace.calls.push("native:start") },
    async destroy() { expect(this).toBe(native); trace.running = false; trace.calls.push("native:destroy") },
    async interceptOutboundHttp(host: string) { expect(this).toBe(native); expect(host).toBe("provider.aboiteau"); trace.calls.push("native:intercept") },
    getTcpPort(port: number) {
      expect(this).toBe(native); expect(port).toBe(4001)
      return { async fetch(request: Request) {
        const path = new URL(request.url).pathname; trace.calls.push(`control:${path}`)
        if (path === "/configure") return Response.json({ ok: !trace.configureFails }, { status: trace.configureFails ? 500 : 200 })
        if (path === "/start") { trace.nativeInitialized = true; return Response.json({ ok: true, eventPersistence: true }) }
        throw new Error("unexpected control route")
      } }
    },
    async exec(argv: string[], options: { user?: string }) {
      expect(this).toBe(native)
      const command = argv[2]!
      let output: string
      if (command.includes("unsafe config")) {
        expect(options.user).toBe("root"); trace.calls.push("exec:config"); output = "configured"
      } else if (command.includes("fixture git operation")) {
        expect(options.user).toBe("agent"); expect(trace.nativeInitialized).toBe(true); trace.calls.push("exec:fixture"); output = "b".repeat(40)
      } else if (command.includes("snapshot symlink refused")) {
        expect(options.user).toBe("agent"); trace.calls.push("exec:snapshot"); output = JSON.stringify({ files: { "src/index.ts": "observed task file" }, quiescence: "unproven" })
      } else throw new Error("unexpected trusted script")
      return { stdout: new Blob([output]).stream(), stderr: null, exitCode: Promise.resolve(0), kill() {} }
    },
  }
  const ctx = {
    id: { name: identity.id, toString: () => "isolated-" + identity.id }, container: native,
    exports: { SmokeEgress({ props }: { props: unknown }) { trace.scopes.push(props); return {} } },
  } as unknown as DurableObjectState
  const env = {
    API_TOKEN: "offline-token", WORKSPACE_REPO: "", OPENCODE_MODEL: "opencode/deepseek-v4.1-flash", trace,
    CHECKPOINTS: {
      async get(key: string) { const value = objects.get(key); return value === undefined ? null : { async json() { return JSON.parse(value) } } },
      async put(key: string, value: string) { objects.set(key, value) },
    },
    SETTINGS: { getByName() { return { async fetch() { return Response.json({ model: "opencode/deepseek-v4.1-flash", workspaceRepo: "", onboarding: {} }) } } } },
    get BENCH_PROVIDER_KEY() { throw new Error("arm must never read real provider key") },
  } as unknown as Env
  nativeStates.add(ctx)
  const arm = new SmokeConversation(ctx, env)
  const call = (action: string, method = "POST", body: unknown = identity) => arm.fetch(new Request(`https://smoke/aboiteau/${action}`, {
    method, headers: { authorization: "Bearer offline-token" }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  }))
  return { arm, ctx, env, trace, identity, objects, call }
}

test("smoke accepts only the two frozen cold cells and scopes the canonical native model", () => {
  const { identity } = fixture()
  expect(parseSmokeRequest(identity)).toEqual(identity)
  for (const override of [{ taskID: "L2" }, { condition: "warm" }, { repetition: 2 }, { command: "arbitrary" }, { protocolSHA256: "0".repeat(64) }]) expect(() => parseSmokeRequest({ ...identity, ...override })).toThrow()
  const overlay = smokeProviderOverlay("prx_" + "a".repeat(64))
  expect(overlay.default_agent).toBe("build")
  expect(overlay.agents.build.permissions).toEqual([{ action: "shell", resource: "*", effect: "allow" }])
  expect(overlay.providers.opencode.settings.baseURL).toBe("http://provider.aboiteau/v1")
  expect(overlay.providers.opencode.models["deepseek-v4.1-flash"]).toEqual({ settings: { baseURL: "http://provider.aboiteau/v1" }, limit: { context: 32768, output: 4096 }, body: { temperature: 0 } })
  expect(() => smokeProviderOverlay("real-upstream-key")).toThrow()
})

test("prepare stays cold; actual product dispatch seeds only after native initialization", async () => {
  const { call, trace, identity } = fixture()
  const prepared = await call("prepare")
  expect(prepared.status).toBe(201)
  expect(trace.running).toBe(false)
  expect(trace.prompts).toHaveLength(0)
  expect(JSON.stringify(await prepared.json())).not.toContain("prx_")
  expect(trace.scopes[0]).toMatchObject({ attemptID: "aboiteau-" + identity.id })
  expect((await call("submit")).status).toBe(202)
  expect(trace.options?.enableInternet).toBe(false)
  expect(trace.calls.indexOf("exec:config")).toBeGreaterThan(trace.calls.indexOf("control:/configure"))
  expect(trace.calls.indexOf("exec:fixture")).toBeGreaterThan(trace.calls.indexOf("control:/start"))
  expect(trace.prompts[0]).toMatchObject({ idempotencyKey: identity.id })
  await call("submit")
  expect(trace.prompts).toHaveLength(1)
})

test("cleanup is serialized behind submission and retains a non-replayable receipt", async () => {
  const { call, trace, objects } = fixture()
  let release = () => {}, entered = () => {}
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  trace.messageGate = async () => { entered(); await gate }
  await call("prepare")
  const submitting = call("submit")
  await started
  const cleanup = call("cleanup")
  await Promise.resolve()
  expect(trace.calls).not.toContain("product:/delete")
  release()
  expect((await submitting).status).toBe(202)
  expect((await cleanup).status).toBe(200)
  expect(trace.running).toBe(false)
  expect(objects.size).toBe(1)
  expect((await call("submit")).status).toBe(200)
  expect(trace.prompts).toHaveLength(1)
})

test("product cleanup holds and failed setup remain visible instead of being erased", async () => {
  const blocked = fixture()
  await blocked.call("prepare"); await blocked.call("submit")
  blocked.trace.cleanupBlocked = true
  expect((await blocked.call("cleanup")).status).toBe(409)
  expect(blocked.trace.running).toBe(true)
  expect(JSON.stringify(await (await blocked.call("status", "GET")).json())).toContain("cleanup-requested")
  expect((await blocked.call("submit")).status).toBe(200)
  expect(blocked.trace.prompts).toHaveLength(1)
  const failed = fixture("Q1")
  failed.trace.configureFails = true
  await failed.call("prepare")
  expect((await failed.call("submit")).status).toBe(409)
  expect(failed.trace.calls).not.toContain("exec:fixture")
  expect((await failed.call("submit")).status).toBe(409)
  expect(failed.trace.prompts).toHaveLength(1)
})

test("bounded snapshot declares unproven quiescence and requires idle product state", async () => {
  const { call, trace } = fixture()
  await call("prepare"); await call("submit")
  trace.state = { phase: "running" }
  expect((await call("snapshot", "GET")).status).toBe(409)
  trace.state = { phase: "idle" }
  expect(await (await call("snapshot", "GET")).json()).toMatchObject({ quiescence: "unproven" })
})

test("native facade preserves receiver identity and ignores unsuccessful control responses", async () => {
  const { ctx, trace } = fixture()
  let hooks = 0
  const facade = smokeContainerFacade(ctx.container!, async () => { hooks++ })
  trace.configureFails = true
  const response = await facade.getTcpPort(4001).fetch(new Request("http://container/configure", { method: "POST" }))
  expect(response.status).toBe(500)
  expect(hooks).toBe(0)
  expect(facade.running).toBe(false)
})

async function mergedSmokeConfig(config: unknown) {
  const root = await mkdtemp(join(tmpdir(), "r0-23-native-policy-"))
  const file = join(root, "opencode.json")
  try {
    await writeFile(file, JSON.stringify(config))
    // Execute the production script itself with only its fixed config path
    // redirected. Mock chown at the OS boundary because the host test user
    // cannot adopt the image's uid/gid; all merge/read/write/chmod code is real.
    const ownershipBoundary = `const {mock}=await import("bun:test");const original=await import("node:fs/promises");mock.module("node:fs/promises",()=>({...original,chown:async(file,uid,gid)=>{if(file!==${JSON.stringify(file)}||uid!==1001||gid!==1001)throw new Error("unexpected ownership change")}}));\n`
    const script = ownershipBoundary + SMOKE_CONFIG_SCRIPT.replace('"/var/lib/aboiteau/state/config/opencode/opencode.json"', JSON.stringify(file))
    const child = Bun.spawn([process.execPath, "-e", script], { stdin: new Blob([JSON.stringify(smokeProviderOverlay("prx_" + "a".repeat(64)))]).stream(), stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH } })
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(stderr).toBe("")
    expect(code).toBe(0)
    return JSON.parse(await readFile(file, "utf8"))
  } finally { await rm(root, { recursive: true, force: true }) }
}

test("actual 2.2.5 schema and evaluator allow fixture shell work while retaining hard denials", async () => {
  // Import the installed native runtime, rather than a test policy evaluator.
  const modules = new URL("../../runtime/opencode/node_modules/", import.meta.url)
  const [{ Config }, { Permission }, { Agent }, { Schema }] = await Promise.all([
    import(new URL("@opencode/schema/dist/config.js", modules).href),
    import(new URL("@opencode/core/dist/permission.js", modules).href),
    import(new URL("@opencode/schema/dist/agent.js", modules).href),
    import(new URL("effect/dist/index.js", modules).href),
  ])
  const rootRules = buildPermissionRules({ allow: ["bun test *"], ask: ["python3 *"] })
  const existingBuildRules = [{ action: "shell", resource: "git clean *", effect: "deny" }, { action: "shell", resource: "python3 *", effect: "ask" }]
  const original = { model: "opencode/deepseek-v4.1-flash", permissions: rootRules,
    agents: { build: { description: "Retained build description", permissions: existingBuildRules }, title: { disabled: true }, explore: { hidden: true } },
    experimental: { background_compaction: false }, providers: { unrelated: { name: "Retained provider" } } }
  const merged = await mergedSmokeConfig(original)
  const decoded = Schema.decodeUnknownSync(Config.Info)(merged)
  const defaults = Agent.Info.default("build").permissions
  const evaluate = (action: string, resource: string) => Permission.evaluate(action, resource, defaults, decoded.permissions, decoded.agents.build.permissions).effect
  expect(Permission.evaluate("shell", "python3 -m unittest", defaults, rootRules, existingBuildRules).effect).toBe("ask")
  for (const command of ["bun test", "bun test test/basic.test.ts", "python3 -m unittest", "git diff -- src/index.ts"]) expect(evaluate("shell", command)).toBe("allow")
  for (const command of ["rm -rf src", "sudo bun test", "cat /var/lib/aboiteau/state/config/opencode/opencode.json", "git clean -fd"]) expect(evaluate("shell", command)).toBe("deny")
  expect(evaluate("read", "/var/lib/aboiteau/state/data/opencode/auth.json")).toBe("deny")
  expect(evaluate("edit", "/var/lib/aboiteau/state/config/opencode/opencode.json")).toBe("deny")
  expect(evaluate("read", "src/index.ts")).toBe("allow")
  expect(evaluate("edit", "src/index.ts")).toBe("allow")
  const hardDenials = [...rootRules, ...existingBuildRules].filter(rule => rule.effect === "deny" && ["read", "edit", "shell"].includes(rule.action))
  expect(merged.agents.build.permissions.slice(-hardDenials.length)).toEqual(hardDenials)
  expect(merged.permissions).toEqual(rootRules)
  expect(merged.agents.build.description).toBe(original.agents.build.description)
  expect(merged.agents.title).toEqual(original.agents.title)
  expect(merged.agents.explore).toEqual(original.agents.explore)
  expect(merged.experimental).toEqual(original.experimental)
  expect(merged.providers.unrelated).toEqual(original.providers.unrelated)
  expect(merged.default_agent).toBe("build")
  expect(merged.model).toBe("opencode/deepseek-v4.1-flash")
  expect(merged.providers.opencode).toEqual(smokeProviderOverlay("prx_" + "a".repeat(64)).providers.opencode)
})

test("status replays only pending permission metadata and redacts the scoped grant", async () => {
  const { call, trace, objects } = fixture()
  await call("prepare")
  await call("status", "GET")
  expect(trace.calls).not.toContain("product:/events")
  const token = JSON.parse([...objects.values()][0]!).grant.token
  trace.state = { permissionNotifications: { per_pending: { delivered: true } } }
  trace.replayText = [
    { type: "permission", requestID: "per_unrelated", action: "edit", resources: ["ignored"] },
    { type: "permission", requestID: "per_pending", action: "shell", resources: ["python3 check.py", token] },
  ].map(event => "data: " + JSON.stringify(event) + "\n\n").join("") + ": connected\n\n"
  const status = await (await call("status", "GET")).json() as { permissionRequests: unknown; permissionReplayComplete: boolean }
  expect(status.permissionRequests).toEqual([{ requestID: "per_pending", action: "shell", resources: ["python3 check.py", "[scoped grant redacted]"] }])
  expect(status.permissionReplayComplete).toBe(true)
  expect(trace.replayCancelled).toBe(true)
  expect(trace.calls).not.toContain("product:/permission")
  expect(JSON.stringify(status)).not.toContain(token)
})

test("permission replay bounds bytes and time even if cancellation does not acknowledge", async () => {
  const oversized = await boundedPermissionReplay(Promise.resolve(new Response("data: " + "x".repeat(1000))), ["per_pending"], 100, 20)
  expect(oversized).toEqual({ requests: [], complete: false })
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return new Promise<void>(() => {}) } })
  const stalled = await boundedPermissionReplay(Promise.resolve(new Response(stream)), ["per_pending"], 10)
  expect(stalled).toEqual({ requests: [], complete: false })
  expect(cancelled).toBe(true)
})
