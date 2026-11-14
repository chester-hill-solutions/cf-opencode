import { Conversation as BaseConversation } from "../../src/conversation"
import { Settings } from "../../src/settings-do"
import type { Env as BaseEnv } from "../../src/env"
import { bearerAuthorized } from "../../src/control-auth"
import { decryptBytes, encryptBytes } from "../../src/archive-crypto"
import { deriveWorkspaceKey } from "@chester-hill-solutions/vault/core"
import { workspaceID } from "../../src/vault"
import { LEGACY_ACCOUNT_STATE_KEY } from "../../src/tenancy"
import { QUALIFICATION_ARTIFACT } from "./artifact"
import { ACCOUNT_SEED_PROBE } from "../../.wrangler/native-storage-preflight/account-seed-probe-source"
import { accountArchiveBoundary, isFreshStoppedRuntime } from "./account-seed-contract"

export { Settings }

const SOURCE = "r0-15a-account-seed-source"
const RECIPIENT = "r0-15a-account-seed-recipient"
const MARKER = "synthetic-account-seed-marker-v1\n"
const WORKSPACE_MARKER = "/workspace/account-seed-source-sentinel"
const STATE_MARKER = "/var/lib/aboiteau/state/account-seed-marker"
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024

function error(status: number, message: string): Response {
  return Response.json({ ok: false, error: message }, { status, headers: { "cache-control": "no-store" } })
}

async function hash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** Fixed rehearsal actions. It has no caller-controlled paths, commands, or proxy. */
export class AccountSeedConversation extends BaseConversation {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (!url.pathname.startsWith("/account-seed/")) return super.fetch(request)
    if (url.search || request.method !== "POST" || request.headers.get("x-conversation-key") !== this.ctx.id.name) return error(404, "not found")
    if (await request.text() !== "") return error(400, "request body must be empty")
    const role = this.ctx.id.name === SOURCE ? "source" : this.ctx.id.name === RECIPIENT ? "recipient" : undefined
    if (!role) return error(404, "not found")
    try {
      if (url.pathname === "/account-seed/prepare" && role === "source") return await this.prepareSource()
      if (url.pathname === "/account-seed/capture" && role === "source") return await this.captureSource()
      if (url.pathname === "/account-seed/verify" && role === "recipient") return await this.verifyRecipient()
      if (url.pathname === "/account-seed/cleanup") return await this.cleanup()
      return error(404, "not found")
    } catch {
      return error(503, "account seed rehearsal operation failed")
    }
  }

  private async ready(): Promise<Response> {
    const response = await super.fetch(this.internal("/onboarding/models"))
    await response.body?.cancel()
    if (!response.ok || !this.ctx.container?.running) throw new Error("runtime did not start")
    return response
  }

  private async prepareSource(): Promise<Response> {
    if (this.env.CONTAINER_INSTANCE_PROFILE !== QUALIFICATION_ARTIFACT.profile ||
      this.ctx.container?.images.evented !== QUALIFICATION_ARTIFACT.image) return error(409, "pinned runtime required")
    const page = await this.env.CHECKPOINTS.list({ limit: 1 })
    if (page.objects.length || page.truncated) return error(409, "staging bucket must be empty")
    if (!this.env.VAULT_MASTER_KEY) return error(409, "vault master key required")
    if (!isFreshStoppedRuntime({
      running: this.ctx.container?.running === true,
      hasControlToken: Boolean(await this.ctx.storage.get<string>("controlToken")),
    })) return error(409, "source conversation is not fresh")
    const stateResponse = await super.fetch(this.internal("/state"))
    const state = await stateResponse.json().catch(() => undefined) as { sessionID?: string; phase?: string; queued?: unknown } | undefined
    if (!stateResponse.ok || state?.sessionID || (state?.phase && state.phase !== "idle") || state?.queued ||
      (Array.isArray((state as { queue?: unknown[] } | undefined)?.queue) && (state as { queue: unknown[] }).queue.length > 0)) {
      return error(409, "source conversation is not fresh")
    }
    await this.ready()
    await this.exec(["sh", "-c", `printf '%s\\n' '${MARKER.trim()}' > '${STATE_MARKER}'; printf 'source-only\\n' > '${WORKSPACE_MARKER}'`])
    return Response.json({ ok: true, stage: "source-prepared", runtimeReady: true, syntheticMarkerWritten: true })
  }

  private async captureSource(): Promise<Response> {
    const key = await deriveWorkspaceKey(this.env.VAULT_MASTER_KEY!, workspaceID(this.env))
    const sourceIdentity = await this.identity()
    const response = await super.fetch(this.internal("/onboarding/state-checkpoint"))
    if (!response.ok || !response.body) return error(503, "account snapshot unavailable")
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (!bytes.length || bytes.byteLength > MAX_ARCHIVE_BYTES) return error(413, "account snapshot outside size bound")
    const encrypted = await encryptBytes(bytes, key)
    const clear = await decryptBytes(encrypted, key)
    const decompressed = new Uint8Array(await new Response(new Blob([clear]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer())
    const archiveBoundaryPassed = accountArchiveBoundary(decompressed)
    if (!archiveBoundaryPassed) return error(503, "account archive boundary check failed")
    const sourceWorkspaceID = JSON.parse(sourceIdentity).workspace_id
    await this.env.CHECKPOINTS.put(LEGACY_ACCOUNT_STATE_KEY, encrypted, {
      httpMetadata: { contentType: "application/gzip" }, customMetadata: {
        encrypted: "1", sourceWorkspaceID, archiveBoundaryPassed: "1",
      },
    })
    return Response.json({ ok: true, stage: "captured", encrypted: true, archiveBoundaryPassed,
      archiveBytes: bytes.byteLength, ciphertextSHA256: await hash(encrypted) })
  }

  private async verifyRecipient(): Promise<Response> {
    const seed = await this.env.CHECKPOINTS.get(LEGACY_ACCOUNT_STATE_KEY)
    if (!seed || seed.customMetadata?.encrypted !== "1" || seed.customMetadata.archiveBoundaryPassed !== "1") {
      return error(409, "encrypted account seed unavailable or boundary check failed")
    }
    const token = await this.ctx.storage.get<string>("controlToken")
    const claimed = await this.ctx.storage.transaction(async () => {
      const attempted = await this.ctx.storage.get<boolean>("accountSeedVerificationAttempted")
      if (!isFreshStoppedRuntime({
        running: this.ctx.container?.running === true,
        hasControlToken: Boolean(token),
        verificationAttempted: attempted,
      })) return false
      await this.ctx.storage.put("accountSeedVerificationAttempted", true)
      return true
    })
    if (!claimed) return error(409, "recipient must be a fresh unstarted conversation")
    await this.ready() // Ordinary readiness consumes and decrypts the R2 account seed.
    const after = await this.identity()
    const process = await this.ctx.container!.exec(["bun", "-e", ACCOUNT_SEED_PROBE], { user: "0:0", signal: AbortSignal.timeout(30_000) })
    const output = await process.output()
    if (output.exitCode !== 0 || output.stdout.byteLength > 8192) throw new Error("fixed probe failed")
    const probe = JSON.parse(new TextDecoder().decode(output.stdout)) as Record<string, unknown>
    const accountMarkerPresent = probe.markerPresent === true
    const sourceWorkspaceAbsent = probe.sourceWorkspaceSentinelAbsent === true
    const artifactMatches = probe.controllerSHA256 === QUALIFICATION_ARTIFACT.controllerSHA256 &&
      probe.binarySHA256 === QUALIFICATION_ARTIFACT.binarySHA256
    const distinctWorkspaceIdentity = probe.workspaceID !== seed.customMetadata?.sourceWorkspaceID
    if (!accountMarkerPresent || !sourceWorkspaceAbsent || !artifactMatches || !distinctWorkspaceIdentity) throw new Error("recipient assertions failed")
    const port = this.ctx.container!.getTcpPort(4001)
    const startedToken = await this.ctx.storage.get<string>("controlToken")
    if (!port || !startedToken) throw new Error("control endpoint unavailable")
    const reseed = await port.fetch(new Request("http://container/seed-state", {
      method: "POST", headers: { authorization: `Bearer ${startedToken}` }, body: seed.body,
    }))
    const identityAfterReseed = await this.identity()
    if (reseed.status !== 409 || identityAfterReseed !== after) throw new Error("reseed refusal assertion failed")
    const qualificationPassed = seed.customMetadata.archiveBoundaryPassed === "1" && accountMarkerPresent &&
      sourceWorkspaceAbsent && distinctWorkspaceIdentity && artifactMatches && reseed.status === 409 && identityAfterReseed === after
    return Response.json({ ok: true, stage: "verified", qualificationPassed, encryptedSeedConsumed: true,
      archiveBoundaryPassed: seed.customMetadata.archiveBoundaryPassed === "1", accountMarkerPresent,
      sourceWorkspaceAbsent, distinctWorkspaceIdentity, artifactMatches, reseedRejected: true,
      identitySHA256: await hash(new TextEncoder().encode(after)) })
  }

  private async identity(): Promise<string> {
    return this.exec(["cat", "/var/lib/aboiteau/state/stow/identity.json"])
  }

  private async exec(command: string[]): Promise<string> {
    const container = this.ctx.container
    if (!container?.running) throw new Error("container stopped")
    const process = await container.exec(command, { user: "0:0", signal: AbortSignal.timeout(15_000) })
    const output = await process.output()
    const text = new TextDecoder().decode(output.stdout)
    if (output.exitCode !== 0 || text.length > 8192) throw new Error("fixed command failed")
    return text
  }

  private async cleanup(): Promise<Response> {
    const reset = await super.fetch(this.internal("/reset", "POST"))
    await reset.body?.cancel()
    if (!reset.ok || this.ctx.container?.running) return error(503, "runtime cleanup failed")
    if (this.ctx.id.name === SOURCE) await this.env.CHECKPOINTS.delete(LEGACY_ACCOUNT_STATE_KEY)
    return Response.json({ ok: true, runtimeStopped: true })
  }

  private internal(path: string, method = "GET"): Request {
    const name = this.ctx.id.name
    if (!name) throw new Error("named fixture conversation required")
    return new Request("https://account-seed" + path, { method, headers: { "x-conversation-key": name } })
  }
}

type WorkerEnv = Omit<BaseEnv, "CONVERSATION"> & { CONVERSATION: DurableObjectNamespace<AccountSeedConversation> }
const safeActions = ["prepare", "capture", "verify", "cleanup"] as const

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    if (!env.API_TOKEN || !bearerAuthorized(request.headers.get("authorization"), env.API_TOKEN)) return error(401, "unauthorized")
    const url = new URL(request.url)
    if (request.method !== "POST" || url.search || await request.text() !== "") return error(404, "not found")
    const action = safeActions.find((value) => url.pathname === `/${value}`)
    if (!action) return error(404, "not found")
    const source = env.CONVERSATION.getByName(SOURCE)
    const recipient = env.CONVERSATION.getByName(RECIPIENT)
    const target = action === "prepare" || action === "capture" || action === "cleanup" ? source : recipient
    const pathAction = action === "prepare" ? "prepare" : action === "capture" ? "capture" : action === "verify" ? "verify" : "cleanup"
    const result = await target.fetch(new Request(`https://account-seed/account-seed/${pathAction}`, {
      method: "POST", headers: { "x-conversation-key": action === "verify" ? RECIPIENT : SOURCE },
    }))
    if (action === "cleanup") {
      const second = await recipient.fetch(new Request("https://account-seed/account-seed/cleanup", {
        method: "POST", headers: { "x-conversation-key": RECIPIENT },
      }))
      if (!second.ok || !result.ok) return error(503, "cleanup incomplete")
      const page = await env.CHECKPOINTS.list({ limit: 1 })
      if (page.objects.length || page.truncated) return error(503, "staging bucket not empty")
    }
    return result
  },
}
