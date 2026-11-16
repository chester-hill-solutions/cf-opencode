import { parseWorkspaceRepositoryReceipt, type WorkspaceRepositoryReceipt } from "./workspace-repository"

export const WORKSPACE_CHECK_SNAPSHOT_LIMITS = {
  objects: 4096, files: 2048, objectBytes: 2 * 1024 * 1024,
  totalBytes: 4 * 1024 * 1024, wireBytes: 8 * 1024 * 1024, depth: 32, pathBytes: 240,
} as const

export interface WorkspaceCheckGitObject { oid: string; type: "commit" | "tree" | "blob"; contentBase64: string }
export interface WorkspaceCheckSnapshot {
  schemaVersion: 1
  mode: "committed_only"
  worktreeChanges: "unverified"
  workspaceRepository: WorkspaceRepositoryReceipt
  commit: string
  tree: string
  objects: WorkspaceCheckGitObject[]
}
export interface WorkspaceCheckCodeFile { path: string; mode: "100644" | "100755"; contentBase64: string }
export interface VerifiedWorkspaceCheckSnapshot extends WorkspaceCheckSnapshot {
  files: WorkspaceCheckCodeFile[]
  canonicalJSON: string
  snapshotSHA256: string
}

export class WorkspaceCheckSnapshotError extends Error {
  readonly code = "INVALID_WORKSPACE_CHECK_SNAPSHOT"
  constructor() { super("Committed workspace snapshot is invalid, unsupported or exceeds inspection limits."); this.name = "WorkspaceCheckSnapshotError" }
}
function invalid(): never { throw new WorkspaceCheckSnapshotError() }
const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("")
const oid = (value: unknown, length?: number): string => {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value) || (length && value.length !== length)) invalid()
  return value
}
function fields(value: unknown, names: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid()
  const result = value as Record<string, unknown>
  if (Object.keys(result).length !== names.length || names.some(name => !Object.hasOwn(result, name))) invalid()
  return result
}
function bytes(value: unknown): { text: string; data: Uint8Array } {
  if (typeof value !== "string" || value.length > 4 * Math.ceil(WORKSPACE_CHECK_SNAPSHOT_LIMITS.objectBytes / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) invalid()
  const decoded = atob(value)
  if (btoa(decoded) !== value || decoded.length > WORKSPACE_CHECK_SNAPSHOT_LIMITS.objectBytes) invalid()
  return { text: value, data: Uint8Array.from(decoded, char => char.charCodeAt(0)) }
}
export async function workspaceCheckObjectOID(type: WorkspaceCheckGitObject["type"], content: Uint8Array, algorithm: "SHA-1" | "SHA-256"): Promise<string> {
  const header = encoder.encode(`${type} ${content.byteLength}\0`)
  const input = new Uint8Array(header.length + content.byteLength)
  input.set(header); input.set(content, header.length)
  return hex(await crypto.subtle.digest(algorithm, input))
}

/** Raw tree framing shared by the bounded reader and complete graph verifier. */
export function workspaceCheckTreeEntries(data: Uint8Array, oidLength: number): Array<{ mode: "40000" | "100644" | "100755"; name: string; oid: string }> {
  if (oidLength !== 40 && oidLength !== 64) invalid()
  const result: Array<{ mode: "40000" | "100644" | "100755"; name: string; oid: string }> = []
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(32, offset), end = data.indexOf(0, space + 1)
    if (space < offset || end < space || end + 1 + oidLength / 2 > data.length) invalid()
    const mode = decoder.decode(data.subarray(offset, space)), name = decoder.decode(data.subarray(space + 1, end))
    if ((mode !== "40000" && mode !== "100644" && mode !== "100755") || !name || name === "." || name === ".." || /[\x00-\x1f\x7f\\/:]/.test(name) || name.toLowerCase() === ".git") invalid()
    result.push({ mode, name, oid: hex(data.subarray(end + 1, end + 1 + oidLength / 2)) })
    if (result.length > WORKSPACE_CHECK_SNAPSHOT_LIMITS.objects + WORKSPACE_CHECK_SNAPSHOT_LIMITS.files) invalid()
    offset = end + 1 + oidLength / 2
  }
  return result
}

/** Validate the entire raw object graph; no Git/worktree interpretation occurs. */
export async function verifyWorkspaceCheckSnapshot(value: unknown): Promise<VerifiedWorkspaceCheckSnapshot> {
  const body = fields(value, ["schemaVersion", "mode", "worktreeChanges", "workspaceRepository", "commit", "tree", "objects"])
  if (body.schemaVersion !== 1 || body.mode !== "committed_only" || body.worktreeChanges !== "unverified") invalid()
  const workspaceRepository = parseWorkspaceRepositoryReceipt(body.workspaceRepository)
  const commit = oid(body.commit), tree = oid(body.tree, commit.length)
  if (workspaceRepository.baseCommit.length !== commit.length || !Array.isArray(body.objects) || body.objects.length < 2 || body.objects.length > WORKSPACE_CHECK_SNAPSHOT_LIMITS.objects) invalid()
  const objects: WorkspaceCheckGitObject[] = []
  const graph = new Map<string, { object: WorkspaceCheckGitObject; data: Uint8Array }>()
  let total = 0
  for (const item of body.objects) {
    const entry = fields(item, ["oid", "type", "contentBase64"])
    const id = oid(entry.oid, commit.length)
    if (entry.type !== "commit" && entry.type !== "tree" && entry.type !== "blob") invalid()
    const content = bytes(entry.contentBase64)
    total += content.data.byteLength
    if (total > WORKSPACE_CHECK_SNAPSHOT_LIMITS.totalBytes || graph.has(id)) invalid()
    const object: WorkspaceCheckGitObject = { oid: id, type: entry.type, contentBase64: content.text }
    if (await workspaceCheckObjectOID(object.type, content.data, commit.length === 40 ? "SHA-1" : "SHA-256") !== id) invalid()
    graph.set(id, { object, data: content.data }); objects.push(object)
  }
  const selected = graph.get(commit)
  if (!selected || selected.object.type !== "commit") invalid()
  const lineEnd = selected.data.indexOf(10)
  if (lineEnd < 0 || decoder.decode(selected.data.subarray(0, lineEnd)) !== `tree ${tree}`) invalid()
  const used = new Set([commit]), paths = new Set<string>(), active = new Set<string>()
  const files: WorkspaceCheckCodeFile[] = []
  let entries = 0, expandedBytes = 0
  const walk = (id: string, prefix: string, depth: number) => {
    if (depth > WORKSPACE_CHECK_SNAPSHOT_LIMITS.depth || active.has(id)) invalid()
    const node = graph.get(id)
    if (!node || node.object.type !== "tree") invalid()
    used.add(id); active.add(id)
    for (const entry of workspaceCheckTreeEntries(node.data, commit.length)) {
      if (++entries > WORKSPACE_CHECK_SNAPSHOT_LIMITS.objects + WORKSPACE_CHECK_SNAPSHOT_LIMITS.files) invalid()
      const { mode, name, oid: childOID } = entry
      const path = prefix ? `${prefix}/${name}` : name
      if ((!prefix && name.toLowerCase() === ".stow") || encoder.encode(path).length > WORKSPACE_CHECK_SNAPSHOT_LIMITS.pathBytes || paths.has(path)) invalid()
      paths.add(path)
      if (mode === "40000") walk(childOID, path, depth + 1)
      else {
        const child = graph.get(childOID)
        if (!child || child.object.type !== "blob" || files.length >= WORKSPACE_CHECK_SNAPSHOT_LIMITS.files) invalid()
        expandedBytes += child.data.byteLength
        if (expandedBytes > WORKSPACE_CHECK_SNAPSHOT_LIMITS.totalBytes) invalid()
        used.add(childOID)
        files.push({ path, mode, contentBase64: child.object.contentBase64 })
      }
    }
    active.delete(id)
  }
  walk(tree, "", 0)
  if (used.size !== graph.size) invalid()
  objects.sort((left, right) => left.oid < right.oid ? -1 : left.oid > right.oid ? 1 : 0)
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  const snapshot: WorkspaceCheckSnapshot = { schemaVersion: 1, mode: "committed_only", worktreeChanges: "unverified", workspaceRepository, commit, tree, objects }
  const canonicalJSON = JSON.stringify(snapshot)
  if (encoder.encode(canonicalJSON).byteLength > WORKSPACE_CHECK_SNAPSHOT_LIMITS.wireBytes) invalid()
  const snapshotSHA256 = hex(await crypto.subtle.digest("SHA-256", encoder.encode(canonicalJSON)))
  return { ...snapshot, files, canonicalJSON, snapshotSHA256 }
}
