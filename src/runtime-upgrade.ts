import type { makeClient } from "./opencode"
import type { CheckpointManifest } from "./state"
import { digestRuntimeContext } from "./runtime-quiescence"

export interface RuntimeUpgradePending {
  planID: string
  conversationID: string
  sessionID: string
  contextDigest: string
  sourceGeneration: string
  targetImage: string
  checkpointManifest: CheckpointManifest
  startedAt: number
}

export interface RuntimeUpgradeCompletion extends RuntimeUpgradePending {
  targetGeneration: string
  completedAt: number
}

export type RuntimeUpgradeClient = Pick<ReturnType<typeof makeClient>["session"], "get" | "context">

export interface VerifyRestoredRuntimeUpgradeInput {
  pending: RuntimeUpgradePending | unknown
  client: RuntimeUpgradeClient
  actualTargetImage: string
  eventPersistence: boolean
  currentGeneration: string
  signal?: AbortSignal
  /** Tests may lower the production 10-second read deadline. */
  timeoutMs?: number
  /** Tests may provide a stable completion time. */
  completedAt?: number
}

export class RuntimeUpgradeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RuntimeUpgradeError"
  }
}

/**
 * Validate a persisted migration intent before it can control image selection.
 * A split checkpoint with both parts and a content-addressed target are required.
 */
export function parseRuntimeUpgradePending(value: unknown): RuntimeUpgradePending {
  if (!isRecord(value) || Object.keys(value).some((key) => !PENDING_FIELDS.has(key)) ||
    [...PENDING_FIELDS].some((key) => !(key in value))) {
    throw new RuntimeUpgradeError("runtime upgrade intent is malformed")
  }
  const manifest = parseSplitManifest(value.checkpointManifest)
  if (!bounded(value.planID) || !bounded(value.conversationID) || !bounded(value.sessionID) ||
    !isSha256(value.contextDigest) || !bounded(value.sourceGeneration) ||
    !isPinnedImage(value.targetImage) || !Number.isSafeInteger(value.startedAt) || (value.startedAt as number) <= 0) {
    throw new RuntimeUpgradeError("runtime upgrade intent is malformed")
  }
  return {
    planID: value.planID,
    conversationID: value.conversationID,
    sessionID: value.sessionID,
    contextDigest: value.contextDigest,
    sourceGeneration: value.sourceGeneration,
    targetImage: value.targetImage,
    checkpointManifest: manifest,
    startedAt: value.startedAt as number,
  }
}

/**
 * Restore barrier to call before caching readiness or allowing ensureSession to
 * replace/create a session. The caller owns DO admission/recovery/usage fences.
 */
export async function verifyRestoredRuntimeUpgrade(
  input: VerifyRestoredRuntimeUpgradeInput,
): Promise<Readonly<RuntimeUpgradeCompletion>> {
  const pending = parseRuntimeUpgradePending(input.pending)
  if (input.actualTargetImage !== pending.targetImage) throw new RuntimeUpgradeError("runtime upgrade target image changed")
  if (input.eventPersistence !== true) throw new RuntimeUpgradeError("restored runtime does not retain events")
  if (!bounded(input.currentGeneration) || input.currentGeneration === pending.sourceGeneration) {
    throw new RuntimeUpgradeError("runtime generation did not change")
  }
  const timeoutMs = Math.min(input.timeoutMs ?? 10_000, 10_000)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RuntimeUpgradeError("invalid restore verification timeout")

  const controller = new AbortController()
  const abortFromCaller = () => controller.abort()
  if (input.signal?.aborted) controller.abort()
  else input.signal?.addEventListener("abort", abortFromCaller, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const signal = controller.signal
  try {
    const session = await withinDeadline(
      input.client.get({ sessionID: pending.sessionID }, { signal }), signal,
    )
    if (!session || session.id !== pending.sessionID) {
      throw new RuntimeUpgradeError("original session was not restored")
    }
    const context = await withinDeadline(
      input.client.context({ sessionID: pending.sessionID }, { signal }), signal,
    )
    if (!Array.isArray(context)) throw new RuntimeUpgradeError("original session history is unreadable")
    const contextDigest = await digestRuntimeContext(context)
    if (contextDigest !== pending.contextDigest) {
      throw new RuntimeUpgradeError("original session history changed during runtime upgrade")
    }
    return Object.freeze({
      ...pending,
      checkpointManifest: Object.freeze({
        ...pending.checkpointManifest,
        workspace: Object.freeze({ ...pending.checkpointManifest.workspace }),
        state: Object.freeze({ ...pending.checkpointManifest.state! }),
      }),
      targetGeneration: input.currentGeneration,
      completedAt: input.completedAt ?? Date.now(),
    })
  } catch (error) {
    if (signal.aborted) throw new RuntimeUpgradeError("restored runtime verification timed out or was cancelled")
    if (error instanceof RuntimeUpgradeError) throw error
    throw new RuntimeUpgradeError("restored session history could not be verified")
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener("abort", abortFromCaller)
  }
}

const PENDING_FIELDS = new Set([
  "planID", "conversationID", "sessionID", "contextDigest", "sourceGeneration",
  "targetImage", "checkpointManifest", "startedAt",
])

function parseSplitManifest(value: unknown): CheckpointManifest {
  if (!isRecord(value) || !isRecord(value.workspace) || !isRecord(value.state) ||
    !hasOnlyKeys(value, ["workspace", "state", "fingerprint", "stateFingerprint", "createdAt"]) ||
    !hasOnlyKeys(value.workspace, ["key", "size", "encrypted"]) ||
    !hasOnlyKeys(value.state, ["key", "size", "encrypted"]) ||
    !bounded(value.workspace.key) || !bounded(value.state.key) ||
    value.workspace.key === value.state.key ||
    !positiveInteger(value.workspace.size) || !positiveInteger(value.state.size) ||
    typeof value.workspace.encrypted !== "boolean" || typeof value.state.encrypted !== "boolean" ||
    !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) <= 0) {
    throw new RuntimeUpgradeError("runtime upgrade requires a valid split checkpoint manifest")
  }
  if (value.fingerprint !== undefined && !isSha256(value.fingerprint)) {
    throw new RuntimeUpgradeError("runtime upgrade checkpoint fingerprint is malformed")
  }
  if (value.stateFingerprint !== undefined && !isSha256(value.stateFingerprint)) {
    throw new RuntimeUpgradeError("runtime upgrade state fingerprint is malformed")
  }
  return {
    workspace: {
      key: value.workspace.key,
      size: value.workspace.size,
      encrypted: value.workspace.encrypted,
    },
    state: {
      key: value.state.key,
      size: value.state.size,
      encrypted: value.state.encrypted,
    },
    ...(value.fingerprint === undefined ? {} : { fingerprint: value.fingerprint }),
    ...(value.stateFingerprint === undefined ? {} : { stateFingerprint: value.stateFingerprint }),
    createdAt: value.createdAt as number,
  }
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function bounded(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
}

function isPinnedImage(value: unknown): value is string {
  return typeof value === "string" && value.length <= 2048 &&
    /^[a-zA-Z0-9._:/-]+@sha256:[a-f0-9]{64}$/.test(value)
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function withinDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new RuntimeUpgradeError("runtime verification was cancelled"))
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new RuntimeUpgradeError("runtime verification was cancelled"))
    signal.addEventListener("abort", onAbort, { once: true })
  })
  return Promise.race([promise, aborted]).finally(() => {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  })
}
