import { parseWorkspaceCheckIntent, parseWorkspaceCheckLocalReceipt, type WorkspaceCheckIntent, type WorkspaceCheckLocalReceipt } from "./workspace-check"
import type { SlackTarget } from "./state"

export const CHECK_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const IMAGE = /^sha256:[0-9a-f]{64}$/
export interface WorkspaceCheckCollectorClaimRequest { collectorID: string; claimRequestID: string; imageID: string }
export interface WorkspaceCheckCollectorClaim extends WorkspaceCheckCollectorClaimRequest {
  attemptID: string
  conversationKey: string
  workspaceCheck: WorkspaceCheckIntent
}
export interface WorkspaceCheckCollectorCompletion { collectorID: string; claimRequestID: string; attemptID: string; receipt: WorkspaceCheckLocalReceipt; logs: { stdoutBase64: string; stderrBase64: string } }
export interface WorkspaceCheckExecution {
  schemaVersion: 1
  requestID: string
  status: "queued" | "claimed" | "completed"
  queuedAt: number
  target: SlackTarget | null
  attempt: { attemptID: string; collectorID: string; claimRequestID: string; claimedAt: number } | null
  receipt: WorkspaceCheckLocalReceipt | null
  completedAt: number | null
  completionSHA256: string | null
  cleanupReconciledAt: number | null
  logs: { key: string; sha256: string } | null
  notification: { status: "not_requested" | "pending" | "delivered"; attempts: number; nextAttemptAt: number }
}
export class WorkspaceCheckDispatchError extends Error {
  constructor() { super("Check collector metadata is invalid."); this.name = "WorkspaceCheckDispatchError" }
}
function fields(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceCheckDispatchError()
  const body = value as Record<string, unknown>
  if (Object.keys(body).length !== keys.length || keys.some(key => !Object.hasOwn(body, key))) throw new WorkspaceCheckDispatchError()
  return body
}
function id(value: unknown): string { if (typeof value !== "string" || !CHECK_UUID.test(value)) throw new WorkspaceCheckDispatchError(); return value }
export function parseWorkspaceCheckCollectorClaimRequest(value: unknown): WorkspaceCheckCollectorClaimRequest {
  const body = fields(value, ["collectorID", "claimRequestID", "imageID"])
  if (typeof body.imageID !== "string" || !IMAGE.test(body.imageID)) throw new WorkspaceCheckDispatchError()
  return { collectorID: id(body.collectorID), claimRequestID: id(body.claimRequestID), imageID: body.imageID }
}
export function parseWorkspaceCheckCollectorClaim(value: unknown): WorkspaceCheckCollectorClaim {
  const body = fields(value, ["attemptID", "collectorID", "claimRequestID", "imageID", "conversationKey", "workspaceCheck"])
  const request = parseWorkspaceCheckCollectorClaimRequest({ collectorID: body.collectorID, claimRequestID: body.claimRequestID, imageID: body.imageID })
  const workspaceCheck = parseWorkspaceCheckIntent(body.workspaceCheck)
  if (workspaceCheck.status !== "exported" || workspaceCheck.imageID !== request.imageID || typeof body.conversationKey !== "string" || !/^[A-Za-z0-9:.\\_-]{1,256}$/.test(body.conversationKey)) throw new WorkspaceCheckDispatchError()
  return { ...request, attemptID: id(body.attemptID), conversationKey: body.conversationKey, workspaceCheck }
}
export function parseWorkspaceCheckCollectorCompletion(value: unknown): WorkspaceCheckCollectorCompletion {
  const body = fields(value, ["collectorID", "claimRequestID", "attemptID", "receipt", "logs"])
  const logs = fields(body.logs, ["stdoutBase64", "stderrBase64"])
  for (const value of Object.values(logs)) {
    if (typeof value !== "string" || value.length > 4 * Math.ceil(65536 / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) || btoa(atob(value)) !== value || atob(value).length > 65536) throw new WorkspaceCheckDispatchError()
  }
  return { collectorID: id(body.collectorID), claimRequestID: id(body.claimRequestID), attemptID: id(body.attemptID), receipt: parseWorkspaceCheckLocalReceipt(body.receipt), logs: { stdoutBase64: logs.stdoutBase64 as string, stderrBase64: logs.stderrBase64 as string } }
}
export function parseWorkspaceCheckExecution(value: unknown): WorkspaceCheckExecution {
  const body = fields(value, ["schemaVersion", "requestID", "status", "queuedAt", "target", "attempt", "receipt", "completedAt", "completionSHA256", "cleanupReconciledAt", "logs", "notification"])
  if (body.schemaVersion !== 1 || !["queued", "claimed", "completed"].includes(String(body.status)) || !Number.isSafeInteger(body.queuedAt) || (body.queuedAt as number) < 0) throw new WorkspaceCheckDispatchError()
  let target: SlackTarget | null = null
  if (body.target !== null) {
    const raw = body.target as Record<string, unknown>
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => key !== "channel" && key !== "replyTs") || typeof raw.channel !== "string" || !/^[A-Z0-9]{1,64}$/.test(raw.channel) || (raw.replyTs !== undefined && (typeof raw.replyTs !== "string" || !/^[0-9]+\.[0-9]+$/.test(raw.replyTs)))) throw new WorkspaceCheckDispatchError()
    target = { channel: raw.channel, ...(raw.replyTs ? { replyTs: raw.replyTs as string } : {}) }
  }
  let attempt: WorkspaceCheckExecution["attempt"] = null
  if (body.attempt !== null) {
    const raw = fields(body.attempt, ["attemptID", "collectorID", "claimRequestID", "claimedAt"])
    if (!Number.isSafeInteger(raw.claimedAt) || (raw.claimedAt as number) < 0) throw new WorkspaceCheckDispatchError()
    attempt = { attemptID: id(raw.attemptID), collectorID: id(raw.collectorID), claimRequestID: id(raw.claimRequestID), claimedAt: raw.claimedAt as number }
  }
  const receipt = body.receipt === null ? null : parseWorkspaceCheckLocalReceipt(body.receipt)
  let logs: WorkspaceCheckExecution["logs"] = null
  if (body.logs !== null) {
    const raw = fields(body.logs, ["key", "sha256"])
    if (typeof raw.key !== "string" || raw.key.length > 512 || typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.sha256)) throw new WorkspaceCheckDispatchError()
    logs = { key: raw.key, sha256: raw.sha256 }
  }
  const note = fields(body.notification, ["status", "attempts", "nextAttemptAt"])
  if (!["not_requested", "pending", "delivered"].includes(String(note.status)) || !Number.isSafeInteger(note.attempts) || (note.attempts as number) < 0 || (note.attempts as number) > 32 || !Number.isSafeInteger(note.nextAttemptAt) || (note.nextAttemptAt as number) < 0 ||
    (body.status === "queued" && (attempt || receipt || body.cleanupReconciledAt !== null)) || (body.status === "claimed" && (!attempt || receipt)) || (body.status === "completed" && (!attempt || !receipt)) ||
    (receipt && receipt.request.requestID !== body.requestID) || (!target && note.status !== "not_requested") || (note.status === "pending" && body.status !== "completed") ||
    (body.status !== "completed" && (body.completedAt !== null || body.completionSHA256 !== null || logs !== null)) ||
    (body.status === "completed" && (!Number.isSafeInteger(body.completedAt) || (body.completedAt as number) < (body.queuedAt as number) || typeof body.completionSHA256 !== "string" || !/^[a-f0-9]{64}$/.test(body.completionSHA256) || !logs)) ||
    (body.cleanupReconciledAt !== null && (!Number.isSafeInteger(body.cleanupReconciledAt) || (body.cleanupReconciledAt as number) < (body.queuedAt as number)))) throw new WorkspaceCheckDispatchError()
  return { schemaVersion: 1, requestID: id(body.requestID), status: body.status as WorkspaceCheckExecution["status"], queuedAt: body.queuedAt as number, target, attempt, receipt, logs,
    completedAt: body.completedAt as number | null, completionSHA256: body.completionSHA256 as string | null,
    cleanupReconciledAt: body.cleanupReconciledAt as number | null,
    notification: { status: note.status as WorkspaceCheckExecution["notification"]["status"], attempts: note.attempts as number, nextAttemptAt: note.nextAttemptAt as number } }
}
