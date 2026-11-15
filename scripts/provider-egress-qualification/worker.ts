import { DurableObject } from "cloudflare:workers"
import { bearerAuthorized, constantTimeEqual } from "../../src/control-auth"
import { makeClient, portFetch, type ContainerPort } from "../../src/opencode"
import { opencodeViaControl } from "../../src/opencode-proxy"
import {
  createProviderProxyGrant,
  PROVIDER_PROXY_HOST,
  PROVIDER_PROXY_ID,
  type ProviderProxyScope,
} from "../../src/provider-egress"
import { providerProxyConfig } from "../../src/provider-proxy-config"
import { successfulStartProof } from "./response-proof"
import { sdkTerminalFailure } from "./sdk-failure"
import { ProviderEgress } from "../../src/provider-egress-entrypoint"
import { isSettled, latestAssistantReply, turnFailure, type MessageInfo } from "../../src/messages"
import { QUALIFICATION_ARTIFACT } from "../native-storage-qualification/artifact"
import { PROVIDER_EGRESS_PROBE } from "../../.wrangler/provider-egress-preflight/probe-source"
import { providerQualificationEvidence, providerQualificationPassed, type ProviderQualificationResult } from "./result"

const FIXED_NAME = "R1-7A"
const ATTEMPT_KEY = "providerEgressQualificationAttempted"
const VERIFY_ATTEMPT_KEY = "providerEgressQualificationVerificationAttempted"
const CLEANUP_ATTEMPTS_KEY = "providerEgressCleanupAttempts"
const RECEIPT_KEY = "providerEgressQualificationReceipt"
const GRANT_KEY = "providerEgressGrant"
const MODEL = "r1-7a-probe"
const UPSTREAM_MARKER = "R1_7A_UPSTREAM_"
const STREAM_MARKER = "R1_7A_STREAM_OK"
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const MAX_PROBE_BYTES = 8192

interface QualificationEnv {
  API_TOKEN?: string
  PROVIDER_PROXY_API_KEY?: string
  CONTAINER_INSTANCE_PROFILE?: string
  CONVERSATION: DurableObjectNamespace<ProviderEgressQualification>
}

interface Receipt {
  prepared: boolean
  verified: boolean
  cleaned: boolean
  image: string
  controllerSHA256: string
  binarySHA256: string
  artifactMatches: boolean
  model: string
  probe?: ProviderQualificationResult
  sdkMarker: boolean
  archiveSecretAbsent: boolean
  archiveContainsScopedConfig: boolean
  expiredGrantRejected: boolean
  scopeTokenMismatchRejected: boolean
  upstreamUnavailable: boolean
  restoredProxyHealthy: boolean
}

function error(status: number, message: string): Response {
  return Response.json({ ok: false, error: message }, { status, headers: { "cache-control": "no-store" } })
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")
}

function hasBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false
  outer: for (let at = 0; at <= haystack.length - needle.length; at++) {
    for (let i = 0; i < needle.length; i++) if (haystack[at + i] !== needle[i]) continue outer
    return true
  }
  return false
}

/** Fixed-purpose DO. No caller-controlled paths, commands, models, or URLs. */
export class ProviderEgressQualification extends DurableObject<QualificationEnv> {
  private actionTail: Promise<unknown> = Promise.resolve()

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (!url.pathname.startsWith("/provider-egress/")) return error(404, "not found")
    if (this.ctx.id.name !== FIXED_NAME || request.method !== "POST" || url.search ||
      request.headers.get("x-qualification-key") !== FIXED_NAME) return error(404, "not found")
    if (await request.text() !== "") return error(400, "request body must be empty")
    const action = url.pathname.slice("/provider-egress/".length)
    if (action !== "prepare" && action !== "verify" && action !== "cleanup") return error(404, "not found")
    return this.serialize(async () => {
      try {
        return action === "prepare" ? await this.prepare() :
          action === "verify" ? await this.verify() : await this.cleanup()
      } catch {
        return error(503, "provider egress qualification operation failed")
      }
    })
  }

  override async alarm(): Promise<void> {
    try {
      if (await this.stopAndForget()) return
    } catch { /* schedule a bounded retry below */ }
    const previous = await this.ctx.storage.get<number>(CLEANUP_ATTEMPTS_KEY)
    const attempts = typeof previous === "number" && Number.isSafeInteger(previous) && previous >= 0 ? Math.min(5, previous) : 0
    const next = Math.min(5, attempts + 1)
    await this.ctx.storage.put(CLEANUP_ATTEMPTS_KEY, next)
    await this.ctx.storage.setAlarm(Date.now() + next * 60_000)
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const run = this.actionTail.then(action, action)
    this.actionTail = run.then(() => undefined, () => undefined)
    return run
  }

  private async prepare(): Promise<Response> {
    const existing = await this.ctx.storage.get<Receipt>(RECEIPT_KEY)
    if (existing) return error(409, "preparation is one-shot; cleanup and use a fresh fixture")
    if (await this.ctx.storage.get<boolean>(ATTEMPT_KEY)) return error(409, "preparation was already attempted; clean up and use a fresh fixture")
    const container = this.ctx.container
    const apiKey = this.env.PROVIDER_PROXY_API_KEY
    if (!container || container.running || !this.env.API_TOKEN ||
      !apiKey || !/^R1_7A_UPSTREAM_[A-Za-z0-9_-]{32,}$/.test(apiKey) ||
      this.env.CONTAINER_INSTANCE_PROFILE !== QUALIFICATION_ARTIFACT.profile ||
      container.images.evented !== QUALIFICATION_ARTIFACT.image || await this.ctx.storage.get("controlToken")) {
      return error(409, "fresh pinned qualification runtime and synthetic upstream secret are required")
    }
    const claimed = await this.ctx.storage.transaction(async (txn) => {
      if (await txn.get(ATTEMPT_KEY)) return false
      await txn.put(ATTEMPT_KEY, true)
      return true
    })
    if (!claimed) return error(409, "fixture attempt is already claimed")
    await this.ctx.storage.setAlarm(Date.now() + 30 * 60_000)

    const grant = await createProviderProxyGrant(FIXED_NAME, MODEL)
    await this.ctx.storage.put(GRANT_KEY, grant)
    const token = hex(crypto.getRandomValues(new Uint8Array(32)))
    await this.ctx.storage.put("controlToken", token)
    await container.interceptOutboundHttp(PROVIDER_PROXY_HOST,
      this.ctx.exports.QualificationProviderEgress({ props: grant.scope }))
    await container.start({
      enableInternet: false,
      image: container.images.evented,
      instance: QUALIFICATION_ARTIFACT.instance,
      env: { CONTROL_TOKEN: token },
    })

    const control = container.getTcpPort(4001)
    const deadline = Date.now() + 120_000
    let healthy = false
    while (Date.now() < deadline) {
      try {
        const response = await control.fetch(new Request("http://container/health", { signal: AbortSignal.timeout(2_000) }))
        await response.body?.cancel()
        if (response.ok) { healthy = true; break }
      } catch { /* bounded readiness retry */ }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (!healthy) return error(503, "pinned control server did not become ready; cleanup is required")

    const authorized = this.authenticatedPort(control, token)
    const configured = await authorized.fetch("http://container/configure", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceRepo: "", model: `${providerProxyConfig(MODEL, grant.token).model}` }),
      signal: AbortSignal.timeout(15_000),
    })
    await configured.body?.cancel()
    if (!configured.ok) return error(503, "fixed runtime configuration failed; cleanup is required")
    const config = providerProxyConfig(MODEL, grant.token)
    const mergeProgram = [
      'const fs=require("node:fs");',
      'const p="/var/lib/aboiteau/state/config/opencode/opencode.json";',
      'const current=JSON.parse(fs.readFileSync(p,"utf8"));',
      `const managed=JSON.parse(${JSON.stringify(JSON.stringify(config))});`,
      'current.model=managed.model;',
      'current.providers={...(current.providers||{}),...managed.providers};',
      'fs.writeFileSync(p,JSON.stringify(current,null,2));',
    ].join("")
    const merged = await this.execRoot(["bun", "-e", mergeProgram])
    if (!merged) return error(503, "fixed scoped provider configuration failed; cleanup is required")
    const started = await authorized.fetch("http://container/start", { method: "POST", signal: AbortSignal.timeout(120_000) })
    if (!(await successfulStartProof(started))) return error(503, "pinned OpenCode runtime did not start; cleanup is required")
    await container.setInactivityTimeout(300_000)
    const artifactMatches = await this.measureArtifactHashes()
    if (!artifactMatches) return error(503, "running container artifact hashes did not match the frozen pins; cleanup is required")

    const receipt: Receipt = {
      prepared: true, verified: false, cleaned: false,
      image: QUALIFICATION_ARTIFACT.image,
      controllerSHA256: QUALIFICATION_ARTIFACT.controllerSHA256,
      binarySHA256: QUALIFICATION_ARTIFACT.binarySHA256,
      artifactMatches,
      model: MODEL, probe: undefined, sdkMarker: false, archiveSecretAbsent: false,
      archiveContainsScopedConfig: false,
      expiredGrantRejected: false, scopeTokenMismatchRejected: false, upstreamUnavailable: false,
      restoredProxyHealthy: false,
    }
    await this.ctx.storage.put(RECEIPT_KEY, receipt)
    return this.receiptResponse(receipt)
  }

  private async verify(): Promise<Response> {
    if (await this.ctx.storage.get<boolean>(VERIFY_ATTEMPT_KEY)) return error(409, "verification is one-shot; cleanup and use a fresh fixture")
    const receipt = await this.ctx.storage.get<Receipt>(RECEIPT_KEY)
    if (!receipt?.prepared) return error(409, "prepare must succeed first")
    const claimed = await this.ctx.storage.transaction(async (txn) => {
      if (await txn.get(VERIFY_ATTEMPT_KEY)) return false
      await txn.put(VERIFY_ATTEMPT_KEY, true)
      return true
    })
    if (!claimed) return error(409, "verification was already attempted; cleanup and use a fresh fixture")
    const container = this.ctx.container
    const grant = await this.ctx.storage.get<{ scope: ProviderProxyScope; token: string }>(GRANT_KEY)
    if (!container?.running || !grant) return error(409, "prepared runtime or scoped grant is unavailable")
    const controlToken = await this.ctx.storage.get<string>("controlToken")
    if (!controlToken) return error(503, "runtime control authorization is unavailable")
    const control = this.authenticatedPort(container.getTcpPort(4001), controlToken)
    const client = makeClient(portFetch(opencodeViaControl(control)))
    const process = await container.exec(["bun", "-e", PROVIDER_EGRESS_PROBE], {
      cwd: "/workspace",
      user: "1001:1001",
      env: { PROVIDER_PROXY_TOKEN: grant.token, PROVIDER_PROXY_MODEL: MODEL },
      signal: AbortSignal.timeout(120_000),
    })
    const output = await process.output()
    if (output.stdout.byteLength > MAX_PROBE_BYTES) {
      return error(503, "fixed native egress probe failed; cleanup is required")
    }
    let probe: unknown
    try { probe = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output.stdout)) as unknown }
    catch { return error(503, "fixed native egress probe returned invalid evidence; cleanup is required") }
    if (!providerQualificationEvidence(probe)) return error(503, "fixed native egress probe returned invalid evidence; cleanup is required")
    if (await process.exitCode !== 0 || !providerQualificationPassed(probe)) {
      return Response.json({ ok: false, error: "native egress or credential boundary assertions failed; cleanup is required", probe },
        { status: 503, headers: { "cache-control": "no-store" } })
    }

    let sdkMarker = false
    let sdkStage: "session_create" | "prompt" | "context" = "session_create"
    let sdkFailure = "deadline"
    try {
      const session = await client.session.create({
        location: { directory: "/workspace" }, title: "r1-7a-provider-egress-qualification",
      }, { signal: AbortSignal.timeout(20_000) })
      sdkStage = "prompt"
      await client.session.prompt({
        sessionID: session.id,
        text: "Return exactly the qualification marker.",
        delivery: "queue",
      }, { signal: AbortSignal.timeout(30_000) })
      sdkStage = "context"
      const until = Date.now() + 30_000
      while (Date.now() < until) {
        const context = await client.session.context({ sessionID: session.id }, { signal: AbortSignal.timeout(5_000) })
        const messages = context as unknown as MessageInfo[]
        if (turnFailure(messages)) { sdkFailure = sdkTerminalFailure(messages); break }
        if (isSettled(messages) && latestAssistantReply(messages) === STREAM_MARKER) { sdkMarker = true; break }
        if (isSettled(messages)) { sdkFailure = "marker_mismatch"; break }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    } catch { sdkFailure = `${sdkStage}_failed` }
    if (!sdkMarker) return Response.json({ ok: false, error: "OpenCode SDK did not consume the fixed streamed marker; cleanup is required", sdkFailure, probe },
      { status: 503, headers: { "cache-control": "no-store" } })

    const rebindChecks = await this.verifyReboundFailures(grant)
    if (!rebindChecks.expiredGrantRejected || !rebindChecks.scopeTokenMismatchRejected ||
      !rebindChecks.upstreamUnavailable || !rebindChecks.restoredProxyHealthy) {
      return error(503, "fixed expired, mismatched-scope, or upstream-outage case failed; cleanup is required")
    }

    let archiveSecretAbsent = false
    let archiveContainsScopedConfig = false
    try {
      const archiveResponse = await control.fetch("http://container/state-checkpoint", {
        signal: AbortSignal.timeout(60_000),
      })
      if (archiveResponse.ok) {
        const compressed = await this.readBounded(archiveResponse.body, MAX_ARCHIVE_BYTES)
        if (compressed?.length) {
          const clear = await this.readBounded(new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip")), MAX_ARCHIVE_BYTES * 4)
          if (!clear) throw new Error("archive exceeds decompressed bound")
          const synthetic = new TextEncoder().encode(this.env.PROVIDER_PROXY_API_KEY ?? UPSTREAM_MARKER)
          archiveSecretAbsent = !hasBytes(clear, synthetic) && !hasBytes(clear, new TextEncoder().encode(UPSTREAM_MARKER))
          archiveContainsScopedConfig = clear.byteLength > 0 &&
            hasBytes(clear, new TextEncoder().encode(grant.token)) &&
            hasBytes(clear, new TextEncoder().encode(PROVIDER_PROXY_ID))
        }
      } else await archiveResponse.body?.cancel()
    } catch { archiveSecretAbsent = false }
    if (!archiveSecretAbsent || !archiveContainsScopedConfig) {
      return error(503, "bounded account archive proxy-config or upstream-secret assertion failed")
    }

    const completed: Receipt = { ...receipt, verified: true, probe, sdkMarker, archiveSecretAbsent,
      archiveContainsScopedConfig, ...rebindChecks }
    await this.ctx.storage.put(RECEIPT_KEY, completed)
    return this.receiptResponse(completed)
  }

  private async cleanup(): Promise<Response> {
    const stopped = await this.stopAndForget()
    if (!stopped) return error(503, "container cleanup was not confirmed")
    return Response.json({ ok: true, stage: "cleaned", runtimeStopped: true, grantForgotten: true })
  }

  private async stopAndForget(): Promise<boolean> {
    const container = this.ctx.container
    if (container) {
      try {
        if (container.running) {
          const monitored = container.monitor().catch(() => {})
          await container.destroy()
          await Promise.race([monitored, new Promise((resolve) => setTimeout(resolve, 10_000))])
        }
        if (container.running) return false
      } catch { return false }
    }
    await this.ctx.storage.deleteAll()
    await this.ctx.storage.put(ATTEMPT_KEY, true)
    await this.ctx.storage.deleteAlarm()
    return true
  }

  private async execRoot(command: string[]): Promise<boolean> {
    const container = this.ctx.container
    if (!container?.running) return false
    try {
      const process = await container.exec(command, { user: "0:0", signal: AbortSignal.timeout(15_000) })
      const output = await process.output()
      return output.exitCode === 0 && output.stdout.byteLength === 0 && output.stderr.byteLength === 0
    } catch { return false }
  }

  private async measureArtifactHashes(): Promise<boolean> {
    const container = this.ctx.container
    if (!container?.running) return false
    try {
      const process = await container.exec(["sha256sum", "/app/control-server.ts", "/usr/local/bin/stow-s3"], {
        user: "0:0", signal: AbortSignal.timeout(10_000),
      })
      const output = await process.output()
      if (await process.exitCode !== 0 || output.stderr.byteLength !== 0 || output.stdout.byteLength > 512) return false
      const rows = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(output.stdout).trim().split("\n")
      if (rows.length !== 2) return false
      const found = new Map<string, string>()
      for (const row of rows) {
        const match = /^([a-f0-9]{64})\s+(.+)$/.exec(row)
        if (!match || found.has(match[2]!)) return false
        found.set(match[2]!, match[1]!)
      }
      return found.get("/app/control-server.ts") === QUALIFICATION_ARTIFACT.controllerSHA256 &&
        found.get("/usr/local/bin/stow-s3") === QUALIFICATION_ARTIFACT.binarySHA256
    } catch { return false }
  }

  /** Exercise three fixed error paths through the running container's virtual host. */
  private async verifyReboundFailures(grant: { scope: ProviderProxyScope; token: string }): Promise<{
    expiredGrantRejected: boolean
    scopeTokenMismatchRejected: boolean
    upstreamUnavailable: boolean
    restoredProxyHealthy: boolean
  }> {
    const container = this.ctx.container
    if (!container?.running) return { expiredGrantRejected: false, scopeTokenMismatchRejected: false, upstreamUnavailable: false, restoredProxyHealthy: false }
    const exports = this.ctx.exports
    const fixed = exports.QualificationProviderEgress
    const failed = exports.QualificationProviderEgressFailure
    let expiredGrantRejected = false
    let scopeTokenMismatchRejected = false
    let upstreamUnavailable = false
    let restoredProxyHealthy = false
    try {
      await container.interceptOutboundHttp(PROVIDER_PROXY_HOST,
        fixed({ props: { ...grant.scope, expiresAt: Date.now() - 1 } }))
      expiredGrantRejected = await this.requestProxyStatus(grant.token, 403)
      await container.interceptOutboundHttp(PROVIDER_PROXY_HOST,
        fixed({ props: { ...grant.scope, tokenSHA256: "0".repeat(64) } }))
      scopeTokenMismatchRejected = await this.requestProxyStatus(grant.token, 401)
      await container.interceptOutboundHttp(PROVIDER_PROXY_HOST, failed({ props: grant.scope }))
      upstreamUnavailable = await this.requestProxyStatus(grant.token, 503)
    } catch {
      // The final restoration proof below is required even when a case fails.
    } finally {
      try {
        await container.interceptOutboundHttp(PROVIDER_PROXY_HOST, fixed({ props: grant.scope }))
        restoredProxyHealthy = await this.requestProxyStatus(grant.token, 200)
      } catch { restoredProxyHealthy = false }
    }
    return { expiredGrantRejected, scopeTokenMismatchRejected, upstreamUnavailable, restoredProxyHealthy }
  }

  private async requestProxyStatus(token: string, expected: number): Promise<boolean> {
    const container = this.ctx.container
    if (!container?.running) return false
    const script = [
      'const r=await fetch("http://provider.aboiteau/v1/chat/completions",{method:"POST",redirect:"error",signal:AbortSignal.timeout(5000),headers:{authorization:`Bearer ${process.env.PROVIDER_PROXY_TOKEN}`,"content-type":"application/json"},body:JSON.stringify({model:process.env.PROVIDER_PROXY_MODEL,stream:false,messages:[{role:"user",content:"fixed failure probe"}]})});',
      'await r.body?.cancel();process.stdout.write(JSON.stringify({status:r.status}));',
    ].join("")
    try {
      const process = await container.exec(["bun", "-e", script], {
        user: "1001:1001", env: { PROVIDER_PROXY_TOKEN: token, PROVIDER_PROXY_MODEL: MODEL },
        signal: AbortSignal.timeout(10_000),
      })
      const result = await process.output()
      if (await process.exitCode !== 0 || result.stdout.byteLength > 128 || result.stderr.byteLength !== 0) return false
      const parsed = JSON.parse(new TextDecoder().decode(result.stdout)) as { status?: unknown }
      return parsed.status === expected
    } catch { return false }
  }

  private async readBounded(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array | undefined> {
    if (!stream) return undefined
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > limit) {
          await reader.cancel().catch(() => {})
          return undefined
        }
        chunks.push(value)
      }
    } catch {
      await reader.cancel().catch(() => {})
      return undefined
    } finally { reader.releaseLock() }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return bytes
  }

  private authenticatedPort(port: ContainerPort, token: string): ContainerPort {
    return {
      fetch(input, init) {
        const request = new Request(input, init)
        request.headers.set("authorization", `Bearer ${token}`)
        return port.fetch(request)
      },
    }
  }

  private receiptResponse(receipt: Receipt): Response {
    return Response.json({ ok: true, stage: receipt.verified ? "verified" : "prepared",
      qualificationPassed: receipt.verified && receipt.sdkMarker && receipt.archiveSecretAbsent &&
        receipt.archiveContainsScopedConfig &&
        receipt.artifactMatches &&
        receipt.expiredGrantRejected && receipt.scopeTokenMismatchRejected && receipt.upstreamUnavailable && receipt.restoredProxyHealthy &&
        providerQualificationPassed(receipt.probe),
      image: receipt.image, controllerSHA256: receipt.controllerSHA256, binarySHA256: receipt.binarySHA256,
      model: receipt.model, sdkMarker: receipt.sdkMarker, archiveSecretAbsent: receipt.archiveSecretAbsent,
      archiveContainsScopedConfig: receipt.archiveContainsScopedConfig,
      artifactMatches: receipt.artifactMatches,
      expiredGrantRejected: receipt.expiredGrantRejected,
      scopeTokenMismatchRejected: receipt.scopeTokenMismatchRejected,
      upstreamUnavailable: receipt.upstreamUnavailable,
      restoredProxyHealthy: receipt.restoredProxyHealthy,
      probe: receipt.probe ?? null })
  }
}

/** Native WorkerEntrypoint response; it never calls an external provider. */
export class QualificationProviderEgress extends ProviderEgress {
  protected override async upstream(request: Request): Promise<Response> {
    const secret = this.env.PROVIDER_PROXY_API_KEY
    if (!secret || !constantTimeEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
      return Response.json({ error: "synthetic upstream authorization failed" }, { status: 401 })
    }
    let value: { model?: unknown; stream?: unknown }
    try { value = await request.json() as typeof value }
    catch { return Response.json({ error: "invalid synthetic request" }, { status: 400 }) }
    if (value.model !== MODEL || typeof value.stream !== "boolean") return Response.json({ error: "invalid synthetic request" }, { status: 400 })
    if (!value.stream) return Response.json({
      id: "chatcmpl-r1-7a", object: "chat.completion", created: 1, model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: STREAM_MARKER }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }, { headers: { "content-type": "application/json" } })
    const encoder = new TextEncoder()
    const frames = [
      { id: "chatcmpl-r1-7a", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      { id: "chatcmpl-r1-7a", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta: { content: "R1_7A_" }, finish_reason: null }] },
      { id: "chatcmpl-r1-7a", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta: { content: "STREAM_OK" }, finish_reason: null }] },
      { id: "chatcmpl-r1-7a", object: "chat.completion.chunk", created: 1, model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
      },
    })
    return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } })
  }
}

/** Fixed outage implementation used only by the failure-path fixture. */
export class QualificationProviderEgressFailure extends ProviderEgress {
  protected override async upstream(_request: Request): Promise<Response> {
    throw new Error("synthetic upstream unavailable")
  }
}

const actions = ["prepare", "verify", "cleanup"] as const

export default {
  async fetch(request: Request, env: QualificationEnv): Promise<Response> {
    if (!env.API_TOKEN || !bearerAuthorized(request.headers.get("authorization"), env.API_TOKEN)) return error(401, "unauthorized")
    const url = new URL(request.url)
    if (request.method !== "POST" || url.search || await request.text() !== "") return error(404, "not found")
    const action = actions.find((candidate) => url.pathname === `/${candidate}`)
    if (!action) return error(404, "not found")
    const target = env.CONVERSATION.getByName(FIXED_NAME)
    const response = await target.fetch(new Request(`https://provider-egress/provider-egress/${action}`, {
      method: "POST", headers: { "x-qualification-key": FIXED_NAME },
    }))
    return response
  },
}
