import { Conversation as BaseConversation } from "../../src/conversation"
import { Settings } from "../../src/settings-do"
import type { Env as BaseEnv } from "../../src/env"
import { bearerAuthorized } from "../../src/control-auth"
import { parseWorkspaceIdentity } from "../../stow-workspace"
import { NATIVE_STORAGE_PROBE } from "./container-probe"
import { CONTAINER_INSTANCE } from "../../src/conversation/images"
import { QUALIFICATION_ARTIFACT, matchesQualificationRuntime, matchesQualificationReceipt } from "./artifact"
import { MATRIX_VERSION, DIRECT_MARKER, METADATA_MARKER, keyMarker, matrixPassed, preparationPassed, projectMatrix, type CaseResult } from "./matrix"
import { makeClient } from "../../src/opencode"
import { seedSession, verifySession } from "./session-probe"
import {
  onlyWhenQualificationBucketEmpty,
  projectSafeProbe,
  type SafeProbeResult,
} from "./qualification-contract"

export { Settings }

const QUALIFICATION_KEY = "native-storage-qualification-c2"
const QUALIFICATION_PATHS = {
  workspace: "/workspace",
  registryDir: "/var/lib/aboiteau/state/stow/registry",
  bucket: "aboiteau-workspace",
  readiness: "/var/lib/aboiteau/run/stow-ready.json",
  privateDir: "/tmp/c2-native-storage-probe",
  privateReadiness: "/tmp/c2-native-storage-probe/readiness.json",
} as const
const QUALIFICATION_STATE_KEY = "nativeStorageQualification"
const { controllerSHA256: CONTROLLER_SHA256, binarySHA256: BINARY_SHA256 } = QUALIFICATION_ARTIFACT

type WriterCapture = {
  startedAt: number
  expiresAt: number
  mode: "active" | "quiesced"
  exercised: boolean
  quiesced: boolean
  attempts: Array<{ status: number; runtimeRunning: boolean; manifestUnchanged: boolean; durationMs: number }>
}
type SafeReceipt = {
  stage: "prepared" | "checkpointed" | "verified" | "failed"
  workspaceID: string
  image: string
  controllerSHA256: string
  binarySHA256: string
  runtime: {
    profile: string
    requested: { vcpu: number; memoryMib: number; diskMb: number }
    /** The current inspect API exposes image/labels, not resource allocations. */
    observed: null
  }
  directMarkerSHA256: string
  objectMarkerSHA256: string
  metadataMarkerSHA256: string
  manifest?: {
    workspace: { key: string; size: number; encrypted: true }
    state: { key: string; size: number; encrypted: true }
  }
  firstProbe: Omit<SafeProbeResult, "mode">
  restoredProbe?: Omit<SafeProbeResult, "mode">
  session?: { id: string; contextSHA256: string }
  sessionResult: CaseResult
  serviceMatrix?: CaseResult[]
  writerCapture?: WriterCapture
}

type RuntimeState = {
  phase?: string
  sessionID?: string
  queued?: unknown
  budgetReservation?: unknown
  checkpointPending?: boolean
  checkpointManifest?: {
    workspace?: { key?: string; size?: number; encrypted?: boolean }
    state?: { key?: string; size?: number; encrypted?: boolean }
  }
}

function jsonError(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status, headers: { "cache-control": "no-store" } })
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error("qualification operation failed")
  return await response.json() as T
}

/** Staging-only subclass: it exposes fixed actions, never arbitrary exec or proxying. */
export class QualificationConversation extends BaseConversation {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (!url.pathname.startsWith("/qualification/")) return super.fetch(request)
    if (request.headers.get("x-conversation-key") !== QUALIFICATION_KEY) {
      return jsonError("forbidden", 403)
    }
    if (url.search || request.method !== "POST") return jsonError("not found", 404)
    if (await request.text() !== "") return jsonError("request body must be empty", 400)

    try {
      if (url.pathname !== "/qualification/cleanup" && !matchesQualificationRuntime({
        image: this.ctx.container?.images.evented,
        profile: this.env.CONTAINER_INSTANCE_PROFILE,
        instance: CONTAINER_INSTANCE,
      })) return jsonError("frozen qualification image and explicit instance profile are required", 409)
      if (url.pathname === "/qualification/prepare") return await this.prepare()
      if (url.pathname === "/qualification/recycle") return await this.recycleAndVerifyArchives()
      if (url.pathname === "/qualification/verify") return await this.verifyRestored()
      if (url.pathname === "/qualification/cleanup") return await this.cleanup()
      return jsonError("not found", 404)
    } catch {
      // Keep native stderr, readiness credentials, and upstream details out of
      // the staging API response.
      return jsonError("qualification operation failed", 503)
    }
  }

  private async prepare(): Promise<Response> {
    const existing = await this.ctx.storage.get<SafeReceipt>(QUALIFICATION_STATE_KEY)
    if (existing) {
      this.requireCurrentReceipt(existing)
      if (existing.stage === "prepared") {
        return Response.json({ ok: true, stage: existing.stage, workspaceID: existing.workspaceID, image: existing.image,
          stowVersion: QUALIFICATION_ARTIFACT.stowVersion, runtime: existing.runtime,
          preparationPassed: preparationPassed(existing.firstProbe.matrix) && existing.sessionResult.disposition === "prepared",
          matrix: existing.firstProbe.matrix, sessionResult: existing.sessionResult })
      }
      return jsonError("qualification key has already been used; clean up and deploy a fresh key", 409)
    }
    const container = this.ctx.container
    if (!container || container.running || this.env.EVENTED_CANARY_KEY ||
      this.env.EVENTED_FRESH_CONVERSATIONS !== "true" ||
      !/^\S+@sha256:[a-f0-9]{64}$/.test(container.images.evented ?? "")) {
      return jsonError("fresh pinned evented runtime is required", 409)
    }
    const wholeBucket = await onlyWhenQualificationBucketEmpty(
      await this.env.CHECKPOINTS.list({ limit: 1 }),
      async () => true,
    )
    if (!wholeBucket.empty) return jsonError("qualification R2 bucket must be completely empty", 409)
    const prefix = "workspaces/" + this.ctx.id.toString() + "/"
    if ((await this.listKeys(prefix)).length !== 0) return jsonError("qualification R2 prefix must be empty", 409)

    const before = await responseJson<RuntimeState>(await super.fetch(this.internal("/state")))
    if (before.sessionID || (before.phase !== undefined && before.phase !== "idle") ||
      before.queued || before.budgetReservation || before.checkpointPending) {
      return jsonError("qualification conversation is not fresh", 409)
    }

    // This read-only SDK catalogue call enters the ordinary startup path; it
    // creates no session and dispatches no provider inference request.
    const models = await super.fetch(this.internal("/onboarding/models"))
    await models.body?.cancel()
    if (!models.ok || !container.running) return jsonError("evented runtime did not start", 503)
    const debug = await responseJson<{ ready?: boolean; startMode?: string; snapshot?: boolean }>(
      await super.fetch(this.internal("/debug")),
    )
    const inspected = await container.inspect()
    const requested = this.requestedInstance()
    if (!debug.ready || debug.startMode !== "image" || debug.snapshot ||
      !inspected || inspected.image !== container.images.evented) {
      return jsonError("runtime did not use the configured evented image", 503)
    }

    const identityOutput = await this.execText(["cat", "/var/lib/aboiteau/state/stow/identity.json"], "0:0")
    let identity: ReturnType<typeof parseWorkspaceIdentity>
    try {
      identity = parseWorkspaceIdentity(JSON.parse(identityOutput), {
        root: QUALIFICATION_PATHS.workspace,
        registryDir: QUALIFICATION_PATHS.registryDir,
        bucket: QUALIFICATION_PATHS.bucket,
      })
    } catch {
      return jsonError("native workspace identity did not validate", 503)
    }
    await this.copyReadinessToAgent()
    const firstProbe = await this.probe("first")
    if (!firstProbe.ok || firstProbe.workspaceID !== identity.workspace_id ||
      firstProbe.controllerSHA256 !== CONTROLLER_SHA256 || firstProbe.binarySHA256 !== BINARY_SHA256 ||
      firstProbe.agentUID !== 1001 || !firstProbe.directFileToS3GetMatches ||
      !firstProbe.ephemeralSentinelAbsent) {
      return jsonError("initial native workspace probe failed", 503)
    }

    let session: SafeReceipt["session"]
    let sessionResult: CaseResult = { id: "opencode-session", disposition: "failed", reason: "session_mismatch" }
    try {
      session = await seedSession(await this.openCodeClient())
      sessionResult = { id: "opencode-session", disposition: "prepared", reason: "awaiting_cold_restore" }
    } catch { /* Record this failure, then still observe the other recovery cases. */ }
    const receipt: SafeReceipt = {
      stage: "prepared",
      workspaceID: identity.workspace_id,
      image: inspected.image,
      controllerSHA256: CONTROLLER_SHA256,
      binarySHA256: BINARY_SHA256,
      runtime: { profile: QUALIFICATION_ARTIFACT.profile, requested, observed: null },
      directMarkerSHA256: await sha256(DIRECT_MARKER),
      objectMarkerSHA256: await sha256(keyMarker("key-natural")),
      metadataMarkerSHA256: await sha256(METADATA_MARKER),
      firstProbe: this.safeProbeFields(firstProbe),
      ...(session ? { session } : {}), sessionResult,
    }
    await this.ctx.storage.put(QUALIFICATION_STATE_KEY, receipt)
    return Response.json({ ok: true, stage: receipt.stage, workspaceID: receipt.workspaceID, image: receipt.image,
      stowVersion: QUALIFICATION_ARTIFACT.stowVersion, runtime: receipt.runtime,
      preparationPassed: preparationPassed(receipt.firstProbe.matrix) && receipt.sessionResult.disposition === "prepared",
      matrix: receipt.firstProbe.matrix, sessionResult: receipt.sessionResult })
  }

  private async recycleAndVerifyArchives(): Promise<Response> {
    const receipt = await this.ctx.storage.get<SafeReceipt>(QUALIFICATION_STATE_KEY)
    if (receipt) this.requireCurrentReceipt(receipt)
    if (receipt?.stage === "checkpointed" || receipt?.stage === "verified" || receipt?.stage === "failed") {
      return Response.json({ ok: receipt.stage !== "failed", stage: receipt.stage, manifest: receipt.manifest })
    }
    if (!receipt || receipt.stage !== "prepared") return jsonError("prepare must complete first", 409)
    if (receipt.writerCapture) return Response.json({ ok: false, error: "capture already attempted; inspect and clean up this fixture", writerCapture: receipt.writerCapture }, { status: 409 })
    const before = await responseJson<RuntimeState>(await super.fetch(this.internal("/state")))
    const writer = await this.writerProbe("writer-start")
    const writerCapture: WriterCapture = { startedAt: Date.now(), expiresAt: writer.deadline,
      mode: "active", quiesced: false, exercised: false, attempts: [] }
    await this.ctx.storage.put(QUALIFICATION_STATE_KEY, { ...receipt, writerCapture })
    let recycled = await super.fetch(this.internal("/recycle", "POST"))
    await recycled.body?.cancel()
    const afterFirst = await responseJson<RuntimeState>(await super.fetch(this.internal("/state")))
    writerCapture.exercised = writer.active && Date.now() < writer.deadline
    writerCapture.attempts.push({ status: recycled.status, runtimeRunning: this.ctx.container?.running === true,
      manifestUnchanged: JSON.stringify(before.checkpointManifest) === JSON.stringify(afterFirst.checkpointManifest), durationMs: Date.now() - writerCapture.startedAt })
    await this.ctx.storage.put(QUALIFICATION_STATE_KEY, { ...receipt, writerCapture })
    // A refused capture must retain both the runtime and the last verified
    // manifest before this fixed fixture may quiesce and retry once.
    if (!recycled.ok && this.ctx.container?.running && writerCapture.attempts[0].manifestUnchanged) {
      const stopped = await this.writerProbe("writer-stop")
      writerCapture.quiesced = !stopped.active
      writerCapture.mode = "quiesced"
      if (writerCapture.quiesced) {
        const retryStarted = Date.now()
        recycled = await super.fetch(this.internal("/recycle", "POST"))
        await recycled.body?.cancel()
        writerCapture.attempts.push({ status: recycled.status, runtimeRunning: this.ctx.container?.running === true,
          manifestUnchanged: false, durationMs: Date.now() - retryStarted })
      }
      await this.ctx.storage.put(QUALIFICATION_STATE_KEY, { ...receipt, writerCapture })
    }
    if (!recycled.ok || this.ctx.container?.running) return jsonError("R2 recycle did not stop the runtime", 503)

    const state = await responseJson<RuntimeState>(await super.fetch(this.internal("/state")))
    const manifest = state.checkpointManifest
    const workspace = manifest?.workspace
    const statePart = manifest?.state
    if (!workspace?.key || !statePart?.key || !workspace.size || !statePart.size ||
      workspace.encrypted !== true || statePart.encrypted !== true) {
      return jsonError("encrypted split workspace and state archives are required", 503)
    }
    const prefix = "workspaces/" + this.ctx.id.toString() + "/"
    if (!workspace.key.startsWith(prefix) || !statePart.key.startsWith(prefix) || workspace.key === statePart.key) {
      return jsonError("checkpoint manifest is outside the qualification prefix", 503)
    }
    for (const part of [workspace, statePart]) {
      if (typeof part.key !== "string" || typeof part.size !== "number") {
        return jsonError("checkpoint manifest is malformed", 503)
      }
      const object = await this.env.CHECKPOINTS.head(part.key)
      if (!object || object.size !== part.size || object.customMetadata?.encrypted !== "1") {
        return jsonError("checkpoint archive failed its R2 head check", 503)
      }
    }
    const keys = await this.listKeys(prefix)
    if (!keys.includes(workspace.key) || !keys.includes(statePart.key)) {
      return jsonError("R2 checkpoint objects are missing", 503)
    }
    const next: SafeReceipt = {
      ...receipt,
      writerCapture,
      stage: "checkpointed",
      manifest: {
        workspace: { key: workspace.key, size: workspace.size, encrypted: true },
        state: { key: statePart.key, size: statePart.size, encrypted: true },
      },
    }
    await this.ctx.storage.put(QUALIFICATION_STATE_KEY, next)
    return Response.json({ ok: true, stage: next.stage, manifest: next.manifest })
  }

  private async verifyRestored(): Promise<Response> {
    const receipt = await this.ctx.storage.get<SafeReceipt>(QUALIFICATION_STATE_KEY)
    if (receipt) this.requireCurrentReceipt(receipt)
    if (receipt?.stage === "verified" || receipt?.stage === "failed") return this.verifiedResponse(receipt)
    if (!receipt || receipt.stage !== "checkpointed" || !receipt.manifest) {
      return jsonError("verified R2 checkpoint is required", 409)
    }
    if (this.ctx.container?.running) return jsonError("runtime must be stopped before cold restore", 409)
    const models = await super.fetch(this.internal("/onboarding/models"))
    await models.body?.cancel()
    if (!models.ok || !this.ctx.container?.running) return jsonError("R2 restore did not start", 503)
    const debug = await responseJson<{ ready?: boolean; startMode?: string; snapshot?: boolean }>(
      await super.fetch(this.internal("/debug")),
    )
    const inspected = await this.ctx.container.inspect()
    this.requestedInstance()
    if (!debug.ready || debug.startMode !== "image" || debug.snapshot || !inspected ||
      inspected.image !== receipt.image || inspected.image !== this.ctx.container.images.evented) {
      return jsonError("cold image start was not verified", 503)
    }

    const identityOutput = await this.execText(["cat", "/var/lib/aboiteau/state/stow/identity.json"], "0:0")
    let identity: ReturnType<typeof parseWorkspaceIdentity>
    try {
      identity = parseWorkspaceIdentity(JSON.parse(identityOutput), {
        root: QUALIFICATION_PATHS.workspace,
        registryDir: QUALIFICATION_PATHS.registryDir,
        bucket: QUALIFICATION_PATHS.bucket,
      })
    } catch {
      return jsonError("restored native workspace identity did not validate", 503)
    }
    if (identity.workspace_id !== receipt.workspaceID) return jsonError("workspace identity changed during R2 restore", 503)
    await this.copyReadinessToAgent()
    const restoredProbe = await this.probe("restored")
    if (!restoredProbe.ok || restoredProbe.workspaceID !== receipt.workspaceID ||
      restoredProbe.controllerSHA256 !== CONTROLLER_SHA256 || restoredProbe.binarySHA256 !== BINARY_SHA256 ||
      restoredProbe.agentUID !== 1001 || !restoredProbe.directFileToS3GetMatches ||
      !restoredProbe.ephemeralSentinelAbsent) {
      return jsonError("restored native workspace probe failed", 503)
    }
    const state = await responseJson<RuntimeState>(await super.fetch(this.internal("/state")))
    if (state.sessionID || (state.phase !== undefined && state.phase !== "idle") ||
      state.queued || state.budgetReservation || state.checkpointPending) {
      return jsonError("qualification unexpectedly created model work", 503)
    }

    if (!receipt.writerCapture?.exercised || (receipt.writerCapture.mode === "quiesced" && !receipt.writerCapture.quiesced)) {
      restoredProbe.matrix = restoredProbe.matrix.map((row) => row.id === "background-writer"
        ? { id: row.id, disposition: "not_exercised", reason: "writer_not_started" } : row)
    }
    let sessionResult: CaseResult = { id: "opencode-session", disposition: "failed", reason: "session_mismatch" }
    try {
      if (receipt.session) {
        if (await verifySession(await this.openCodeClient(), receipt.session)) {
          sessionResult = { id: "opencode-session", disposition: "preserved", reason: "bytes_restored" }
        }
      }
    } catch { /* Keep the failed observation in the receipt. */ }
    let registry: CaseResult[] = [
      { id: "registry-missing", disposition: "failed", reason: "request_failed" },
      { id: "registry-mismatch", disposition: "failed", reason: "request_failed" },
    ]
    try { registry = await this.registryProbe() } catch { /* Cleanup remains available if fault recovery fails. */ }
    const serviceMatrix = [sessionResult, ...registry]
    const passed = preparationPassed(receipt.firstProbe.matrix) && matrixPassed([...restoredProbe.matrix, ...serviceMatrix])
    const next: SafeReceipt = {
      ...receipt,
      stage: passed ? "verified" : "failed",
      serviceMatrix,
      restoredProbe: this.safeProbeFields(restoredProbe),
    }
    await this.ctx.storage.put(QUALIFICATION_STATE_KEY, next)
    return this.verifiedResponse(next)
  }

  private verifiedResponse(receipt: SafeReceipt): Response {
    return Response.json({
      ok: receipt.stage === "verified",
      qualificationPassed: receipt.stage === "verified" && preparationPassed(receipt.firstProbe.matrix) && matrixPassed([...(receipt.restoredProbe?.matrix ?? []), ...(receipt.serviceMatrix ?? [])]),
      stage: receipt.stage,
      workspaceID: receipt.workspaceID,
      image: receipt.image,
      controllerSHA256: receipt.controllerSHA256,
      binarySHA256: receipt.binarySHA256,
      stowVersion: QUALIFICATION_ARTIFACT.stowVersion,
      runtime: receipt.runtime,
      markerSHA256: {
        directFile: receipt.directMarkerSHA256,
        s3Object: receipt.objectMarkerSHA256,
        metadata: receipt.metadataMarkerSHA256,
      },
      manifest: receipt.manifest,
      firstProbe: receipt.firstProbe,
      restoredProbe: receipt.restoredProbe,
      matrixVersion: MATRIX_VERSION,
      matrix: [...(receipt.restoredProbe?.matrix ?? []), ...(receipt.serviceMatrix ?? [])],
      writerCapture: receipt.writerCapture,
      syntheticSessionCreated: Boolean(receipt.session),
      providerPrompts: 0,
      snapshotUsed: false,
    })
  }

  private async cleanup(): Promise<Response> {
    const prefix = "workspaces/" + this.ctx.id.toString() + "/"
    const reset = await super.fetch(this.internal("/reset", "POST"))
    await reset.body?.cancel()
    if (!reset.ok || this.ctx.container?.running) return jsonError("qualification cleanup did not stop the runtime", 503)
    const remaining = await this.listKeys(prefix)
    if (remaining.length) return jsonError("qualification cleanup left R2 objects", 503)
    return Response.json({ ok: true, runtimeStopped: true, qualificationR2ObjectsRemaining: 0 })
  }

  private requestedInstance(): { vcpu: number; memoryMib: number; diskMb: number } {
    const options = this.startOptions()
    if (!matchesQualificationRuntime({
      image: options.image,
      profile: this.env.CONTAINER_INSTANCE_PROFILE,
      instance: options.instance,
    })) throw new Error("startup options do not match the frozen qualification pair")
    return { ...QUALIFICATION_ARTIFACT.instance }
  }

  private requireCurrentReceipt(receipt: SafeReceipt): void {
    if (!matchesQualificationReceipt(receipt) || receipt.firstProbe?.matrixVersion !== MATRIX_VERSION) {
      throw new Error("stored receipt belongs to a different qualification artifact")
    }
  }

  private async copyReadinessToAgent(): Promise<void> {
    await this.execText(["install", "-d", "-o", "1001", "-g", "1001", "-m", "0700", QUALIFICATION_PATHS.privateDir], "0:0")
    await this.execText([
      "install", "-o", "1001", "-g", "1001", "-m", "0600",
      QUALIFICATION_PATHS.readiness, QUALIFICATION_PATHS.privateReadiness,
    ], "0:0")
  }

  private async probe(mode: "first" | "restored"): Promise<SafeProbeResult> {
    const container = this.ctx.container
    if (!container?.running) throw new Error("container is stopped")
    const process = await container.exec(["bun", "-e", NATIVE_STORAGE_PROBE], {
      user: "1001:1001",
      env: { C2_PROBE_MODE: mode, CONTROL_TOKEN: "", C2_CONTROL_TOKEN: "" },
      signal: AbortSignal.timeout(45_000),
    })
    const output = await process.output()
    const stdout = new TextDecoder().decode(output.stdout)
    if (output.exitCode !== 0 || stdout.length > 32_768) throw new Error("fixed native probe failed")
    const projected = projectSafeProbe(JSON.parse(stdout))
    if (!projected || projected.mode !== mode) {
      throw new Error("fixed native probe returned malformed data")
    }
    return projected
  }

  private safeProbeFields(result: SafeProbeResult): Omit<SafeProbeResult, "mode"> {
    return {
      ok: result.ok,
      workspaceID: result.workspaceID,
      directFileToS3GetMatches: result.directFileToS3GetMatches,
      s3PutToWorkspaceFileMatches: result.s3PutToWorkspaceFileMatches,
      metadataTypeMatches: result.metadataTypeMatches,
      ephemeralSentinelAbsent: result.ephemeralSentinelAbsent,
      agentUID: result.agentUID,
      controllerSHA256: result.controllerSHA256,
      binarySHA256: result.binarySHA256,
      matrixVersion: result.matrixVersion,
      matrix: result.matrix,
    }
  }

  private async openCodeClient(): Promise<ReturnType<typeof makeClient>> {
    const token = await this.ctx.storage.get<string>("controlToken")
    const port = this.ctx.container?.getTcpPort(4001)
    if (!token || !port) throw new Error("qualification control endpoint unavailable")
    return makeClient(async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      url.pathname = "/opencode" + url.pathname
      const forwarded = new Request(url, request)
      forwarded.headers.set("authorization", `Bearer ${token}`)
      return port.fetch(forwarded)
    })
  }

  private async writerProbe(mode: "writer-start" | "writer-stop"): Promise<{ active: boolean; deadline: number }> {
    const output = await this.fixedProbe(mode, "1001:1001")
    const value = JSON.parse(output) as { active?: unknown; deadline?: unknown }
    if (typeof value.active !== "boolean" || typeof value.deadline !== "number" || !Number.isSafeInteger(value.deadline)) throw new Error("invalid writer observation")
    return { active: value.active, deadline: value.deadline }
  }

  private async registryProbe(): Promise<CaseResult[]> {
    const token = await this.ctx.storage.get<string>("controlToken")
    if (!token) throw new Error("qualification token unavailable")
    const output = await this.fixedProbe("registry-faults", "0:0", token)
    const value = JSON.parse(output) as { rows?: unknown; originalRestored?: unknown }
    const rows = projectMatrix(value.rows, ["registry-missing", "registry-mismatch"])
    if (!rows || typeof value.originalRestored !== "boolean") throw new Error("invalid registry fault observation")
    if (!value.originalRestored) return rows.map((row) => ({ ...row, disposition: "failed", reason: "fixture_restore_failed" }))
    return rows
  }

  private async fixedProbe(mode: string, user: "0:0" | "1001:1001", token = ""): Promise<string> {
    if (!this.ctx.container?.running) throw new Error("container is stopped")
    const process = await this.ctx.container.exec(["bun", "-e", NATIVE_STORAGE_PROBE], {
      user, env: { C2_PROBE_MODE: mode, CONTROL_TOKEN: "", C2_CONTROL_TOKEN: token }, signal: AbortSignal.timeout(120_000),
    })
    const output = await process.output()
    if (output.exitCode !== 0 || output.stdout.byteLength > 32_768) throw new Error("fixed observation failed")
    return new TextDecoder().decode(output.stdout)
  }

  private async execText(command: string[], user: string): Promise<string> {
    const container = this.ctx.container
    if (!container?.running) throw new Error("container is stopped")
    const process = await container.exec(command, { user, signal: AbortSignal.timeout(10_000) })
    const output = await process.output()
    const text = new TextDecoder().decode(output.stdout)
    if (output.exitCode !== 0 || text.length > 8192) throw new Error("fixed container command failed")
    return text
  }

  private async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = []
    let cursor: string | undefined
    do {
      const page = await this.env.CHECKPOINTS.list({ prefix, cursor, limit: 1000 })
      keys.push(...page.objects.map((object) => object.key))
      if (keys.length > 20) throw new Error("qualification prefix exceeded expected object bound")
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    return keys
  }

  private internal(path: string, method = "GET"): Request {
    return new Request("https://qualification" + path, {
      method,
      headers: { "x-conversation-key": QUALIFICATION_KEY },
    })
  }
}

type WorkerEnv = Omit<BaseEnv, "CONVERSATION"> & {
  CONVERSATION: DurableObjectNamespace<QualificationConversation>
  SETTINGS: DurableObjectNamespace<Settings>
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    if (!env.API_TOKEN || !bearerAuthorized(request.headers.get("authorization"), env.API_TOKEN)) {
      return jsonError("unauthorized", 401)
    }
    const url = new URL(request.url)
    if (url.search || request.method !== "POST") return jsonError("not found", 404)
    const action = {
      "/prepare": "prepare",
      "/recycle": "recycle",
      "/verify": "verify",
      "/cleanup": "cleanup",
    }[url.pathname]
    if (!action) return jsonError("not found", 404)
    if (await request.text() !== "") return jsonError("request body must be empty", 400)
    const stub = env.CONVERSATION.getByName(QUALIFICATION_KEY)
    return stub.fetch(new Request("https://qualification/qualification/" + action, {
      method: "POST",
      headers: { "x-conversation-key": QUALIFICATION_KEY },
    }))
  },
}
