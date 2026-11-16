import { randomUUID } from "node:crypto"
import { realpath } from "node:fs/promises"
import { executeRepositoryAction } from "./workspace-repository"
import { parseWorkspaceRepositoryReceipt, type WorkspaceRepositoryReceipt } from "./src/workspace-repository"
import {
  verifyWorkspaceCheckSnapshot, workspaceCheckTreeEntries, WORKSPACE_CHECK_SNAPSHOT_LIMITS as limits,
  WorkspaceCheckSnapshotError, type WorkspaceCheckSnapshot, type WorkspaceCheckGitObject, type VerifiedWorkspaceCheckSnapshot,
} from "./src/workspace-check-snapshot"

const failure = () => new WorkspaceCheckSnapshotError()
const environment = {
  PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", LANG: "C",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0",
  GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "", GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null",
}
export interface WorkspaceCheckHead {
  workspaceRepository: WorkspaceRepositoryReceipt
  commit: string
  tree: string
  mode: "committed_only"
  worktreeChanges: "unverified"
}
type Input = { mode: "snapshot" | "head"; workspace: string; workspaceRepository: WorkspaceRepositoryReceipt; commit?: string }
const validOID = (value: unknown, length?: number): value is string => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) && (!length || value.length === length)
const sameReceipt = (left: WorkspaceRepositoryReceipt, right: WorkspaceRepositoryReceipt) => JSON.stringify(left) === JSON.stringify(right)

function gitCommand(root: string, args: string[]): string[] {
  return ["git", "--no-pager", "--no-optional-locks", `--git-dir=${root}/.git`, `--work-tree=${root}`,
    "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", "-c", "credential.helper=", ...args]
}
async function waitExit(exited: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (!await Promise.race([exited.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2_000) })])) throw failure()
  } finally { if (timer) clearTimeout(timer) }
}
async function metadata(root: string, args: string[]): Promise<string> {
  const child = Bun.spawn(gitCommand(root, args), { cwd: root, env: environment, stdin: "ignore", stdout: "pipe", stderr: "ignore" })
  const reader = child.stdout.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const read = async () => {
      let bytes = 0, value = ""
      const decoder = new TextDecoder()
      for (;;) { const part = await reader.read(); if (part.done) return value.trim(); bytes += part.value.byteLength; if (bytes > 1024) throw failure(); value += decoder.decode(part.value, { stream: true }) }
    }
    const [code, value] = await Promise.race([
      Promise.all([child.exited, read()]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(failure()), 5_000) }),
    ])
    if (code !== 0) throw failure()
    return value
  } finally {
    if (timer) clearTimeout(timer)
    if (child.exitCode === null) child.kill("SIGKILL")
    void reader.cancel().catch(() => {})
    await waitExit(child.exited)
  }
}

/** Agent-side metadata only: no checkout, status, filters, restore or publication. */
export async function readWorkspaceCheckHead(workspace: string, value: unknown): Promise<WorkspaceCheckHead> {
  const workspaceRepository = parseWorkspaceRepositoryReceipt(value)
  const root = await realpath(workspace)
  await executeRepositoryAction({ action: "verify", workspace: root, staging: `/tmp/aboiteau-bound-${randomUUID()}`, binding: workspaceRepository })
  const commit = await metadata(root, ["rev-parse", "--verify", "HEAD"])
  const tree = await metadata(root, ["rev-parse", "--verify", `${commit}^{tree}`])
  if (!validOID(commit, workspaceRepository.baseCommit.length) || !validOID(tree, commit.length) || await metadata(root, ["rev-parse", "--verify", "HEAD"]) !== commit) throw failure()
  return { workspaceRepository, commit, tree, mode: "committed_only", worktreeChanges: "unverified" }
}

/** Fetch reachable objects by full OID; attributes and working-tree bytes are irrelevant. */
export async function readWorkspaceCheckSnapshot(workspace: string, value: unknown, expectedCommit: string): Promise<WorkspaceCheckSnapshot> {
  const before = await readWorkspaceCheckHead(workspace, value)
  if (!validOID(expectedCommit, before.commit.length) || before.commit !== expectedCommit) throw failure()
  const root = await realpath(workspace)
  const child = Bun.spawn(gitCommand(root, ["cat-file", "--batch"]), { cwd: root, env: environment, stdin: "pipe", stdout: "pipe", stderr: "ignore" })
  const reader = child.stdout.getReader()
  let buffer = new Uint8Array(0), total = 0
  const objects: WorkspaceCheckGitObject[] = [], seen = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const fill = async (count: number) => {
    while (buffer.length < count) {
      const part = await reader.read()
      if (part.done || buffer.length + part.value.byteLength > limits.objectBytes + 1024) throw failure()
      const next = new Uint8Array(buffer.length + part.value.byteLength)
      next.set(buffer); next.set(part.value, buffer.length); buffer = next
    }
  }
  const object = async (id: string, type: WorkspaceCheckGitObject["type"]): Promise<Uint8Array> => {
    if (!validOID(id, before.commit.length) || seen.has(id) || objects.length >= limits.objects) throw failure()
    child.stdin.write(`${id}\n`); await child.stdin.flush()
    let end = buffer.indexOf(10)
    while (end < 0) { if (buffer.length > 160) throw failure(); await fill(buffer.length + 1); end = buffer.indexOf(10) }
    const header = new TextDecoder().decode(buffer.subarray(0, end))
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) (commit|tree|blob) ([0-9]{1,10})$/.exec(header)
    if (!match || match[1] !== id || match[2] !== type) throw failure()
    const size = Number(match[3])
    if (size > limits.objectBytes || (total += size) > limits.totalBytes) throw failure()
    buffer = buffer.slice(end + 1)
    await fill(size + 1)
    if (buffer[size] !== 10) throw failure()
    const data = buffer.slice(0, size); buffer = buffer.slice(size + 1)
    seen.add(id); objects.push({ oid: id, type, contentBase64: Buffer.from(data).toString("base64") })
    return data
  }
  const walk = async (id: string, depth: number) => {
    if (depth > limits.depth) throw failure()
    if (seen.has(id)) return
    const data = await object(id, "tree")
    for (const entry of workspaceCheckTreeEntries(data, before.commit.length)) {
      if (entry.mode === "40000") await walk(entry.oid, depth + 1)
      else if (!seen.has(entry.oid)) await object(entry.oid, "blob")
    }
  }
  try {
    const collect = async () => {
      await object(before.commit, "commit")
      await walk(before.tree, 0)
      child.stdin.end()
      if (await child.exited !== 0 || buffer.length !== 0) throw failure()
      const after = await readWorkspaceCheckHead(workspace, value)
      if (after.commit !== before.commit || after.tree !== before.tree) throw failure()
      const graph: WorkspaceCheckSnapshot = { schemaVersion: 1, ...before, objects }
      const verified = await verifyWorkspaceCheckSnapshot(graph)
      return { schemaVersion: 1 as const, mode: verified.mode, worktreeChanges: verified.worktreeChanges, workspaceRepository: verified.workspaceRepository, commit: verified.commit, tree: verified.tree, objects: verified.objects }
    }
    return await Promise.race([collect(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(failure()), 20_000) })])
  } finally {
    if (timer) clearTimeout(timer)
    if (child.exitCode === null) child.kill("SIGKILL")
    void reader.cancel().catch(() => {})
    await waitExit(child.exited)
  }
}

/** Trusted parent wrapper: never accepts a helper's self-asserted digest. */
export async function invokeWorkspaceCheckSnapshot(input: Input, agentCommand: (args: string[]) => string[]): Promise<VerifiedWorkspaceCheckSnapshot | WorkspaceCheckHead> {
  const receipt = parseWorkspaceRepositoryReceipt(input.workspaceRepository)
  const child = Bun.spawn(agentCommand([process.execPath, import.meta.path, "--agent-read"]), {
    cwd: import.meta.dir, env: environment, stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "ignore", detached: true,
  })
  const reader = child.stdout.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const read = async () => {
      let bytes = 0, value = ""
      const decoder = new TextDecoder()
      for (;;) { const part = await reader.read(); if (part.done) return value; bytes += part.value.byteLength; if (bytes > limits.wireBytes) throw failure(); value += decoder.decode(part.value, { stream: true }) }
    }
    const [code, text] = await Promise.race([
      Promise.all([child.exited, read()]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(failure()), 30_000) }),
    ])
    if (code !== 0) throw failure()
    const raw: unknown = JSON.parse(text)
    if (input.mode === "snapshot") {
      const result = await verifyWorkspaceCheckSnapshot(raw)
      if (!sameReceipt(result.workspaceRepository, receipt) || result.commit !== input.commit) throw failure()
      return result
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).sort().join(",") !== "commit,mode,tree,workspaceRepository,worktreeChanges" || !("workspaceRepository" in raw) || !("commit" in raw) || !("tree" in raw) || !("mode" in raw) || !("worktreeChanges" in raw)) throw failure()
    const bound = parseWorkspaceRepositoryReceipt(raw.workspaceRepository)
    if (!sameReceipt(bound, receipt) || !validOID(raw.commit, receipt.baseCommit.length) || !validOID(raw.tree, raw.commit.length) || raw.mode !== "committed_only" || raw.worktreeChanges !== "unverified") throw failure()
    return { workspaceRepository: bound, commit: raw.commit, tree: raw.tree, mode: "committed_only", worktreeChanges: "unverified" }
  } finally {
    if (timer) clearTimeout(timer)
    try { process.kill(-child.pid, "SIGKILL") } catch { if (child.exitCode === null) child.kill("SIGKILL") }
    void reader.cancel().catch(() => {})
    await waitExit(child.exited)
  }
}

if (import.meta.main && process.argv[2] === "--agent-read") {
  try {
    const reader = Bun.stdin.stream().getReader(), decoder = new TextDecoder()
    let input = "", size = 0
    try { for (;;) { const part = await reader.read(); if (part.done) break; if ((size += part.value.byteLength) > 4096) throw failure(); input += decoder.decode(part.value, { stream: true }) } }
    finally { void reader.cancel().catch(() => {}) }
    const request: Input = JSON.parse(input)
    const result = request.mode === "snapshot" ? await readWorkspaceCheckSnapshot(request.workspace, request.workspaceRepository, request.commit ?? "") : request.mode === "head" ? await readWorkspaceCheckHead(request.workspace, request.workspaceRepository) : null
    if (!result) throw failure()
    const output = JSON.stringify(result)
    if (Buffer.byteLength(output) > limits.wireBytes) throw failure()
    process.stdout.write(output)
  } catch { process.exitCode = 1 }
}
