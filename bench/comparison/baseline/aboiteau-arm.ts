import { Conversation } from "../../../src/conversation"
import type { Env } from "../../../src/env"
import { bearerAuthorized } from "../../../src/control-auth"
import { fixtureFiles } from "../fixtures"
import { tasks } from "../protocol"
import { FROZEN_PROTOCOL_SHA256 } from "./freeze.generated"
import { parseTaskRequest, readTaskBody, type TaskRequest } from "./task-request"
import { sha256 } from "./journal"
import { LinuxToolPlane, type Exec } from "./linux"
import { SMOKE_SCOPE } from "./smoke-scope"

type NativeContainer = NonNullable<DurableObjectState["container"]>
type SmokePhase = "prepared" | "submitting" | "submitted" | "ambiguous" | "cleanup-requested" | "cleaned"
export interface SmokeReceipt {
  schemaVersion: 1
  identity: TaskRequest
  phase: SmokePhase
  preparedAt: number
  submittedAt?: number
  fixtureCommit?: string
  fixtureReadyAt?: number
  submission?: { status: number; body: unknown }
  cleanedAt?: number
  failure?: string
  grant: { token: string; tokenSHA256: string; expiresAt: number }
}

export function parseSmokeRequest(input: unknown): TaskRequest {
  const request = parseTaskRequest(input, FROZEN_PROTOCOL_SHA256)
  if (!["L1", "Q1"].includes(request.taskID) || request.condition !== "cold" || request.repetition !== 1) throw new Error("only frozen cold L1/Q1 smoke cells are enabled")
  return request
}

export function smokeProviderOverlay(token: string) {
  if (!/^prx_[a-f0-9]{64}$/.test(token)) throw new Error("invalid scoped placeholder")
  return { default_agent: "build", agents: { build: { permissions: [
    { action: "shell", resource: "*", effect: "allow" },
  ] } }, providers: { opencode: {
    settings: { apiKey: token, baseURL: "http://provider.aboiteau/v1" },
    models: { "deepseek-v4.1-flash": {
      settings: { baseURL: "http://provider.aboiteau/v1" },
      limit: { context: 32768, output: 4096 },
      body: { temperature: 0 },
    } },
  } } }
}

/** Fixed scripts receive only trusted public fixtures or a scoped placeholder on stdin. */
export const SMOKE_CONFIG_SCRIPT = String.raw`
const fs=await import("node:fs/promises");
const file="/var/lib/aboiteau/state/config/opencode/opencode.json";
const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error("unsafe config");
const overlay=JSON.parse(await Bun.stdin.text()),config=JSON.parse(await fs.readFile(file,"utf8"));
config.providers={...config.providers,...overlay.providers};
config.default_agent=overlay.default_agent;
const existingBuild=config.agents?.build??{};
const retainedDenies=[...(config.permissions??[]),...(existingBuild.permissions??[])].filter(rule=>rule.effect==="deny"&&["read","edit","shell"].includes(rule.action));
config.agents={...config.agents,build:{...existingBuild,permissions:[...(existingBuild.permissions??[]),...overlay.agents.build.permissions,...retainedDenies]}};
await fs.writeFile(file,JSON.stringify(config,null,2));
await fs.chown(file,1001,1001);await fs.chmod(file,0o660);
process.stdout.write("configured");
`

export const SMOKE_FIXTURE_SCRIPT = String.raw`
const fs=await import("node:fs/promises"),path=await import("node:path");
const input=JSON.parse(await Bun.stdin.text());
if(await fs.realpath(process.cwd())!=="/workspace")throw new Error("wrong workspace");
if(!(await fs.lstat(".stow/manifest.json")).isFile())throw new Error("native workspace identity required");
const marker=".r0-23-attempt";
const git=(args)=>{const p=Bun.spawnSync(["git",...args],{cwd:"/workspace",env:{PATH:"/usr/local/bin:/usr/bin:/bin",GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",GIT_AUTHOR_DATE:"2026-11-14T12:00:00Z",GIT_COMMITTER_DATE:"2026-11-14T12:00:00Z"}});if(p.exitCode!==0)throw new Error("fixture git operation failed");return new TextDecoder().decode(p.stdout).trim()};
try{const owner=await fs.readFile(marker,"utf8");if(owner!==input.id)throw new Error("attempt marker conflict");process.stdout.write(git(["rev-parse","HEAD"]));process.exit(0)}catch(e){if(e.code!=="ENOENT")throw e}
if((await fs.readdir(".")).some(name=>name!==".stow"))throw new Error("fresh native workspace required");
const paths=Object.keys(input.files);
for(const file of paths){if(!/^(package\.json|src\/[a-z.-]+\.ts|test\/[a-z.-]+\.ts)$/.test(file))throw new Error("fixture path refused");await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,input.files[file],{flag:"wx"})}
git(["init","--quiet","--initial-branch=main"]);
await fs.writeFile(".git/info/exclude",".stow\n.r0-23-attempt\n");
git(["add","--",...paths]);
git(["-c","user.name=R0-23 Fixture","-c","user.email=fixture@example.invalid","-c","core.hooksPath=/dev/null","commit","--quiet","-m","Frozen R0-23 base fixture"]);
const commit=git(["rev-parse","HEAD"]);
await fs.writeFile(marker,input.id,{flag:"wx"});process.stdout.write(commit);
`

export const SMOKE_SNAPSHOT_SCRIPT = String.raw`
const fs=await import("node:fs/promises"),path=await import("node:path");
const input=JSON.parse(await Bun.stdin.text());
if(await fs.realpath(process.cwd())!=="/workspace"||await fs.readFile(".r0-23-attempt","utf8")!==input.id)throw new Error("wrong attempt workspace");
const files={};let count=0,bytes=0;
async function walk(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){
 const p=path.join(dir,entry.name);if(p===".git"||p===".stow"||p===".r0-23-attempt")continue;
 if(entry.isSymbolicLink())throw new Error("snapshot symlink refused");
 if(entry.isDirectory()){await walk(p);continue}
 if(!entry.isFile()||++count>64)throw new Error("snapshot file limit");
 const stat=await fs.lstat(p);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536||(bytes+=stat.size)>40000)throw new Error("snapshot byte limit");
 files[p]=await fs.readFile(p,"utf8");
}}
await walk(".");process.stdout.write(JSON.stringify({files,quiescence:"unproven"}));
`

/** Preserve native receiver branding; only observe successful control lifecycle calls. */
export function smokeContainerFacade(native: NativeContainer, afterControl: (path: string, response: Response) => Promise<void>): NativeContainer {
  return new Proxy(native, { get(target, key) {
    if (key === "getTcpPort") return (port: number) => {
      const binding = target.getTcpPort(port)
      if (port !== 4001) return binding
      return { fetch: async (input: Request | string | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const response = await binding.fetch(request)
        const path = new URL(request.url).pathname
        if (response.ok && request.method === "POST" && (path === "/configure" || path === "/start")) await afterControl(path, response)
        return response
      } }
    }
    const value = Reflect.get(target, key, target)
    return typeof value === "function" ? value.bind(target) : value
  } })
}

function redact(value: unknown, token: string): unknown {
  return JSON.parse(JSON.stringify(value).replaceAll(token, "[scoped grant redacted]"))
}

function publicReceipt(receipt: SmokeReceipt) {
  const { grant: _grant, ...visible } = receipt
  return redact(visible, receipt.grant.token)
}

/** Read existing permission metadata; never answer or approve a request. */
export async function boundedPermissionReplay(replay: Promise<Response>, pendingIDs: readonly string[], timeoutMs = 5000, limitBytes = 131072) {
  const requests: Array<{ requestID: string; action?: string; resources?: string[] }> = []
  const pending = new Set(pendingIDs)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let abandoned = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs) })
  void replay.then(response => { if (abandoned) void response.body?.cancel().catch(() => {}) }, () => {})
  try {
    const response = await Promise.race([replay, deadline])
    if (!response?.ok || !response.body) return { requests, complete: false }
    reader = response.body.getReader()
    const decoder = new TextDecoder()
    let bytes = 0, buffer = ""
    for (;;) {
      const chunk = await Promise.race([reader.read(), deadline])
      if (!chunk || chunk.done) return { requests, complete: false }
      bytes += chunk.value.byteLength
      if (bytes > limitBytes) return { requests, complete: false }
      buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n")
      let separator: number
      while ((separator = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, separator); buffer = buffer.slice(separator + 2)
        if (frame.trim() === ": connected") return { requests, complete: true }
        const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")
        if (!data) continue
        try {
          const event = JSON.parse(data)
          if (event.type !== "permission" || !pending.has(event.requestID) || requests.some(item => item.requestID === event.requestID) || requests.length >= 32) continue
          requests.push({ requestID: event.requestID,
            ...(typeof event.action === "string" ? { action: event.action.slice(0, 100) } : {}),
            ...(Array.isArray(event.resources) ? { resources: event.resources.filter((value: unknown): value is string => typeof value === "string").slice(0, 16).map((value: string) => value.slice(0, 1024)) } : {}),
          })
        } catch { /* A malformed replay frame does not hide later valid entries. */ }
      }
    }
  } catch { return { requests, complete: false } }
  finally {
    abandoned = true
    if (timer) clearTimeout(timer)
    if (reader) void reader.cancel().then(() => reader?.releaseLock()).catch(() => {})
  }
}

/** Actual Conversation orchestration with isolated benchmark-only boundary hooks. */
export class SmokeConversation extends Conversation {
  private smokeTail: Promise<unknown> = Promise.resolve()
  private readonly native: NativeContainer
  private readonly hookedContainer?: NativeContainer
  private readonly benchmarkContext: DurableObjectState
  private receipt: SmokeReceipt | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    // DurableObjectBase requires the actual runtime-branded state object.
    super(ctx, env)
    if (!ctx.container) throw new Error("native container binding required")
    this.native = ctx.container
    this.benchmarkContext = ctx
    this.hookedContainer = smokeContainerFacade(this.native, (path, response) => this.afterControl(path, response))
  }

  protected override runtimeContainer(): DurableObjectState["container"] {
    return this.hookedContainer ?? super.runtimeContainer()
  }

  protected override startOptions(): ContainerStartupOptions {
    if (!this.receipt || this.receipt.phase === "cleaned") throw new Error("smoke attempt is not active")
    return { ...super.startOptions(), enableInternet: false }
  }

  protected override snapshotHandle(): Promise<ContainerSnapshot | undefined> { return Promise.resolve(undefined) }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.smokeTail.then(operation, operation)
    this.smokeTail = result.then(() => undefined, () => undefined)
    return result
  }

  private receiptKey(): string { return `r0-23-smoke/aboiteau/${this.benchmarkContext.id.toString()}/receipt.json` }

  private async load(): Promise<SmokeReceipt | null> {
    const object = await this.env.CHECKPOINTS.get(this.receiptKey())
    this.receipt = object ? await object.json<SmokeReceipt>() : null
    return this.receipt
  }

  private async save(receipt: SmokeReceipt): Promise<void> {
    await this.env.CHECKPOINTS.put(this.receiptKey(), JSON.stringify(receipt), { httpMetadata: { contentType: "application/json" } })
    this.receipt = receipt
  }

  private async installEgress(receipt: SmokeReceipt): Promise<void> {
    if (receipt.grant.expiresAt <= Date.now()) throw new Error("smoke grant expired; automatic replacement refused")
    await this.native.interceptOutboundHttp("provider.aboiteau", this.benchmarkContext.exports.SmokeEgress({ props: {
      attemptID: `aboiteau-${receipt.identity.id}`, tokenSHA256: receipt.grant.tokenSHA256, expiresAt: receipt.grant.expiresAt,
    } }))
  }

  private async execute(script: string, input: unknown, user: "root" | "agent"): Promise<string> {
    if (!this.native.running) throw new Error("native runtime absent; automatic replacement refused")
    const exec: Exec = (argv, options) => this.native.exec(argv, { ...options, user, stdout: "pipe", stderr: "pipe",
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } })
    // LinuxToolPlane bounds observations and kills the observed process on timeout.
    // It does not establish descendant quiescence.
    const plane = new LinuxToolPlane(exec, "/workspace")
    // The shell sees only this fixed script. JSON reaches stdin through a base64
    // literal, never through shell interpolation or command substitution.
    const bytes = new TextEncoder().encode(JSON.stringify(input))
    const encoded = btoa(String.fromCharCode(...bytes))
    const command = `printf %s '${encoded}' | base64 -d | bun -e '${script.replaceAll("'", "'\\''")}'`
    return plane.execute("shell", { command }, AbortSignal.timeout(30_000))
  }

  private async afterControl(path: string, response: Response): Promise<void> {
    const receipt = this.receipt
    if (!receipt || receipt.phase === "cleaned") throw new Error("inactive smoke lifecycle")
    if (path === "/configure") {
      await this.execute(SMOKE_CONFIG_SCRIPT, smokeProviderOverlay(receipt.grant.token), "root")
      return
    }
    const proof = await response.clone().json() as { ok?: boolean; eventPersistence?: boolean }
    if (proof.ok !== true || proof.eventPersistence !== true) throw new Error("evented runtime proof required")
    const task = tasks.find(task => task.id === receipt.identity.taskID)!
    const commit = (await this.execute(SMOKE_FIXTURE_SCRIPT, { id: receipt.identity.id, files: fixtureFiles[task.repo] }, "agent")).trim()
    if (!/^[a-f0-9]{40}$/.test(commit) || (receipt.fixtureCommit && receipt.fixtureCommit !== commit)) throw new Error("fixture identity changed")
    await this.save({ ...receipt, fixtureCommit: commit, fixtureReadyAt: receipt.fixtureReadyAt ?? Date.now() })
  }

  override async alarm(): Promise<void> {
    return this.serial(async () => {
      const receipt = await this.load()
      if (!receipt || receipt.phase === "cleaned" || receipt.phase === "prepared") return
      await this.installEgress(receipt)
      await super.alarm()
    })
  }

  override async fetch(request: Request): Promise<Response> {
    if (!bearerAuthorized(request.headers.get("authorization"), this.env.API_TOKEN ?? "")) return new Response("unauthorized", { status: 401 })
    return this.serial(async () => {
      try { return await this.handleSmoke(request) }
      catch { return Response.json({ error: "smoke action failed; retained state requires inspection" }, { status: 409 }) }
    })
  }

  private async product(path: string, method = "GET", body?: unknown): Promise<Response> {
    return super.fetch(new Request(`https://conversation${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
  }

  private async handleSmoke(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (!/^\/aboiteau\/(prepare|submit|status|snapshot|cleanup)$/.test(path)) return new Response("not found", { status: 404 })
    const receipt = await this.load()
    if (path === "/aboiteau/prepare" && request.method === "POST") {
      const identity = parseSmokeRequest(await readTaskBody(request))
      if (this.benchmarkContext.id.name !== identity.id) throw new Error("DO/attempt mismatch")
      if (receipt) {
        if (JSON.stringify(receipt.identity) !== JSON.stringify(identity)) throw new Error("attempt identity conflict")
        return Response.json({ cached: true, receipt: publicReceipt(receipt) })
      }
      if (this.native.running || this.env.CONTAINER_URL || this.transport || this.env.WORKSPACE_REPO || this.env.OPENCODE_MODEL !== "opencode/deepseek-v4.1-flash") throw new Error("isolated native smoke configuration required")
      const settings = await this.env.SETTINGS.getByName("global").fetch("https://settings/get").then(response => response.json()) as { model?: string; workspaceRepo?: string; onboarding?: { opencodeConnectedAt?: number } }
      if (settings.model !== "opencode/deepseek-v4.1-flash" || settings.workspaceRepo || settings.onboarding?.opencodeConnectedAt) throw new Error("isolated settings required")
      const token = "prx_" + Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, "0")).join("")
      const next: SmokeReceipt = { schemaVersion: 1, identity, phase: "prepared", preparedAt: Date.now(), grant: { token, tokenSHA256: await sha256(token), expiresAt: Date.now() + SMOKE_SCOPE.grantLifetimeMs } }
      await this.save(next)
      await this.installEgress(next)
      return Response.json({ accepted: true, receipt: publicReceipt(next) }, { status: 201 })
    }
    if (!receipt) return Response.json({ error: "attempt not prepared" }, { status: 404 })
    if (path === "/aboiteau/status" && request.method === "GET") {
      const state = await this.product("/state").then(response => response.json()) as { permissionNotifications?: Record<string, unknown> }
      const pending = state.permissionNotifications && typeof state.permissionNotifications === "object" ? Object.keys(state.permissionNotifications).slice(0, 128) : []
      const replay = pending.length ? await boundedPermissionReplay(this.product("/events"), pending) : { requests: [], complete: true }
      return Response.json({ receipt: publicReceipt(receipt), state: redact(state, receipt.grant.token), permissionRequests: redact(replay.requests, receipt.grant.token), permissionReplayComplete: replay.complete, containerRunning: this.native.running, quiescence: "unproven" })
    }
    if (path === "/aboiteau/submit" && request.method === "POST") {
      const identity = parseSmokeRequest(await readTaskBody(request))
      if (JSON.stringify(receipt.identity) !== JSON.stringify(identity)) throw new Error("attempt identity conflict")
      if (receipt.phase !== "prepared") return Response.json({ cached: true, receipt: publicReceipt(receipt) }, { status: receipt.submission ? 200 : 409 })
      await this.installEgress(receipt)
      await this.save({ ...receipt, phase: "submitting", submittedAt: Date.now() })
      try {
        const task = tasks.find(task => task.id === identity.taskID)!
        const response = await this.product("/message", "POST", { text: task.prompt, idempotencyKey: identity.id })
        const body: unknown = await response.json()
        const latest = this.receipt!
        await this.save({ ...latest, phase: response.ok ? "submitted" : "ambiguous", submission: { status: response.status, body } })
        return Response.json({ accepted: response.ok, receipt: publicReceipt(this.receipt!) }, { status: response.ok ? 202 : 409 })
      } catch {
        await this.save({ ...this.receipt!, phase: "ambiguous", failure: "submission or setup interrupted; automatic redispatch refused" })
        throw new Error("submission ambiguous")
      }
    }
    if (path === "/aboiteau/snapshot" && request.method === "GET") {
      if (receipt.phase !== "submitted") throw new Error("submitted live attempt required")
      const state = await this.product("/state").then(response => response.json()) as { phase?: string; budgetReservation?: unknown; checkpointPending?: boolean }
      if (state.phase !== "idle" || state.budgetReservation || state.checkpointPending) throw new Error("product execution has unresolved work")
      return new Response(await this.execute(SMOKE_SNAPSHOT_SCRIPT, { id: receipt.identity.id }, "agent"), { headers: { "content-type": "application/json" } })
    }
    if (path === "/aboiteau/cleanup" && request.method === "POST") {
      if (receipt.phase === "cleaned") return Response.json({ cached: true, runtimeStopped: !this.native.running, receipt: publicReceipt(receipt) })
      await this.save({ ...receipt, phase: "cleanup-requested" })
      const response = await this.product("/delete", "DELETE")
      const product: unknown = await response.json()
      if (!response.ok || this.native.running) return Response.json({ runtimeStopped: !this.native.running, product: redact(product, receipt.grant.token), receipt: publicReceipt(this.receipt!) }, { status: 409 })
      await this.save({ ...this.receipt!, phase: "cleaned", cleanedAt: Date.now() })
      return Response.json({ runtimeStopped: true, product, receipt: publicReceipt(this.receipt!) })
    }
    return new Response("method not allowed", { status: 405 })
  }
}
