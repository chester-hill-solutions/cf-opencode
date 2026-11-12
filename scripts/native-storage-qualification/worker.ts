import { Conversation as BaseConversation } from "../../src/conversation"
import { Settings } from "../../src/settings-do"
import type { Env as BaseEnv } from "../../src/env"
import { bearerAuthorized } from "../../src/control-auth"
import { parseWorkspaceIdentity } from "../../stow-workspace"
import { NATIVE_STORAGE_PROBE } from "./container-probe"
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
const CONTROLLER_SHA256 = "e70c25065a74c2d5384df19dd8c1612949b1b08d790b368a72cd0f5212cdd3a3"
const BINARY_SHA256 = "780c3ccf89abdb4355e1b943ab686693d7436bd08cefdffd0f315226815f27da"

type SafeReceipt = {
  stage: "prepared" | "checkpointed" | "verified"
  workspaceID: string
  image: string
  controllerSHA256: string
  binarySHA256: string
  directMarkerSHA256: string
  objectMarkerSHA256: string
  metadataMarkerSHA256: string
  manifest?: {
    workspace: { key: string; size: number; encrypted: true }
    state: { key: string; size: number; encrypted: true }
  }
  firstProbe: Omit<SafeProbeResult, "mode">
  restoredProbe?: Omit<SafeProbeResult, "mode">
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
      if (existing.stage === "prepared") {
        return Response.json({ ok: true, stage: existing.stage, workspaceID: existing.workspaceID, image: existing.image })
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
      !firstProbe.s3PutToWorkspaceFileMatches || !firstProbe.metadataTypeMatches ||
      !firstProbe.ephemeralSentinelAbsent) {
      return jsonError("initial native workspace probe failed", 503)
    }

    const receipt: SafeReceipt = {
      stage: "prepared",
      workspaceID: identity.workspace_id,
      image: inspected.image,
      controllerSHA256: CONTROLLER_SHA256,
      binarySHA256: BINARY_SHA256,
      directMarkerSHA256: await sha256("c2-synthetic-direct-workspace-bytes-v1\n"),
      objectMarkerSHA256: await sha256("c2-synthetic-s3-workspace-bytes-v1\n"),
      metadataMarkerSHA256: await sha256("c2-synthetic-content-type-metadata-v1\n"),
      firstProbe: this.safeProbeFields(firstProbe),
    }
    await this.ctx.storage.put(QUALIFICATION_STATE_KEY, receipt)
    return Response.json({ ok: true, stage: receipt.stage, workspaceID: receipt.workspaceID, image: receipt.image })
  }

  private async recycleAndVerifyArchives(): Promise<Response> {
    const receipt = await this.ctx.storage.get<SafeReceipt>(QUALIFICATION_STATE_KEY)
    if (receipt?.stage === "checkpointed" || receipt?.stage === "verified") {
      return Response.json({ ok: true, stage: receipt.stage, manifest: receipt.manifest })
    }
    if (!receipt || receipt.stage !== "prepared") return jsonError("prepare must complete first", 409)
    const recycled = await super.fetch(this.internal("/recycle", "POST"))
    await recycled.body?.cancel()
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
    if (receipt?.stage === "verified") return this.verifiedResponse(receipt)
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
      !restoredProbe.s3PutToWorkspaceFileMatches || !restoredProbe.metadataTypeMatches ||
      !restoredProbe.ephemeralSentinelAbsent) {
      return jsonError("restored native workspace probe failed", 503)
    }
    const state = await responseJson<RuntimeState>(await super.fetch(this.internal("/state")))
    if (state.sessionID || (state.phase !== undefined && state.phase !== "idle") ||
      state.queued || state.budgetReservation || state.checkpointPending) {
      return jsonError("qualification unexpectedly created model work", 503)
    }

    const next: SafeReceipt = {
      ...receipt,
      stage: "verified",
      restoredProbe: this.safeProbeFields(restoredProbe),
    }
    await this.ctx.storage.put(QUALIFICATION_STATE_KEY, next)
    return this.verifiedResponse(next)
  }

  private verifiedResponse(receipt: SafeReceipt): Response {
    return Response.json({
      ok: true,
      stage: receipt.stage,
      workspaceID: receipt.workspaceID,
      image: receipt.image,
      controllerSHA256: receipt.controllerSHA256,
      binarySHA256: receipt.binarySHA256,
      markerSHA256: {
        directFile: receipt.directMarkerSHA256,
        s3Object: receipt.objectMarkerSHA256,
        metadata: receipt.metadataMarkerSHA256,
      },
      manifest: receipt.manifest,
      firstProbe: receipt.firstProbe,
      restoredProbe: receipt.restoredProbe,
      sessionCreated: false,
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
      env: { C2_PROBE_MODE: mode },
      signal: AbortSignal.timeout(45_000),
    })
    const output = await process.output()
    const stdout = new TextDecoder().decode(output.stdout)
    if (output.exitCode !== 0 || stdout.length > 4096) throw new Error("fixed native probe failed")
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
    }
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
