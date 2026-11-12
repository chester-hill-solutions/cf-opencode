import { makeClient, portFetch } from "../opencode"
import type { ContainerPort } from "../opencode"
import { ConversationStore, type CheckpointManifest } from "../state"
import type { ConversationUsage, UsageCutoverLedger } from "./usage"
import type { ConversationRecoveryActions } from "./recovery-actions"
import type { ConversationRuntime } from "./runtime"
import type { ConversationImages } from "./images"
import type { ConversationCheckpoints } from "./checkpoints"
import type { ConversationLease } from "./lease"
import { ACCOUNTING_POLICY_ID, assertAccountingPolicy } from "../accounting-policy"
import { plaintextArchivesAllowed, type ArchivePolicyEnv } from "../archive-policy"
import { proveRuntimeQuiescence } from "../runtime-quiescence"
import {
  parseRuntimeUpgradePending,
  type RuntimeUpgradeCompletion,
  type RuntimeUpgradePending,
} from "../runtime-upgrade"

type UnknownRecord = Record<string, unknown>
type RuntimeContainer = NonNullable<DurableObjectState["container"]>

interface RuntimeUpgradePlanSuccess {
  ok: true
  body: UnknownRecord
  pending: RuntimeUpgradePending
}

interface RuntimeUpgradePlanFailure {
  ok: false
  status: number
  error: string
  blockers: string[]
}

export interface ConversationRuntimeUpgradesOptions {
  storage: DurableObjectStorage
  store: ConversationStore
  usage: ConversationUsage
  recoveryActions: ConversationRecoveryActions
  runtime: ConversationRuntime
  images: ConversationImages
  checkpoints: ConversationCheckpoints
  leases: ConversationLease
  id: string
  container(): RuntimeContainer | undefined
  archives: {
    bucket: R2Bucket
    policyEnv: ArchivePolicyEnv
  }
  withAdmissionLock<T>(task: () => Promise<T>): Promise<T>
  live(): { admitting: boolean; pumping: boolean }
  withClient<T>(fn: (client: ReturnType<typeof makeClient>) => Promise<T>, recoverOnRejection?: boolean): Promise<T>
  ensureReady(): Promise<ContainerPort>
}

const CONTROL_PORT = 4001

/** Manual, operator-approved image upgrade flow for a conversation runtime. */
export class ConversationRuntimeUpgrades {
  private runtimeUpgradeResuming = false

  constructor(private readonly options: ConversationRuntimeUpgradesOptions) {}

  get resuming(): boolean {
    return this.runtimeUpgradeResuming
  }

  async pending(): Promise<RuntimeUpgradePending | undefined> {
    const raw = await this.options.storage.get<unknown>("runtimeUpgradePending")
    if (raw === undefined) return undefined
    const pending = parseRuntimeUpgradePending(raw)
    if (pending.conversationID !== this.options.id) {
      throw new Error("runtime upgrade intent belongs to another conversation")
    }
    return pending
  }

  async hasPending(): Promise<boolean> {
    return (await this.options.storage.get<unknown>("runtimeUpgradePending")) !== undefined
  }

  async preview(): Promise<Response> {
    return this.options.withAdmissionLock(async () => {
      const live = this.options.live()
      if (live.admitting || live.pumping || this.options.recoveryActions.active) {
        return Response.json({ error: "conversation has a live local operation" }, { status: 409 })
      }
      try {
        return await this.options.recoveryActions.runAction(() => this.options.usage.serialize(async () => {
          const pending = await this.pending()
          if (pending) {
            const state = await this.options.store.get()
            const ledger = await this.options.usage.ledger().catch(() => undefined)
            if (!ledger || ledger.conversationID !== this.options.id || ledger.holds.length || ledger.blockers.length ||
              state.sessionID !== pending.sessionID || state.queued || state.budgetReservation || state.checkpointPending ||
              (state.phase ?? "idle") !== "idle") {
              return Response.json({ pending: true, canApply: false, error: "runtime upgrade resume is blocked by changed work or usage state" }, { status: 409 })
            }
            return Response.json({ pending: true, canApply: true, planID: pending.planID, sessionID: pending.sessionID, targetImage: pending.targetImage })
          }
          const draft = await this.buildPlan()
          if (!draft.ok) return Response.json({ canApply: false, blockers: draft.blockers, error: draft.error }, { status: draft.status })
          return Response.json(draft.body)
        }))
      } catch {
        return Response.json({ error: "runtime upgrade preview could not be verified", retryable: true }, { status: 503 })
      }
    })
  }

  private async buildPlan(): Promise<RuntimeUpgradePlanSuccess | RuntimeUpgradePlanFailure> {
    const state = await this.options.store.get()
    const sessionID = state.sessionID
    const blockers: string[] = []
    const live = this.options.live()
    if (!sessionID) blockers.push("original_session_required")
    if ((state.phase ?? "idle") !== "idle") blockers.push("conversation_not_idle")
    if (state.queued) blockers.push("queued_work")
    if (state.budgetReservation) blockers.push("local_usage_hold")
    if (state.checkpointPending) blockers.push("checkpoint_pending")
    if (live.admitting || live.pumping || !this.options.recoveryActions.active) blockers.push("live_local_operation")
    const target = this.options.container()?.images?.evented
    const targetImage = typeof target === "string" ? target : ""
    if (!/^[a-zA-Z0-9._:/-]+@sha256:[a-f0-9]{64}$/.test(targetImage)) blockers.push("pinned_evented_image_unavailable")
    if ((await this.options.storage.get<unknown>("containerImageVariant")) === "evented") blockers.push("runtime_already_evented")
    let ledger: UsageCutoverLedger | undefined
    try {
      ledger = await this.options.usage.ledger()
      if (ledger.conversationID !== this.options.id || ledger.blockers.length || ledger.holds.length) {
        blockers.push("central_usage_hold_or_ledger_blocker")
      }
    } catch {
      blockers.push("central_usage_authority_unavailable")
    }
    if (blockers.length) {
      return {
        ok: false,
        status: blockers.includes("central_usage_authority_unavailable") ? 503 : 409,
        error: "runtime upgrade is blocked",
        blockers,
      }
    }
    try {
      await this.options.ensureReady()
      const port = this.options.runtime.apiPort
      const generation = this.options.runtime.generation
      if (!port || !generation) throw new Error("runtime generation unavailable")
      const client = makeClient(portFetch(port))
      assertAccountingPolicy(await client.config.get())
      const quiescent = await this.proveSession(client, sessionID!)
      if (quiescent.proof.sessionID !== sessionID || quiescent.proof.runtimeGeneration !== generation) {
        throw new Error("runtime changed during quiescence proof")
      }
      const localSnapshot = await this.runtimeUpgradeLocalSnapshot()
      const localSnapshotID = await this.sha256(JSON.stringify(localSnapshot))
      const sourceGeneration = generation
      const planCore = {
        conversationID: this.options.id,
        sessionID,
        contextDigest: quiescent.proof.contextDigest,
        sourceGeneration,
        targetImage,
        localSnapshotID,
        centralSnapshotID: ledger!.snapshotID,
      }
      const planID = await this.sha256(JSON.stringify(planCore))
      const manifest: CheckpointManifest = {
        workspace: { key: "preview/workspace.tar.gz", size: 1, encrypted: true },
        state: { key: "preview/state.tar.gz", size: 1, encrypted: true },
        createdAt: 1,
      }
      const intent: RuntimeUpgradePending = {
        planID,
        conversationID: this.options.id,
        sessionID: sessionID!,
        contextDigest: quiescent.proof.contextDigest,
        sourceGeneration,
        targetImage,
        checkpointManifest: manifest,
        startedAt: Math.max(1, Date.now()),
      }
      return {
        ok: true,
        pending: intent,
        body: {
          canApply: true,
          planID,
          conversationID: this.options.id,
          sessionID,
          sourceGeneration,
          targetImage,
          contextDigest: quiescent.proof.contextDigest,
          localSnapshotID,
          centralSnapshotID: ledger!.snapshotID,
          checkpointParts: ["workspace", "state"],
          note: "Applying checkpoints and verifies the saved session before switching this conversation to the evented runtime.",
        },
      }
    } catch {
      return { ok: false, status: 503, error: "runtime upgrade quiescence could not be verified", blockers: ["runtime_or_session_unavailable"] }
    }
  }

  private async runtimeUpgradeLocalSnapshot(): Promise<UnknownRecord> {
    const state = await this.options.store.get()
    return {
      sessionID: state.sessionID ?? null,
      phase: state.phase ?? "idle",
      queued: state.queued ?? null,
      budgetReservation: state.budgetReservation ?? null,
      checkpointPending: state.checkpointPending ?? null,
      checkpointManifest: state.checkpointManifest ?? null,
      checkpointKey: state.checkpointKey ?? null,
      settingsVersion: state.settingsVersion ?? null,
      operatorReconciliation: state.operatorReconciliation ?? null,
      containerImageVariant: await this.options.storage.get<unknown>("containerImageVariant") ?? null,
    }
  }

  private async sha256(value: string): Promise<string> {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")
  }

  async proveSession(
    client: ReturnType<typeof makeClient>,
    sessionID: string,
  ): Promise<Awaited<ReturnType<typeof proveRuntimeQuiescence>>> {
    return proveRuntimeQuiescence({
      client,
      sessionID,
      getRuntimeGeneration: async (signal) => {
        const control = await this.options.runtime.port(CONTROL_PORT)
        const response = await control.fetch("http://container/start", { method: "POST", signal })
        if (!response.ok) throw new Error("runtime proof unavailable")
        const proof = await response.json() as UnknownRecord
        if (proof.ok !== true || proof.accountingPolicy !== ACCOUNTING_POLICY_ID ||
          typeof proof.opencodeGeneration !== "string" || !proof.opencodeGeneration) {
          throw new Error("runtime generation proof invalid")
        }
        this.options.runtime.recordProof(proof.opencodeGeneration, proof.eventPersistence === true)
        return proof.opencodeGeneration
      },
    })
  }

  private async validateRuntimeUpgradeArchive(manifest: CheckpointManifest): Promise<void> {
    if (!manifest.state || manifest.workspace.size <= 0 || manifest.state.size <= 0 ||
      manifest.workspace.key === manifest.state.key) throw new Error("split checkpoint is incomplete")
    const keyPrefix = `workspaces/${this.options.id}/`
    for (const part of [manifest.workspace, manifest.state]) {
      if (!part.key.startsWith(keyPrefix) || !Number.isSafeInteger(part.size) || part.size <= 0) {
        throw new Error("split checkpoint metadata is invalid")
      }
      const object = await this.options.archives.bucket.get(part.key)
      if (!object || object.size !== part.size ||
        object.customMetadata?.encrypted !== (part.encrypted ? "1" : "0")) {
        throw new Error("split checkpoint object does not match its manifest")
      }
      if (!part.encrypted && !plaintextArchivesAllowed(this.options.archives.policyEnv)) {
        throw new Error("plaintext checkpoint archives are disabled")
      }
      const clear = await this.options.checkpoints.decryptBody(object.body, part.encrypted)
      const bytes = await new Response(clear).arrayBuffer()
      if (bytes.byteLength <= 0) throw new Error("split checkpoint archive is empty")
    }
  }

  async apply(expectedPlanID: string): Promise<Response> {
    return this.options.withAdmissionLock(async () => {
      const live = this.options.live()
      if (live.admitting || live.pumping || this.options.recoveryActions.active) {
        return Response.json({ error: "conversation has a live local operation" }, { status: 409 })
      }
      try {
        return await this.options.recoveryActions.runAction(() => this.options.usage.serialize(async () => {
          const completed = await this.options.storage.get<RuntimeUpgradeCompletion>("runtimeUpgradeCompletion")
          if (completed?.planID === expectedPlanID && completed.conversationID === this.options.id) {
            return Response.json({ ok: true, completed: true, replayed: true, receipt: completed })
          }
          let pending = await this.pending()
          if (!pending) {
            const plan = await this.buildPlan()
            if (!plan.ok) return Response.json({ error: plan.error, blockers: plan.blockers }, { status: plan.status })
            if (plan.pending.planID !== expectedPlanID) return Response.json({ error: "runtime upgrade plan changed; review a fresh preview" }, { status: 409 })
            if (!await this.options.checkpoints.capture()) return Response.json({ error: "checkpoint failed; current runtime was kept" }, { status: 503 })
            const latestState = await this.options.store.get()
            const manifest = latestState.checkpointManifest
            if (!manifest) return Response.json({ error: "a published split checkpoint is required; current runtime was kept" }, { status: 503 })
            await this.validateRuntimeUpgradeArchive(manifest)
            if (!this.options.runtime.apiPort) return Response.json({ error: "runtime port changed after checkpoint; current runtime was kept" }, { status: 409 })
            const afterCheckpoint = await this.proveSession(
              makeClient(portFetch(this.options.runtime.apiPort)),
              plan.pending.sessionID,
            )
            if (afterCheckpoint.proof.contextDigest !== plan.pending.contextDigest ||
              afterCheckpoint.proof.runtimeGeneration !== plan.pending.sourceGeneration) {
              return Response.json({ error: "session changed after checkpoint; current runtime was kept" }, { status: 409 })
            }
            pending = parseRuntimeUpgradePending({ ...plan.pending, checkpointManifest: manifest })
            await this.options.storage.transaction(async (txn) => {
              await txn.put("runtimeUpgradePending", pending!)
              await txn.put("containerImageVariant", "evented")
            })
          } else if (pending.planID !== expectedPlanID) {
            return Response.json({ error: "another runtime upgrade is pending" }, { status: 409 })
          }
          const current = await this.options.store.get()
          const ledger = await this.options.usage.ledger().catch(() => undefined)
          const currentLive = this.options.live()
          if (!ledger || ledger.conversationID !== this.options.id || ledger.holds.length || ledger.blockers.length ||
            current.sessionID !== pending.sessionID || current.queued || current.budgetReservation || current.checkpointPending ||
            (current.phase ?? "idle") !== "idle" || currentLive.admitting || currentLive.pumping) {
            return Response.json({ error: "runtime upgrade resume is blocked by changed work or usage state" }, { status: 409 })
          }
          await this.validateRuntimeUpgradeArchive(pending.checkpointManifest)
          const container = this.options.container()
          if (!container) return Response.json({ error: "container binding unavailable; upgrade remains pending" }, { status: 503 })
          if (container.images?.evented !== pending.targetImage) {
            return Response.json({ error: "configured evented image changed; upgrade remains pending" }, { status: 409 })
          }
          if (!(await this.options.runtime.stop())) {
            return Response.json({ error: "container stop was not confirmed; upgrade remains pending" }, { status: 503 })
          }
          if (!(await this.options.leases.releaseAfterStop())) {
            return Response.json({ error: "container lease release is pending; upgrade remains pending" }, { status: 503 })
          }
          this.runtimeUpgradeResuming = true
          try {
            await this.options.ensureReady()
          } finally {
            this.runtimeUpgradeResuming = false
          }
          const receipt = await this.options.storage.get<RuntimeUpgradeCompletion>("runtimeUpgradeCompletion")
          if (!receipt || receipt.planID !== expectedPlanID) {
            return Response.json({ error: "restored runtime proof is incomplete; upgrade remains pending" }, { status: 503 })
          }
          return Response.json({ ok: true, completed: true, receipt })
        }))
      } catch (error) {
        return Response.json({ error: errorMessage(error), pending: true, retryable: true }, { status: 503 })
      }
    })
  }

  async checkpoint(pending: RuntimeUpgradePending): Promise<{
    workspace: R2ObjectBody
    state: R2ObjectBody
    split: true
  }> {
    await this.validateRuntimeUpgradeArchive(pending.checkpointManifest)
    const workspace = await this.options.archives.bucket.get(pending.checkpointManifest.workspace.key)
    const state = await this.options.archives.bucket.get(pending.checkpointManifest.state!.key)
    if (!workspace || !state) throw new Error("pending runtime upgrade checkpoint parts are unavailable")
    return { workspace, state, split: true }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
