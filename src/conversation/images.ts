import { logEvent } from "../log"
import { withSpan } from "../telemetry"
import type { ConversationRuntime } from "./runtime"
import { LEGACY_ALARM_MIGRATION_KEY, isFreshLegacyAlarmMigration } from "./job-state"
import type { ConversationState } from "../state"

type RuntimeContainer = NonNullable<DurableObjectState["container"]>

export interface ConversationImagesOptions {
  storage: DurableObjectStorage
  runtime: ConversationRuntime
  container(): RuntimeContainer | undefined
  key(): string | undefined
  env(): {
    EVENTED_CANARY_KEY?: string
    EVENTED_FRESH_CONVERSATIONS?: string
  }
  cachedToken(): string | undefined
  count(name: string): Promise<void>
}

/** Owns image selection, freshness guards, and the fast snapshot cache. */
export class ConversationImages {
  constructor(private readonly options: ConversationImagesOptions) {}

  startOptions(): ContainerStartupOptions {
    const images = (this.options.container() as unknown as { images?: Record<string, string> } | undefined)?.images
    const eventedCanary = this.options.runtime.imageVariant === "evented" || this.isEventedCanary()
    const image = eventedCanary ? images?.evented : images?.base
    if (eventedCanary && !image) throw new Error("evented canary image is not configured")
    if (!eventedCanary && !image) throw new Error("base container image is not configured")
    const token = this.options.cachedToken()
    return {
      enableInternet: true,
      image,
      // `basic` has no exact equivalent on this policy; standard-1 is the
      // closest size with enough memory for OpenCode plus stow.
      instance: "standard-1",
      ...(token ? { env: { CONTROL_TOKEN: token } } : {}),
    } as ContainerStartupOptions
  }

  async snapshotHandle(): Promise<ContainerSnapshot | undefined> {
    const binding = await this.options.storage.get<unknown>("containerImageVariant")
    if (binding === "evented" || this.options.runtime.imageVariant === "evented" || this.isEventedCanary()) return undefined
    return this.options.storage.get<ContainerSnapshot>("snapshot")
  }

  private isEventedCanary(): boolean {
    const canaryKey = this.options.env().EVENTED_CANARY_KEY?.trim()
    return Boolean(canaryKey && this.options.key() === canaryKey)
  }

  private canRouteFreshConversationsToEvented(): boolean {
    return this.options.env().EVENTED_FRESH_CONVERSATIONS === "true"
  }

  /** Only command/dedupe bookkeeping from never-started conversations is tolerated. */
  private async isFreshUnstartedConversation(container: RuntimeContainer): Promise<boolean> {
    if (container.running) return false
    const stored = await this.options.storage.list()
    for (const key of stored.keys()) {
      if (key === "state") continue
      if (key === "conversationJobEpoch") {
        const epoch = await this.options.storage.get<number>(key)
        if (!Number.isSafeInteger(epoch) || (epoch ?? 0) < 1) return false
        continue
      }
      if (key === LEGACY_ALARM_MIGRATION_KEY) {
        if (!isFreshLegacyAlarmMigration(await this.options.storage.get(key))) return false
        continue
      }
      const match = /^tombstones:(\d{4}-\d{2}-\d{2})$/.exec(key)
      if (!match) return false
      const date = match[1]!
      try {
        if (new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) return false
      } catch {
        return false
      }
    }

    const value = await this.options.storage.get<unknown>("state")
    if (value === undefined) return true
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const state = value as Record<string, unknown>
    const allowed = new Set([
      "phase", "seen", "pending", "slackEngaged", "modelOverride",
      "transport", "slack", "announcedForms", "admissionID", "admissionStartedAt",
    ])
    if (Object.entries(state).some(([key, field]) => field !== undefined && !allowed.has(key))) return false
    if (state.phase !== undefined && state.phase !== "idle" && state.phase !== "admitting") return false
    if (state.seen !== undefined &&
      (!Array.isArray(state.seen) || !state.seen.every((id) => typeof id === "string"))) return false
    if (state.pending !== undefined &&
      (!state.pending || typeof state.pending !== "object" || Array.isArray(state.pending) ||
        Object.keys(state.pending).length !== 0)) return false
    if (state.slackEngaged !== undefined && typeof state.slackEngaged !== "boolean") return false
    if (state.admissionID !== undefined && (typeof state.admissionID !== "string" || !state.admissionID ||
      !Number.isSafeInteger(state.admissionStartedAt) || (state.admissionStartedAt as number) <= 0)) return false
    if (state.admissionStartedAt !== undefined && (typeof state.admissionStartedAt !== "number" ||
      !Number.isSafeInteger(state.admissionStartedAt) || state.admissionStartedAt <= 0 || !state.admissionID)) return false
    if (state.modelOverride !== undefined && typeof state.modelOverride !== "string") return false
    if (state.transport !== undefined && state.transport !== "http" && state.transport !== "slack") return false
    if (state.slack !== undefined) {
      if (!state.slack || typeof state.slack !== "object" || Array.isArray(state.slack)) return false
      const target = state.slack as Record<string, unknown>
      if (Object.keys(target).some((key) => key !== "channel" && key !== "replyTs") ||
        typeof target.channel !== "string" || !target.channel ||
        (target.replyTs !== undefined && typeof target.replyTs !== "string")) return false
    }
    if (state.announcedForms !== undefined &&
      (!Array.isArray(state.announcedForms) || state.announcedForms.length !== 0)) return false
    return true
  }

  async prepareContainerImageVariant(container: RuntimeContainer): Promise<void> {
    const stored = await this.options.storage.get<unknown>("containerImageVariant")
    if (stored !== undefined) {
      if (stored !== "evented") throw new Error("unknown container image binding; refusing to fall back")
      this.options.runtime.bindImage("evented")
      this.startOptions()
      return
    }

    const explicitlySelected = this.isEventedCanary()
    if (!explicitlySelected && !this.canRouteFreshConversationsToEvented()) {
      this.options.runtime.bindImage("base")
      this.startOptions()
      return
    }
    if (!explicitlySelected && !(await this.isFreshUnstartedConversation(container))) {
      this.options.runtime.bindImage("base")
      this.startOptions()
      return
    }
    this.options.runtime.bindImage("evented")
    this.startOptions()
    if (explicitlySelected) await this.assertFreshEventedCanary()
    await this.options.storage.put("containerImageVariant", "evented")
  }

  private async assertFreshEventedCanary(): Promise<void> {
    const keys = await this.options.storage.list()
    for (const key of keys.keys()) {
      if (key === "state") continue
      if (key === "conversationJobEpoch") {
        const epoch = await this.options.storage.get<number>(key)
        if (Number.isSafeInteger(epoch) && (epoch ?? 0) > 0) continue
      }
      if (key === LEGACY_ALARM_MIGRATION_KEY &&
        isFreshLegacyAlarmMigration(await this.options.storage.get(key))) continue
      throw new Error("evented canary requires a fresh conversation with no history or holds")
    }
    const state = await this.options.storage.get<ConversationState>("state")
    if (!state) return
    const allowedKeys = new Set([
      "phase", "seen", "pending", "slackEngaged", "modelOverride", "transport", "slack",
      "announcedForms", "admissionID", "admissionStartedAt",
    ])
    if (Object.keys(state).some((key) => !allowedKeys.has(key)) ||
      state.phase !== "admitting" ||
      (state.seen?.length ?? 0) > 1 ||
      (state.seen !== undefined && (!Array.isArray(state.seen) || !state.seen.every((id) => typeof id === "string"))) ||
      Object.keys(state.pending ?? {}).length > 0 ||
      (state.slackEngaged !== undefined && state.slackEngaged !== true) ||
      (state.pending !== undefined && (!state.pending || typeof state.pending !== "object" || Array.isArray(state.pending))) ||
      (state.admissionID !== undefined && (typeof state.admissionID !== "string" || !state.admissionID ||
        !Number.isSafeInteger(state.admissionStartedAt) || (state.admissionStartedAt ?? 0) <= 0)) ||
      (state.admissionStartedAt !== undefined && (typeof state.admissionStartedAt !== "number" ||
        !Number.isSafeInteger(state.admissionStartedAt) || state.admissionStartedAt <= 0 || !state.admissionID)) ||
      (state.modelOverride !== undefined && typeof state.modelOverride !== "string") ||
      (state.transport !== undefined && state.transport !== "http" && state.transport !== "slack") ||
      (state.announcedForms !== undefined && (!Array.isArray(state.announcedForms) || state.announcedForms.length !== 0)) ||
      (state.slack !== undefined && (!state.slack || Object.keys(state.slack).some((key) => key !== "channel" && key !== "replyTs") ||
        typeof state.slack.channel !== "string" || !state.slack.channel ||
        (state.slack.replyTs !== undefined && typeof state.slack.replyTs !== "string")))) {
      throw new Error("evented canary requires a fresh conversation with no history or holds")
    }
  }

  async loadContainerImageVariant(container?: RuntimeContainer): Promise<void> {
    const stored = await this.options.storage.get<unknown>("containerImageVariant")
    if (stored !== undefined) {
      if (stored !== "evented") throw new Error("unknown container image binding; refusing to fall back")
      if (!container?.images?.evented) throw new Error("evented canary image is not configured")
      this.options.runtime.bindImage("evented")
      return
    }
    if (this.isEventedCanary() && container?.running) {
      throw new Error("running evented canary container has no durable image binding")
    }
    this.options.runtime.bindImage(undefined)
  }

  async clearSnapshot(): Promise<boolean> {
    const existing = await this.options.storage.get<ContainerSnapshot>("snapshot")
    await this.options.storage.delete("snapshot")
    return Boolean(existing)
  }

  async captureSnapshot(): Promise<void> {
    return withSpan("container.snapshot", async (span) => {
      try {
        const snapshot = await this.options.container()?.snapshotContainer({ name: "turn" })
        if (!snapshot) return
        await this.options.storage.put("snapshot", snapshot)
        span.setAttribute("snapshot.bytes", snapshot.size)
        logEvent("snapshot.saved", { bytes: snapshot.size })
        await this.options.count("snapshot.saved")
      } catch (error) {
        span.recordException(error as Error)
        logEvent("snapshot.failed")
        void this.options.count("snapshot.failed")
      }
    })
  }
}
