import { makeClient, portFetch, type ContainerPort } from "../opencode"
import type { CredentialEntry } from "@opencode/client"
import type { Env } from "../env"
import { ConversationStore } from "../state"
import type { ConversationRuntime } from "./runtime"
import type { ConversationImages } from "./images"
import type { ConversationCheckpoints } from "./checkpoints"
import type { ConversationLease } from "./lease"
import type { HarnessSettings } from "../settings"
import { AccountingPolicyError, ACCOUNTING_POLICY_ID, assertAccountingPolicy } from "../accounting-policy"
import { accountStateKey, parseConversationKey } from "../tenancy"
import { parseRuntimeUpgradePending, verifyRestoredRuntimeUpgrade, type RuntimeUpgradePending } from "../runtime-upgrade"
import { logEvent } from "../log"

const OPENCODE_PORT = 4000
const CONTROL_PORT = 4001
const ONBOARDING_KEY = "onboarding"

type RuntimeContainer = NonNullable<DurableObjectState["container"]>
type OpenCodeClient = ReturnType<typeof makeClient>
type ReadinessEnv = Pick<Env,
  "CONTAINER_URL" | "CHECKPOINTS" | "CONVERSATION" | "VAULT_MASTER_KEY" |
  "ALLOW_PLAINTEXT_ARCHIVES" | "WORKSPACE_ID">

export interface ConversationReadinessOptions {
  storage: DurableObjectStorage
  store: ConversationStore
  runtime: ConversationRuntime
  images: ConversationImages
  checkpoints: ConversationCheckpoints
  leases: Pick<ConversationLease, "releaseAfterStop">
  identity: { id: string; key(): string | undefined }
  platform: { container(): RuntimeContainer | undefined; transportEnabled(): boolean }
  env(): ReadinessEnv
  configuration: {
    settings(): Promise<HarnessSettings>
    githubToken(): Promise<string | undefined>
  }
  activity: {
    pumping(): boolean
    onboardingOperations(): number
    upgradeResuming(): boolean
  }
  upgrade: {
    pending(): Promise<RuntimeUpgradePending | undefined>
    checkpoint(pending: RuntimeUpgradePending): Promise<{
      workspace: R2ObjectBody
      state: R2ObjectBody
      split: true
    }>
    proveSession(client: OpenCodeClient, sessionID: string): Promise<{ proof: { runtimeGeneration: string; contextDigest: string } }>
  }
  adoptLeaseIfNeeded(): Promise<void>
}

/** Container configuration, archive restore, accounting proof, and onboarding sync. */
export class ConversationReadiness {
  private providerSyncAt?: number

  constructor(private readonly options: ConversationReadinessOptions) {}

  resetProviderSync(): void {
    this.providerSyncAt = undefined
  }

  async prepare(): Promise<ContainerPort> {
    const key = this.options.identity.key()
    if (!key) throw new Error("conversation identity unavailable; runtime preparation is blocked")
    const upgradePending = await this.options.upgrade.pending()
    if (upgradePending && !this.options.activity.upgradeResuming()) {
      throw new Error("runtime upgrade is pending; an operator must resume verification before this conversation can run")
    }
    if (upgradePending && upgradePending.conversationID !== this.options.identity.id) {
      throw new Error("runtime upgrade intent belongs to another conversation")
    }
    const container = this.options.platform.container()
    if (container?.running) this.options.runtime.applyInactivity(container)
    await this.options.images.loadContainerImageVariant(container)
    await this.options.adoptLeaseIfNeeded()
    if (upgradePending && container?.images?.evented !== upgradePending.targetImage) {
      throw new Error("configured evented image does not match the pending upgrade")
    }
    const settings = await this.options.configuration.settings()
    const state = await this.options.store.get()
    if (!container && !this.options.env().CONTAINER_URL && !this.options.platform.transportEnabled()) {
      throw new Error("no container bound")
    }

    const versionChanged = state.settingsVersion !== undefined && state.settingsVersion !== settings.version
    // A warm event stream can stay open across idle turns; only a live turn
    // should protect the container from a settings-driven restart.
    const busy =
      this.options.activity.pumping() ||
      (this.options.identity.key() === ONBOARDING_KEY && this.options.activity.onboardingOperations() > 0) ||
      state.budgetReservation !== undefined ||
      state.phase === "running" ||
      state.phase === "settling"
    const providerSyncAt = settings.onboarding.opencodeConnectedAt
    const providerSyncEligible = Boolean(providerSyncAt && key && key !== ONBOARDING_KEY && !parseConversationKey(key))
    if (!providerSyncEligible) this.providerSyncAt = undefined
    const providerSyncNeeded = providerSyncEligible && this.providerSyncAt !== providerSyncAt
    let deferSettingsRestart = false

    // A settings change is applied between runs: destroying mid-run loses the turn.
    if (container && versionChanged && container.running && busy) {
      if (this.options.runtime.ready && this.options.runtime.apiPort && this.options.runtime.generation) {
        return this.options.runtime.apiPort
      }
      // A restarted DO can lack the old port cache while an accepted prompt is
      // still running. Verify the live runtime without reconfiguring or
      // destroying it; the new settings apply after this turn settles.
      deferSettingsRestart = true
    }
    if (!upgradePending && container && versionChanged && container.running && !deferSettingsRestart) {
      // A settings-driven restart must carry forward the provider credentials
      // and OpenCode database that live in the current container. Its prior
      // checkpoint may predate an account connection, so never destroy before
      // a fresh portable archive is safely stored.
      const saved = await this.options.checkpoints.captureOwned()
      if (!saved) throw new Error("settings changed but checkpoint failed; keeping the current container")
      if (!(await this.options.runtime.stop())) throw new Error("container stop was not confirmed; keeping the current runtime")
      if (!(await this.options.leases.releaseAfterStop())) throw new Error("container lease release is pending; keeping restart blocked")
      await this.options.images.clearSnapshot()
    }

    // Fast path: this instance already verified the container for this spec.
    if (!upgradePending && this.options.runtime.ready && this.options.runtime.apiPort && this.options.runtime.generation &&
      (!container || container.running) && !versionChanged && (!providerSyncNeeded || busy)) {
      return this.options.runtime.apiPort
    }

    const control = await this.options.runtime.port(CONTROL_PORT)
    const status = await (await control.fetch("http://container/status", {
      signal: AbortSignal.timeout(10_000),
    })).json() as { initialized?: boolean }

    if (!status.initialized) {
      const checkpoint = upgradePending
        ? await this.options.upgrade.checkpoint(upgradePending)
        : await this.options.checkpoints.latest()
      if (checkpoint) {
        const workspace = await this.options.checkpoints.decryptBody(
          checkpoint.workspace.body,
          checkpoint.workspace.customMetadata?.encrypted === "1",
        )
        const workspaceQuery = checkpoint.split
          ? "?part=workspace" + (checkpoint.state ? "" : "&final=1")
          : ""
        const restoredWorkspace = await control.fetch("http://container/restore" + workspaceQuery, {
          method: "POST", body: workspace, signal: AbortSignal.timeout(60_000),
        })
        if (!restoredWorkspace.ok) {
          logEvent("checkpoint.restore.failed", { part: "workspace", status: restoredWorkspace.status })
          throw new Error("workspace restore failed: " + restoredWorkspace.status)
        }
        if (checkpoint.state) {
          const stateArchive = await this.options.checkpoints.decryptBody(
            checkpoint.state.body,
            checkpoint.state.customMetadata?.encrypted === "1",
          )
          const restoredState = await control.fetch("http://container/restore?part=state", {
            method: "POST", body: stateArchive, signal: AbortSignal.timeout(60_000),
          })
          if (!restoredState.ok) {
            logEvent("checkpoint.restore.failed", { part: "state", status: restoredState.status })
            throw new Error("state restore failed: " + restoredState.status)
          }
        }
        await this.options.store.patch({ checkpointFingerprint: undefined, checkpointStateFingerprint: undefined })
      } else if (!upgradePending) {
        // A fresh conversation inherits the account provider credentials. A
        // namespaced agent never falls back to the legacy global account seed.
        const env = this.options.env()
        const seed = await env.CHECKPOINTS.get(accountStateKey(parseConversationKey(key)))
        if (seed?.body) {
          const body = seed.customMetadata?.encrypted === "1"
            ? await this.options.checkpoints.decryptBody(seed.body, true)
            : seed.body
          const seeded = await control.fetch("http://container/seed-state", {
            method: "POST", body, signal: AbortSignal.timeout(60_000),
          })
          if (!seeded.ok) logEvent("account.seed.failed", { status: seeded.status })
        }
      }
    }

    // Configure after restore: /restore replaces /workspace, including the config.
    // A warm container on the same spec already has its config.
    if (!upgradePending && (!status.initialized || (versionChanged && !deferSettingsRestart))) {
      const githubToken = await this.options.configuration.githubToken()
      await control.fetch("http://container/configure", {
        method: "POST",
        body: JSON.stringify({ ...settings, ...(githubToken ? { githubToken } : {}) }),
        signal: AbortSignal.timeout(10_000),
      })
    }

    const startedAt = Date.now()
    const started = await control.fetch("http://container/start", { method: "POST", signal: AbortSignal.timeout(120_000) })
    if (!started.ok) throw new Error("container start failed: " + await started.text())
    const proof = await started.json().catch(() => undefined) as {
      ok?: unknown
      accountingPolicy?: unknown
      opencodeGeneration?: unknown
      eventPersistence?: unknown
    } | undefined
    if (proof?.ok !== true || proof.accountingPolicy !== ACCOUNTING_POLICY_ID ||
      typeof proof.opencodeGeneration !== "string" || !proof.opencodeGeneration) {
      throw new AccountingPolicyError("container start returned no valid accounting runtime proof")
    }
    // Proof fields are committed together only after policy verification succeeds.
    if (this.options.runtime.imageVariant === "evented" && proof.eventPersistence !== true) {
      throw new AccountingPolicyError("evented canary runtime did not confirm persistent events")
    }
    const runtimeChanged = this.options.runtime.generation !== proof.opencodeGeneration
    // Verify effective OpenCode config before allowing any provider request.
    const port = await this.options.runtime.port(OPENCODE_PORT)
    const opencode = makeClient(portFetch(port))
    assertAccountingPolicy(await opencode.config.get())
    if (upgradePending) {
      const targetImage = this.options.platform.container()?.images?.evented
      if (!targetImage || targetImage !== upgradePending.targetImage || this.options.runtime.imageVariant !== "evented") {
        throw new Error("restored runtime image does not match the pending upgrade")
      }
      const restoredQuiescence = await this.options.upgrade.proveSession(opencode, upgradePending.sessionID)
      if (restoredQuiescence.proof.runtimeGeneration !== proof.opencodeGeneration ||
        restoredQuiescence.proof.contextDigest !== upgradePending.contextDigest) {
        throw new Error("restored runtime quiescence does not match the saved upgrade intent")
      }
      const completion = await verifyRestoredRuntimeUpgrade({
        pending: upgradePending,
        client: opencode.session,
        actualTargetImage: targetImage,
        eventPersistence: proof.eventPersistence === true,
        currentGeneration: proof.opencodeGeneration,
      })
      await this.options.storage.transaction(async (txn) => {
        const current = parseRuntimeUpgradePending(await txn.get("runtimeUpgradePending"))
        if (current.planID !== upgradePending.planID || current.conversationID !== this.options.identity.id) {
          throw new Error("runtime upgrade intent changed during restore verification")
        }
        await txn.put("runtimeUpgradeCompletion", completion)
        await txn.delete("runtimeUpgradePending")
      })
    }
    if (providerSyncEligible && providerSyncAt && runtimeChanged && busy) this.providerSyncAt = undefined
    if (providerSyncEligible && providerSyncAt && !busy && (providerSyncNeeded || runtimeChanged)) {
      await this.syncOnboardingCredentials(opencode)
      this.providerSyncAt = providerSyncAt
    }
    await this.options.store.increment("containerStarts")
    if (!upgradePending && state.settingsVersion !== settings.version && !deferSettingsRestart) {
      await this.options.store.patch({ settingsVersion: settings.version })
    }

    logEvent("container.ready", { durationMs: Date.now() - startedAt })
    this.options.runtime.markVerified(port, proof.opencodeGeneration, proof.eventPersistence === true)
    return port
  }

  private async syncOnboardingCredentials(target: OpenCodeClient): Promise<void> {
    try {
      const sourceResponse = await this.options.env().CONVERSATION.getByName(ONBOARDING_KEY).fetch(
        "https://conversation/provider-credentials",
        { headers: { "x-conversation-key": ONBOARDING_KEY } },
      )
      if (!sourceResponse.ok) throw new Error("source unavailable")
      const source = await sourceResponse.json() as unknown
      if (!Array.isArray(source)) throw new Error("invalid source")
      const credentials = source as CredentialEntry[]
      const sourceCredentials = credentials.filter((credential) => credential?.active && credential.value.type === "key")
      const local = await target.credential.list()
      const activeIntegrations = new Set(local.filter((credential) => credential.active).map((credential) => credential.integrationID))
      for (const credential of sourceCredentials) {
        if (!credential.integrationID || activeIntegrations.has(credential.integrationID)) continue
        await target.credential.create({
          id: credential.id,
          integrationID: credential.integrationID,
          label: credential.label,
          value: credential.value,
          activate: true,
        })
        activeIntegrations.add(credential.integrationID)
      }
    } catch {
      throw new Error("provider setup sync failed; reconnect providers with !setup")
    }
  }
}
