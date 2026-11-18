import { logEvent } from "./log"

/** Immutable, credential-free identity for the opt-in workspace binding workflow. */
export interface WorkspaceRepositorySelection {
  repository: string
  baseBranch: string
  workingBranch: string
}

export interface WorkspaceRepositoryBinding extends WorkspaceRepositorySelection {
  schemaVersion: 1
  bindingID: string
  status: "pending" | "bound"
  baseCommit: string | null
}

export interface WorkspaceRepositoryReceipt extends WorkspaceRepositoryBinding {
  status: "bound"
  baseCommit: string
}

export class WorkspaceRepositoryValidationError extends Error {
  readonly code = "INVALID_WORKSPACE_REPOSITORY"
  constructor() {
    super("Workspace repository metadata is invalid or unsupported.")
    this.name = "WorkspaceRepositoryValidationError"
  }
}

export class WorkspaceRepositoryConflictError extends Error {
  readonly code = "WORKSPACE_REPOSITORY_CONFLICT"
  /** Bounded operator-facing reason from the Git action, when one exists. */
  constructor(readonly detail?: string) {
    super("Workspace repository binding conflicts with existing workspace state.")
    this.name = "WorkspaceRepositoryConflictError"
  }
}

/** The reason a binding action failed, if the error carries one. */
export function repositoryConflictDetail(error: unknown): string | undefined {
  return error instanceof WorkspaceRepositoryConflictError ? error.detail : undefined
}

/** Read a binding-conflict response into the typed error, keeping its reason. */
export async function repositoryConflictFrom(response: Response): Promise<WorkspaceRepositoryConflictError> {
  const body = await response.json().catch(() => undefined) as { detail?: unknown; error?: unknown; timings?: unknown } | undefined
  const detail = typeof body?.detail === "string" ? body.detail.slice(0, 600) : undefined
  // The container's timings say how far the start got; a bare conflict names
  // no reason, so record what it did report.
  logEvent("repository.start.failed", { status: response.status, error: body?.error ?? null, detail: detail ?? null, timings: body?.timings ?? null })
  return new WorkspaceRepositoryConflictError(detail)
}

const selectionFields = ["repository", "baseBranch", "workingBranch"]
const bindingFields = [...selectionFields, "schemaVersion", "bindingID", "status", "baseCommit"]
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const commit = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

function fields(value: unknown, expected: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceRepositoryValidationError()
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== expected.length || expected.some(key => !Object.hasOwn(record, key))) {
    throw new WorkspaceRepositoryValidationError()
  }
  return record
}

function branch(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) ||
    /^refs\//i.test(value) || /^HEAD$/i.test(value) || value.includes("..") || value.endsWith(".") ||
    value.split("/").some(part => !part || part.startsWith(".") || /\.lock$/i.test(part))) {
    throw new WorkspaceRepositoryValidationError()
  }
  return value
}

function repository(value: unknown): string {
  if (typeof value !== "string" || value.length > 256) throw new WorkspaceRepositoryValidationError()
  const match = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]{1,104})\/?$/i.exec(value)
  if (!match || match[1].includes("--")) throw new WorkspaceRepositoryValidationError()
  const name = match[2].replace(/\.git$/i, "")
  if (!name || name === "." || name === ".." || name.length > 100 || name.endsWith(".") || /\.git$/i.test(name)) throw new WorkspaceRepositoryValidationError()
  return `https://github.com/${match[1].toLowerCase()}/${name.toLowerCase()}`
}

export function parseWorkspaceRepositorySelection(value: unknown): WorkspaceRepositorySelection {
  const record = fields(value, selectionFields)
  const selection = { repository: repository(record.repository), baseBranch: branch(record.baseBranch), workingBranch: branch(record.workingBranch) }
  if (selection.baseBranch.toLowerCase() === selection.workingBranch.toLowerCase()) throw new WorkspaceRepositoryValidationError()
  return selection
}

export function sameWorkspaceRepositorySelection(left: WorkspaceRepositorySelection, right: WorkspaceRepositorySelection): boolean {
  return left.repository === right.repository && left.baseBranch === right.baseBranch && left.workingBranch === right.workingBranch
}

/** Persisted bindings and control receipts must already carry canonical identity. */
export function parseWorkspaceRepositoryBinding(value: unknown): WorkspaceRepositoryBinding {
  const record = fields(value, bindingFields)
  const selection = parseWorkspaceRepositorySelection(Object.fromEntries(selectionFields.map(key => [key, record[key]])))
  if (record.schemaVersion !== 1 || typeof record.bindingID !== "string" || !uuid.test(record.bindingID) ||
    record.repository !== selection.repository ||
    (record.status !== "pending" && record.status !== "bound") ||
    (record.status === "pending" ? record.baseCommit !== null : typeof record.baseCommit !== "string" || !commit.test(record.baseCommit))) {
    throw new WorkspaceRepositoryValidationError()
  }
  return { ...selection, schemaVersion: 1, bindingID: record.bindingID, status: record.status, baseCommit: record.baseCommit as string | null }
}

export function parseWorkspaceRepositoryReceipt(value: unknown): WorkspaceRepositoryReceipt {
  const binding = parseWorkspaceRepositoryBinding(value)
  if (binding.status !== "bound" || binding.baseCommit === null) throw new WorkspaceRepositoryValidationError()
  return { ...binding, status: "bound", baseCommit: binding.baseCommit }
}
