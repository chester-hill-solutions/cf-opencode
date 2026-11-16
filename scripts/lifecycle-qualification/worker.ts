import { Conversation as BaseConversation } from "../../src/conversation"
import { Settings } from "../../src/settings-do"
import type { Env as BaseEnv } from "../../src/env"
import { bearerAuthorized } from "../../src/control-auth"
import { makeClient, portFetch, type ContainerPort } from "../../src/opencode"
import { opencodeViaControl } from "../../src/opencode-proxy"
import { ConversationStore } from "../../src/state"
import { resolveQualificationRoute } from "./route-contract"

export { Settings }

const QUALIFICATION_KEY = "lifecycle-idle-qualification"
const RECEIPT_KEY = "lifecycleIdleQualification"
const PINNED_EVENTED_IMAGE =
  "registry.cloudflare.com/ad5ec479b9a421faa2ed06c3d1c2b23a/cf-opencode-native-c2@sha256:9f82e154e6d050e0f0d3daa72bb9b8bb387cf05c3c7aae1f74d787264455340f"

type Receipt = {
  stage: "creating" | "prepared"
  sessionID?: string
  runtimeGeneration?: string
  image: string
}

type SafeDebug = { containerRunning?: unknown; runtimeGeneration?: unknown }

function jsonError(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status, headers: { "cache-control": "no-store" } })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Fixed-purpose staging subclass. It exposes no arbitrary container command or proxy. */
export class LifecycleIdleQualificationConversation extends BaseConversation {
  private readonly qualificationStore: ConversationStore
  private qualificationActionTail: Promise<unknown> = Promise.resolve()

  constructor(ctx: DurableObjectState, env: BaseEnv) {
    super(ctx, env)
    this.qualificationStore = new ConversationStore(ctx.storage)
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/qualification/prepare" || url.pathname === "/qualification/cleanup") {
      if (request.headers.get("x-conversation-key") !== QUALIFICATION_KEY || url.search || request.method !== "POST") {
        return jsonError("not found", 404)
      }
      try {
        if (await request.text() !== "") return jsonError("request body must be empty", 400)
        return await this.serializeQualificationAction(() =>
          url.pathname.endsWith("/prepare") ? this.prepareOnce() : this.cleanupOnce(),
        )
      } catch {
        return jsonError("qualification operation failed", 503)
      }
    }
    if ((url.pathname === "/context" || url.pathname === "/debug") && request.method === "GET") {
      return super.fetch(this.internal(url.pathname))
    }
    return jsonError("not found", 404)
  }

  private serializeQualificationAction<T>(action: () => Promise<T>): Promise<T> {
    const run = this.qualificationActionTail.then(action, action)
    this.qualificationActionTail = run.then(() => undefined, () => undefined)
    return run
  }

  private async prepareOnce(): Promise<Response> {
    const existing = await this.ctx.storage.get<Receipt>(RECEIPT_KEY)
    if (existing?.stage === "prepared" && existing.sessionID && existing.runtimeGeneration) {
      return Response.json({
        ok: true,
        stage: "prepared",
        sessionID: existing.sessionID,
        runtimeGeneration: existing.runtimeGeneration,
        image: existing.image,
      })
    }
    if (existing) return jsonError("preparation outcome is ambiguous; cleanup this isolated key", 409)

    if (!this.env.API_TOKEN || !/^[a-f0-9]{64}$/i.test(this.env.VAULT_MASTER_KEY ?? "")) {
      return jsonError("fresh API_TOKEN and VAULT_MASTER_KEY secrets are required", 409)
    }
    const container = this.ctx.container
    if (!container || container.running || this.env.EVENTED_FRESH_CONVERSATIONS !== "true" ||
      this.env.EVENTED_CANARY_KEY || container.images.evented !== PINNED_EVENTED_IMAGE) {
      return jsonError("isolated fresh conversation and retained pinned evented image are required", 409)
    }

    const bucketPage = await this.env.CHECKPOINTS.list({ limit: 1 })
    if (bucketPage.objects.length !== 0 || bucketPage.truncated) {
      return jsonError("qualification R2 bucket must be completely empty", 409)
    }
    const state = await this.qualificationStore.get()
    if (state.sessionID || (state.phase !== undefined && state.phase !== "idle") || state.queued ||
      state.budgetReservation || state.checkpointPending) {
      return jsonError("qualification conversation is not fresh", 409)
    }

    // This read-only model catalogue route enters normal runtime startup but
    // creates no OpenCode session and sends no provider inference request.
    const started = await super.fetch(this.internal("/onboarding/models"))
    await started.body?.cancel()
    if (!started.ok || !container.running) return jsonError("evented runtime did not start", 503)
    const debugResponse = await super.fetch(this.internal("/debug"))
    const debug = await this.safeDebug(debugResponse)
    const inspected = await container.inspect()
    if (!debug || debug.containerRunning !== true || typeof debug.runtimeGeneration !== "string" ||
      !debug.runtimeGeneration || !inspected || inspected.image !== PINNED_EVENTED_IMAGE) {
      return jsonError("pinned runtime identity could not be verified", 503)
    }

    // Write a one-shot claim only after startup has passed the fresh-image
    // guard. A failed/ambiguous session create is never retried as a duplicate.
    const runtimeGeneration = debug.runtimeGeneration
    const claimed = await this.ctx.storage.transaction(async (txn) => {
      if (await txn.get(RECEIPT_KEY)) return false
      await txn.put(RECEIPT_KEY, {
        stage: "creating",
        runtimeGeneration,
        image: inspected.image,
      } satisfies Receipt)
      return true
    })
    if (!claimed) return jsonError("session preparation is already claimed", 409)
    const token = await this.ctx.storage.get<string>("controlToken")
    if (!token) return jsonError("runtime control authorization is unavailable", 503)
    const rawControlPort = container.getTcpPort(4001)
    const authenticatedControlPort: ContainerPort = {
      fetch(input, init) {
        const request = new Request(input as any, init)
        request.headers.set("authorization", `Bearer ${token}`)
        return rawControlPort.fetch(request)
      },
    }
    let sessionID: string | undefined
    try {
      const client = makeClient(portFetch(opencodeViaControl(authenticatedControlPort)))
      const session = await client.session.create({
        location: { directory: "/workspace" },
        title: "lifecycle-idle-qualification",
      }, { signal: AbortSignal.timeout(30_000) })
      sessionID = session.id
    } catch {
      return jsonError("fixed empty-session creation failed; cleanup is required", 503)
    }
    if (!sessionID) return jsonError("fixed empty-session response had no identity; cleanup is required", 503)

    await this.qualificationStore.patch({ sessionID, phase: "idle", transport: "http" })
    const receipt: Receipt = {
      stage: "prepared",
      sessionID,
      runtimeGeneration: debug.runtimeGeneration,
      image: inspected.image,
    }
    await this.ctx.storage.put(RECEIPT_KEY, receipt)
    return Response.json({
      ok: true,
      stage: receipt.stage,
      sessionID: receipt.sessionID,
      runtimeGeneration: receipt.runtimeGeneration,
      image: receipt.image,
    })
  }

  private async cleanupOnce(): Promise<Response> {
    const deleted = await super.fetch(this.internal("/delete", "DELETE"))
    await deleted.body?.cancel()
    if (!deleted.ok || this.ctx.container?.running) {
      return jsonError("core conversation delete did not stop the runtime", 503)
    }
    const bucketPage = await this.env.CHECKPOINTS.list({ limit: 1 })
    if (bucketPage.objects.length !== 0 || bucketPage.truncated) {
      return jsonError("isolated qualification bucket is not empty after core delete", 503)
    }
    return Response.json({ ok: true, stage: "cleaned", runtimeStopped: true, bucketEmpty: true })
  }

  private async safeDebug(response: Response): Promise<SafeDebug | undefined> {
    if (!response.ok) {
      await response.body?.cancel()
      return undefined
    }
    try {
      const value: unknown = await response.json()
      if (!isRecord(value)) return undefined
      return { containerRunning: value.containerRunning, runtimeGeneration: value.runtimeGeneration }
    } catch {
      return undefined
    }
  }

  private internal(path: string, method = "GET"): Request {
    return new Request(`https://lifecycle-qualification${path}`, {
      method,
      headers: { "x-conversation-key": QUALIFICATION_KEY },
    })
  }
}

type WorkerEnv = Omit<BaseEnv, "CONVERSATION"> & {
  CONVERSATION: DurableObjectNamespace<LifecycleIdleQualificationConversation>
  SETTINGS: DurableObjectNamespace<Settings>
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    if (!env.API_TOKEN || !bearerAuthorized(request.headers.get("authorization"), env.API_TOKEN)) {
      return jsonError("unauthorized", 401)
    }
    const url = new URL(request.url)
    if (url.search) return jsonError("not found", 404)

    const route = resolveQualificationRoute(url.pathname, request.method)
    if (!route) return jsonError("not found", 404)

    let internalPath: string
    let method: "GET" | "POST"
    if (route.kind === "prepare") {
      if (await request.text() !== "") return jsonError("request body must be empty", 400)
      internalPath = "/qualification/prepare"
      method = "POST"
    } else if (route.kind === "cleanup") {
      if (await request.text() !== "") return jsonError("request body must be empty", 400)
      internalPath = "/qualification/cleanup"
      method = "POST"
    } else {
      internalPath = route.path
      method = "GET"
    }

    const stub = env.CONVERSATION.getByName(QUALIFICATION_KEY)
    return stub.fetch(new Request(`https://lifecycle-qualification${internalPath}`, {
      method,
      headers: { "x-conversation-key": QUALIFICATION_KEY },
    }))
  },
}
