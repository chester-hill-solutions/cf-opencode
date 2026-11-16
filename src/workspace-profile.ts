export interface WorkspaceProfile {
  schemaVersion: 1
  profileID: string
  revision: number
  retention: "persistent" | "disposable"
  name: string | null
  status: "active" | "discarding"
}
export interface WorkspaceDiscardRecord {
  schemaVersion: 1
  requestID: string
  expectedProfileID: string
  expectedRevision: number
  status: "prepared" | "pending" | "complete"
  createdAt: number
  completedAt: number | null
}
export const WORKSPACE_DISCARD_ALIAS_PREFIX = "workspaceLifecycle:discardAlias:"
export interface WorkspaceDiscardAliasRecord extends WorkspaceDiscardRecord { canonicalRequestID: string }
export const WORKSPACE_PROFILE_KEY = "workspaceLifecycle:profile"
export const WORKSPACE_DISCARD_PREFIX = "workspaceLifecycle:discard:"
export const WORKSPACE_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid workspace metadata")
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).sort().join(",") !== keys.sort().join(",")) throw new Error("Invalid workspace metadata")
  return raw
}
export function parseWorkspaceProfile(value: unknown): WorkspaceProfile {
  const raw = object(value, ["schemaVersion", "profileID", "revision", "retention", "name", "status"])
  if (raw.schemaVersion !== 1 || typeof raw.profileID !== "string" || !WORKSPACE_UUID.test(raw.profileID) || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 1 ||
    (raw.retention !== "persistent" && raw.retention !== "disposable") || (raw.status !== "active" && raw.status !== "discarding") ||
    (raw.name !== null && (typeof raw.name !== "string" || !raw.name.trim() || raw.name !== raw.name.trim() || raw.name.length > 80 || /[\u0000-\u001f\u007f]/.test(raw.name)))) throw new Error("Invalid workspace profile")
  return { schemaVersion: 1, profileID: raw.profileID, revision: raw.revision as number, retention: raw.retention, name: raw.name as string | null, status: raw.status }
}
export function parseWorkspaceDiscardRecord(value: unknown): WorkspaceDiscardRecord {
  const raw = object(value, ["schemaVersion", "requestID", "expectedProfileID", "expectedRevision", "status", "createdAt", "completedAt"])
  if (raw.schemaVersion !== 1 || typeof raw.requestID !== "string" || !WORKSPACE_UUID.test(raw.requestID) || typeof raw.expectedProfileID !== "string" || !WORKSPACE_UUID.test(raw.expectedProfileID) ||
    !Number.isSafeInteger(raw.expectedRevision) || (raw.expectedRevision as number) < 1 || (raw.status !== "prepared" && raw.status !== "pending" && raw.status !== "complete") || !Number.isSafeInteger(raw.createdAt) || (raw.createdAt as number) < 0 ||
    (raw.status !== "complete" ? raw.completedAt !== null : !Number.isSafeInteger(raw.completedAt) || (raw.completedAt as number) < (raw.createdAt as number))) throw new Error("Invalid workspace discard")
  return { schemaVersion: 1, requestID: raw.requestID, expectedProfileID: raw.expectedProfileID, expectedRevision: raw.expectedRevision as number, status: raw.status, createdAt: raw.createdAt as number, completedAt: raw.completedAt as number | null }
}
export function parseWorkspaceDiscardAlias(value: unknown): WorkspaceDiscardAliasRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid workspace discard alias")
  const raw = value as Record<string, unknown>, { canonicalRequestID, ...record } = raw
  if (typeof canonicalRequestID !== "string" || !WORKSPACE_UUID.test(canonicalRequestID)) throw new Error("Invalid workspace discard alias")
  return { ...parseWorkspaceDiscardRecord(record), canonicalRequestID }
}
/** Validated preferences, inert requests and retained control identities do not imply runtime history. */
export function isWorkspaceLifecycleMetadata(key: string, value: unknown): boolean {
  try {
    if (key.startsWith(WORKSPACE_CONTROL_EVENT_PREFIX)) return workspaceControlEventKey(parseWorkspaceControlEvent(value).eventID) === key
    if (key === WORKSPACE_PROFILE_KEY) return parseWorkspaceProfile(value).status === "active"
    if (key.startsWith(WORKSPACE_DISCARD_ALIAS_PREFIX)) {
      const record = parseWorkspaceDiscardAlias(value)
      return key === WORKSPACE_DISCARD_ALIAS_PREFIX + record.requestID && record.status !== "pending"
    }
    if (key.startsWith(WORKSPACE_DISCARD_PREFIX)) {
      const record = parseWorkspaceDiscardRecord(value)
      return key === WORKSPACE_DISCARD_PREFIX + record.requestID && record.status !== "pending"
    }
  } catch {}
  return false
}

export const WORKSPACE_CONTROL_EVENT_PREFIX = "workspaceLifecycle:controlEvent:"
export interface WorkspaceControlEvent { schemaVersion: 1; eventID: string; at: number }
export function workspaceControlEventKey(eventID: string): string {
  if (!eventID || eventID.length > 256 || /[\u0000-\u0020\u007f]/.test(eventID)) throw new Error("Invalid workspace event identity")
  return WORKSPACE_CONTROL_EVENT_PREFIX + encodeURIComponent(eventID)
}
export function parseWorkspaceControlEvent(value: unknown): WorkspaceControlEvent {
  const raw = object(value, ["schemaVersion", "eventID", "at"])
  if (raw.schemaVersion !== 1 || typeof raw.eventID !== "string" || !Number.isSafeInteger(raw.at) || (raw.at as number) < 0) throw new Error("Invalid workspace event")
  workspaceControlEventKey(raw.eventID)
  return { schemaVersion: 1, eventID: raw.eventID, at: raw.at as number }
}
