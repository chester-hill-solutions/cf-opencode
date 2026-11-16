import { parseWorkspaceRepositoryReceipt, type WorkspaceRepositoryReceipt } from "./workspace-repository"

/** Requested execution is immutable. Server records never claim that it ran. */
export interface WorkspaceCheckRequest {
  requestID: string
  expectedBindingID: string
  commitOID: string
  argv: string[]
  imageID: string
  timeoutMs: number
}

export interface WorkspaceCheckIntent extends WorkspaceCheckRequest {
  schemaVersion: 1
  mode: "committed_only"
  binding: WorkspaceRepositoryReceipt
  status: "requested" | "exported"
  checksNotRun: true
  createdAt: number
  source: { treeOID: string; sourceSHA256: string } | null
  worktreeChanges: "unverified"
}

export interface WorkspaceCheckLog {
  sha256: string
  bytes: number
  capturedBytes: number
  truncated: boolean
}

export interface WorkspaceCheckLocalReceipt {
  schemaVersion: 1
  mode: "committed_only"
  provenance: "local_operator"
  request: WorkspaceCheckRequest
  binding: WorkspaceRepositoryReceipt
  treeOID: string
  sourceSHA256: string
  platform: string
  startedAt: number
  finishedAt: number
  outcome: "passed" | "failed" | "timeout" | "oom" | "collector_error" | "not_run" | "cleanup_unknown"
  exitCode: number | null
  cleanupConfirmed: boolean
  freshness: { before: "matched" | "stale" | "unknown"; after: "matched" | "stale" | "unknown" }
  worktreeChanges: "unverified"
  baselineChecks: "not_run"
  testOrConfigChanges: "not_evaluated"
  logs: { stdout: WorkspaceCheckLog; stderr: WorkspaceCheckLog }
}

export class WorkspaceCheckValidationError extends Error {
  readonly code = "INVALID_WORKSPACE_CHECK"
  constructor() { super("Workspace check metadata is invalid or unsupported."); this.name = "WorkspaceCheckValidationError" }
}

const requestKeys = ["requestID", "expectedBindingID", "commitOID", "argv", "imageID", "timeoutMs"]
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const digest = /^[0-9a-f]{64}$/
function invalid(): never { throw new WorkspaceCheckValidationError() }
function fields(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid()
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) return invalid()
  return record
}
function identifier(value: unknown, pattern: RegExp): string {
  return typeof value === "string" && pattern.test(value) ? value : invalid()
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : invalid()
}

export function parseWorkspaceCheckArgv(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 64) return invalid()
  let bytes = 0
  const argv = value.map(arg => {
    if (typeof arg !== "string" || arg.length > 2048 || /[\u0000-\u001f\u007f]/.test(arg)) return invalid()
    const encoded = new TextEncoder().encode(arg)
    if (new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(encoded) !== arg) return invalid()
    bytes += encoded.byteLength
    return arg
  })
  if (!argv[0] || argv[0].startsWith("-") || bytes > 8192) return invalid()
  return argv
}

export function parseWorkspaceCheckRequest(value: unknown): WorkspaceCheckRequest {
  const record = fields(value, requestKeys)
  const argv = parseWorkspaceCheckArgv(record.argv)
  const timeoutMs = integer(record.timeoutMs, 120000)
  if (!timeoutMs) return invalid()
  return {
    requestID: identifier(record.requestID, uuid), expectedBindingID: identifier(record.expectedBindingID, uuid),
    commitOID: identifier(record.commitOID, oid), argv, imageID: identifier(record.imageID, /^sha256:[0-9a-f]{64}$/), timeoutMs,
  }
}

export function parseWorkspaceCheckIntent(value: unknown): WorkspaceCheckIntent {
  const record = fields(value, [...requestKeys, "schemaVersion", "mode", "binding", "status", "checksNotRun", "createdAt", "source", "worktreeChanges"])
  const request = parseWorkspaceCheckRequest(Object.fromEntries(requestKeys.map(key => [key, record[key]])))
  const binding = parseWorkspaceRepositoryReceipt(record.binding)
  if (record.schemaVersion !== 1 || record.mode !== "committed_only" || binding.bindingID !== request.expectedBindingID || record.checksNotRun !== true || record.worktreeChanges !== "unverified" || !["requested", "exported"].includes(String(record.status))) return invalid()
  let source: WorkspaceCheckIntent["source"] = null
  if (record.status === "exported") {
    const raw = fields(record.source, ["treeOID", "sourceSHA256"])
    source = { treeOID: identifier(raw.treeOID, oid), sourceSHA256: identifier(raw.sourceSHA256, digest) }
    if (source.treeOID.length !== request.commitOID.length) return invalid()
  } else if (record.source !== null) return invalid()
  return { ...request, schemaVersion: 1, mode: "committed_only", binding, status: record.status === "requested" ? "requested" : "exported", checksNotRun: true, createdAt: integer(record.createdAt), source, worktreeChanges: "unverified" }
}

export function sameWorkspaceCheckRequest(left: WorkspaceCheckRequest, right: WorkspaceCheckRequest): boolean {
  const requestOnly = (value: WorkspaceCheckRequest) => Object.fromEntries(requestKeys.map(key => [key, value[key as keyof WorkspaceCheckRequest]]))
  return JSON.stringify(parseWorkspaceCheckRequest(requestOnly(left))) === JSON.stringify(parseWorkspaceCheckRequest(requestOnly(right)))
}

export async function workspaceCheckRequestSHA256(value: WorkspaceCheckRequest): Promise<string> {
  const request = Object.fromEntries(requestKeys.map(key => [key, value[key as keyof WorkspaceCheckRequest]]))
  const bytes = new TextEncoder().encode(JSON.stringify(parseWorkspaceCheckRequest(request)))
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("")
}

function log(value: unknown): WorkspaceCheckLog {
  const record = fields(value, ["sha256", "bytes", "capturedBytes", "truncated"])
  const bytes = integer(record.bytes), capturedBytes = integer(record.capturedBytes, 65536)
  if (capturedBytes > bytes || typeof record.truncated !== "boolean" || record.truncated !== (bytes > capturedBytes)) return invalid()
  return { sha256: identifier(record.sha256, digest), bytes, capturedBytes, truncated: record.truncated }
}

export function parseWorkspaceCheckLocalReceipt(value: unknown): WorkspaceCheckLocalReceipt {
  const record = fields(value, ["schemaVersion", "mode", "provenance", "request", "binding", "treeOID", "sourceSHA256", "platform", "startedAt", "finishedAt", "outcome", "exitCode", "cleanupConfirmed", "freshness", "worktreeChanges", "baselineChecks", "testOrConfigChanges", "logs"])
  const request = parseWorkspaceCheckRequest(record.request), binding = parseWorkspaceRepositoryReceipt(record.binding)
  const outcomes = ["passed", "failed", "timeout", "oom", "collector_error", "not_run", "cleanup_unknown"] as const
  const outcome = outcomes.find(candidate => candidate === record.outcome)
  const fresh = fields(record.freshness, ["before", "after"])
  const freshnessValue = (value: unknown): WorkspaceCheckLocalReceipt["freshness"]["before"] => value === "matched" || value === "stale" || value === "unknown" ? value : invalid()
  const freshness = { before: freshnessValue(fresh.before), after: freshnessValue(fresh.after) }
  const logs = fields(record.logs, ["stdout", "stderr"])
  const startedAt = integer(record.startedAt), finishedAt = integer(record.finishedAt)
  if (record.schemaVersion !== 1 || record.mode !== "committed_only" || record.provenance !== "local_operator" || binding.bindingID !== request.expectedBindingID || !outcome || record.worktreeChanges !== "unverified" || record.baselineChecks !== "not_run" || record.testOrConfigChanges !== "not_evaluated" || typeof record.cleanupConfirmed !== "boolean" || finishedAt < startedAt || typeof record.platform !== "string" || !/^[a-z0-9_]+\/[a-z0-9_]+$/.test(record.platform)) return invalid()
  const exitCode = record.exitCode === null ? null : integer(record.exitCode, 255)
  if (outcome === "passed" && (exitCode !== 0 || !record.cleanupConfirmed)) return invalid()
  if (!record.cleanupConfirmed && outcome !== "cleanup_unknown") return invalid()
  const treeOID = identifier(record.treeOID, oid)
  if (treeOID.length !== request.commitOID.length) return invalid()
  return { schemaVersion: 1, mode: "committed_only", provenance: "local_operator", request, binding, treeOID, sourceSHA256: identifier(record.sourceSHA256, digest), platform: record.platform, startedAt, finishedAt, outcome, exitCode, cleanupConfirmed: record.cleanupConfirmed, freshness, worktreeChanges: "unverified", baselineChecks: "not_run", testOrConfigChanges: "not_evaluated", logs: { stdout: log(logs.stdout), stderr: log(logs.stderr) } }
}
