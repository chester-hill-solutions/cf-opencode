import { createHash } from "node:crypto"
import { lstat, open, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseWorkspaceCheckLocalReceipt, parseWorkspaceCheckRequest, type WorkspaceCheckLocalReceipt, type WorkspaceCheckLog, type WorkspaceCheckRequest } from "../src/workspace-check"
import { type VerifiedWorkspaceCheckSnapshot } from "../src/workspace-check-snapshot"

export const CHECK_PROFILE = "committed-offline-v1"
export const CHECK_ENTRYPOINT = ["/usr/local/bin/bun", "--no-env-file", "--no-install", "--config=/opt/aboiteau-check/bunfig.toml", "/opt/aboiteau-check/runtime/check/bootstrap.ts"]
const CAPTURE_LIMIT = 65536
const OBSERVED_LIMIT = 1024 * 1024
export type Freshness = "matched" | "stale" | "unknown"
export interface DockerResult {
  exitCode: number | null
  timedOut: boolean
  outputExceeded: boolean
  stdout: Uint8Array
  stderr: Uint8Array
  stdoutBytes: number
  stderrBytes: number
}
export interface DockerOptions { timeoutMs: number; input?: string }
export type DockerRunner = (args: string[], options: DockerOptions) => Promise<DockerResult>
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
const text = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes)

/** Only Docker client configuration is inherited; no host variables enter Linux. */
export function boundedDockerRunner(command: readonly string[] = ["docker"]): DockerRunner {
  return async (args, options) => {
  const env: Record<string, string> = { PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin" }
  for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", "DOCKER_API_VERSION"]) {
    if (process.env[key]) env[key] = process.env[key]!
  }
  const child = Bun.spawn([...command, ...args], { env, detached: true, stdin: options.input === undefined ? "ignore" : new Blob([options.input]), stdout: "pipe", stderr: "pipe" })
  let timedOut = false, outputExceeded = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const readers: { cancel(reason?: unknown): Promise<void> }[] = []
  const stdout = { bytes: 0, captured: 0, chunks: [] as Uint8Array[] }, stderr = { bytes: 0, captured: 0, chunks: [] as Uint8Array[] }
  const killClient = () => {
    try { process.kill(-child.pid, "SIGKILL") } catch { try { child.kill("SIGKILL") } catch {} }
  }
  const collect = async (stream: ReadableStream<Uint8Array>, sink: typeof stdout) => {
    const reader = stream.getReader()
    readers.push(reader)
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        sink.bytes += part.value.byteLength
        if (sink.captured < CAPTURE_LIMIT) {
          const piece = part.value.subarray(0, CAPTURE_LIMIT - sink.captured)
          sink.chunks.push(piece); sink.captured += piece.byteLength
        }
        if (sink.bytes > OBSERVED_LIMIT) { outputExceeded = true; killClient(); break }
      }
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
  }
  const result = (exitCode: number | null): DockerResult => ({ exitCode, timedOut, outputExceeded, stdout: new Uint8Array(Buffer.concat(stdout.chunks)), stderr: new Uint8Array(Buffer.concat(stderr.chunks)), stdoutBytes: stdout.bytes, stderrBytes: stderr.bytes })
  try {
    const complete = Promise.all([child.exited, collect(child.stdout, stdout), collect(child.stderr, stderr)]).then(([exitCode]) => result(exitCode))
    return await Promise.race([complete, new Promise<DockerResult>(resolve => {
      timer = setTimeout(() => { timedOut = true; killClient(); resolve(result(null)) }, options.timeoutMs)
    })])
  } finally {
    if (timer) clearTimeout(timer)
    killClient()
    for (const reader of readers) { try { void reader.cancel().catch(() => {}) } catch {} }
  }
  }
}
export const runDocker = boundedDockerRunner()

function successful(result: DockerResult): boolean { return result.exitCode === 0 && !result.timedOut && !result.outputExceeded }
function json(result: DockerResult): unknown {
  if (!successful(result) || result.stdoutBytes > CAPTURE_LIMIT) throw new Error("Docker observation unavailable")
  return JSON.parse(text(result.stdout)) as unknown
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Docker metadata invalid")
  return value as Record<string, unknown>
}

/** The label selects our owned image profile; the pinned ID remains operator trust. */
export function inspectCheckerImage(value: unknown, expectedID: string): string {
  if (!Array.isArray(value) || value.length !== 1) throw new Error("Checker image invalid")
  const image = object(value[0]), config = object(image.Config), labels = object(config.Labels)
  if (image.Id !== expectedID || labels["org.aboiteau.check.profile"] !== CHECK_PROFILE || config.User !== "65532:65532" || JSON.stringify(config.Entrypoint) !== JSON.stringify(CHECK_ENTRYPOINT) || (config.Cmd !== null && (!Array.isArray(config.Cmd) || config.Cmd.length)) || (config.Volumes !== null && config.Volumes !== undefined) || (config.OnBuild !== null && config.OnBuild !== undefined && (!Array.isArray(config.OnBuild) || config.OnBuild.length)) || config.Healthcheck) throw new Error("Checker profile mismatch")
  if (!Array.isArray(config.Env) || config.Env.length > 16) throw new Error("Checker environment invalid")
  const names = new Set<string>()
  for (const entry of config.Env) {
    if (typeof entry !== "string") throw new Error("Checker environment invalid")
    const match = /^([A-Z_]+)=(.*)$/.exec(entry)
    if (!match || names.has(match[1])) throw new Error("Checker environment invalid")
    names.add(match[1])
    const [name, value] = [match[1], match[2]]
    if (!(name === "PATH" && value === "/usr/local/bin:/usr/bin:/bin") && !(name === "BUN_OPTIONS" && value === "") && !(name === "BUN_RUNTIME_TRANSPILER_CACHE_PATH" && value === "0") && !(name === "BUN_INSTALL_BIN" && value === "/usr/local/bin")) throw new Error("Checker environment not allowed")
  }
  if (!names.has("PATH") || !names.has("BUN_OPTIONS") || typeof image.Os !== "string" || typeof image.Architecture !== "string" || !/^[a-z0-9_]+$/.test(image.Os) || !/^[a-z0-9_]+$/.test(image.Architecture)) throw new Error("Checker platform invalid")
  return image.Os + "/" + image.Architecture
}

export function checkerCreateArgs(request: WorkspaceCheckRequest, collectorID: string): string[] {
  parseWorkspaceCheckRequest(request)
  parseWorkspaceCheckRequest({ ...request, requestID: collectorID })
  return ["create", "--pull=never", "--name", "aboiteau-check-" + collectorID,
    "--label", "org.aboiteau.check.request=" + request.requestID, "--label", "org.aboiteau.check.profile=" + CHECK_PROFILE,
    "--label", "org.aboiteau.check.collector=" + collectorID,
    "--user", "65532:65532", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--memory", "536870912", "--memory-swap", "536870912", "--cpus", "1", "--pids-limit", "64", "--ulimit", "nofile=128:128",
    "--tmpfs", "/workspace:rw,nosuid,nodev,size=134217728,uid=65532,gid=65532,mode=0700",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=67108864,uid=65532,gid=65532,mode=0700",
    "--workdir", "/workspace", "--log-driver", "none", "--interactive", request.imageID]
}

async function atomicJSON(directory: string, name: string, value: unknown): Promise<void> {
  const temporary = join(directory, "." + name + "." + crypto.randomUUID())
  await durableCreate(directory, temporary, JSON.stringify(value, null, 2) + "\n")
  await rename(temporary, join(directory, name))
  await syncDirectory(directory)
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r")
  try { await handle.sync() } finally { await handle.close() }
}
async function durableCreate(directory: string, path: string, content: string): Promise<void> {
  const handle = await open(path, "wx", 0o600)
  try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
  await syncDirectory(directory)
}

export interface CheckJournal {
  schemaVersion: 1
  provenance: "local_operator"
  request: WorkspaceCheckRequest
  collectorID: string
  sourceSHA256: string
  containerName: string
  phase: "prepared" | "create_requested" | "start_requested" | "settled"
}

export async function readLocalCheck(directory: string): Promise<{ receipt?: WorkspaceCheckLocalReceipt; journal?: CheckJournal }> {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error("Evidence directory must be private")
  const read = async (name: string): Promise<unknown | undefined> => {
    try {
      const path = join(directory, name), stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) throw new Error("Evidence metadata invalid")
      return JSON.parse(await readFile(path, "utf8")) as unknown
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
      throw error
    }
  }
  const rawReceipt = await read("receipt.json")
  if (rawReceipt !== undefined) {
    const receipt = parseWorkspaceCheckLocalReceipt(rawReceipt), hash = await read("receipt-sha256.json")
    if (!hash || object(hash).sha256 !== sha256(JSON.stringify(receipt))) throw new Error("Receipt digest mismatch")
    return { receipt }
  }
  const raw = await read("journal.json")
  if (raw === undefined) return {}
  const journal = object(raw), request = parseWorkspaceCheckRequest(journal.request)
  if (Object.keys(journal).sort().join(",") !== "collectorID,containerName,phase,provenance,request,schemaVersion,sourceSHA256" || journal.schemaVersion !== 1 || journal.provenance !== "local_operator" || typeof journal.collectorID !== "string" || journal.containerName !== "aboiteau-check-" + journal.collectorID || typeof journal.sourceSHA256 !== "string" || !/^[0-9a-f]{64}$/.test(journal.sourceSHA256) || !["prepared", "create_requested", "start_requested", "settled"].includes(String(journal.phase))) throw new Error("Journal invalid")
  parseWorkspaceCheckRequest({ ...request, requestID: journal.collectorID })
  return { journal: { schemaVersion: 1, provenance: "local_operator", request, collectorID: journal.collectorID, sourceSHA256: journal.sourceSHA256, containerName: journal.containerName, phase: journal.phase as CheckJournal["phase"] } }
}

async function absent(docker: DockerRunner, name: string): Promise<boolean> {
  const result = await docker(["container", "ls", "--all", "--filter", "name=^/" + name + "$", "--format", "{{.ID}}"], { timeoutMs: 10000 })
  return successful(result) && result.stdoutBytes === 0
}
async function removeOwned(docker: DockerRunner, name: string, requestID: string, collectorID: string): Promise<boolean> {
  if (await absent(docker, name)) return true
  const inspection = json(await docker(["inspect", name], { timeoutMs: 10000 }))
  if (!Array.isArray(inspection) || inspection.length !== 1) return false
  const labels = object(object(object(inspection[0]).Config).Labels)
  if (labels["org.aboiteau.check.request"] !== requestID || labels["org.aboiteau.check.collector"] !== collectorID) return false
  await docker(["rm", "--force", name], { timeoutMs: 10000 })
  return absent(docker, name)
}

function logReceipt(data: Uint8Array, bytes: number): WorkspaceCheckLog {
  return { sha256: sha256(data), bytes, capturedBytes: data.byteLength, truncated: bytes > data.byteLength }
}

export interface CollectCheckOptions {
  directory: string
  request: WorkspaceCheckRequest
  snapshot: VerifiedWorkspaceCheckSnapshot
  before: Freshness
  after: () => Promise<Freshness>
  docker?: DockerRunner
}

/** Collector-owned state/exit/logs; repository output is never parsed as proof. */
export async function collectWorkspaceCheck(options: CollectCheckOptions): Promise<WorkspaceCheckLocalReceipt> {
  const { directory, snapshot } = options, request = parseWorkspaceCheckRequest(options.request)
  if (snapshot.commit !== request.commitOID || snapshot.workspaceRepository.bindingID !== request.expectedBindingID) throw new Error("Source identity mismatch")
  const existing = await readLocalCheck(directory)
  if (existing.receipt || existing.journal) throw new Error("Existing evidence is never rerun")
  const docker = options.docker ?? runDocker, startedAt = Date.now(), collectorID = crypto.randomUUID(), name = "aboiteau-check-" + collectorID
  const journal: CheckJournal = { schemaVersion: 1, provenance: "local_operator", request, collectorID, sourceSHA256: snapshot.snapshotSHA256, containerName: name, phase: "prepared" }
  await durableCreate(directory, join(directory, "journal.json"), JSON.stringify(journal, null, 2) + "\n")
  await durableCreate(directory, join(directory, "snapshot.json"), snapshot.canonicalJSON)
  let platform = "unknown/unknown", attempted = false, cleanupConfirmed = true
  let outcome: WorkspaceCheckLocalReceipt["outcome"] = "not_run", exitCode: number | null = null
  let execution: DockerResult | undefined
  let after: Freshness = "unknown"
  try {
    if (options.before !== "matched") throw new Error("Committed HEAD not current")
    platform = inspectCheckerImage(json(await docker(["image", "inspect", request.imageID], { timeoutMs: 10000 })), request.imageID)
    if (!await absent(docker, name)) throw new Error("Existing container requires review")
    journal.phase = "create_requested"; await atomicJSON(directory, "journal.json", journal)
    attempted = true; cleanupConfirmed = false
    if (!successful(await docker(checkerCreateArgs(request, collectorID), { timeoutMs: 10000 }))) throw new Error("Create acknowledgement unavailable")
    journal.phase = "start_requested"; await atomicJSON(directory, "journal.json", journal)
    execution = await docker(["start", "--attach", "--interactive", name], { timeoutMs: request.timeoutMs, input: JSON.stringify({ argv: request.argv, snapshot: JSON.parse(snapshot.canonicalJSON) }) })
    const inspection = json(await docker(["inspect", name], { timeoutMs: 10000 }))
    if (!Array.isArray(inspection) || inspection.length !== 1) throw new Error("Container state unavailable")
    const state = object(object(inspection[0]).State)
    if (execution.timedOut) outcome = "timeout"
    else if (execution.outputExceeded) outcome = "collector_error"
    else if (state.Running !== false || state.Status !== "exited" || typeof state.OOMKilled !== "boolean" || !Number.isInteger(state.ExitCode) || Number(state.ExitCode) < 0 || Number(state.ExitCode) > 255) throw new Error("Container exit unavailable")
    else {
      exitCode = Number(state.ExitCode)
      outcome = state.OOMKilled ? "oom" : exitCode === 125 ? "collector_error" : exitCode === 0 ? "passed" : "failed"
    }
  } catch {
    if (options.before === "matched") outcome = execution?.timedOut ? "timeout" : "collector_error"
  } finally {
    if (attempted) {
      try { cleanupConfirmed = await removeOwned(docker, name, request.requestID, collectorID) } catch { cleanupConfirmed = false }
    }
    try { after = await options.after() } catch { after = "unknown" }
  }
  if (!cleanupConfirmed) outcome = "cleanup_unknown"
  const stdout = execution?.stdout ?? new Uint8Array(), stderr = execution?.stderr ?? new Uint8Array()
  await writeFile(join(directory, "stdout.log"), stdout, { flag: "wx", mode: 0o600 })
  await writeFile(join(directory, "stderr.log"), stderr, { flag: "wx", mode: 0o600 })
  const receipt = parseWorkspaceCheckLocalReceipt({ schemaVersion: 1, mode: "committed_only", provenance: "local_operator", request, binding: snapshot.workspaceRepository,
    treeOID: snapshot.tree, sourceSHA256: snapshot.snapshotSHA256, platform, startedAt, finishedAt: Date.now(), outcome, exitCode, cleanupConfirmed,
    freshness: { before: options.before, after }, worktreeChanges: "unverified", baselineChecks: "not_run", testOrConfigChanges: "not_evaluated",
    logs: { stdout: logReceipt(stdout, execution?.stdoutBytes ?? 0), stderr: logReceipt(stderr, execution?.stderrBytes ?? 0) } })
  await atomicJSON(directory, "receipt.json", receipt)
  await atomicJSON(directory, "receipt-sha256.json", { sha256: sha256(JSON.stringify(receipt)) })
  journal.phase = "settled"; await atomicJSON(directory, "journal.json", journal)
  return receipt
}

/** Recovery observes only. It never starts a container or repeats a command. */
export async function observeWorkspaceCheck(directory: string, docker: DockerRunner = runDocker): Promise<unknown> {
  const saved = await readLocalCheck(directory)
  if (saved.receipt) return { receipt: saved.receipt }
  if (!saved.journal) return { status: "unknown", executionRetried: false }
  try {
    const value = json(await docker(["inspect", saved.journal.containerName], { timeoutMs: 10000 }))
    if (!Array.isArray(value) || value.length !== 1) throw new Error()
    const state = object(object(value[0]).State), labels = object(object(object(value[0]).Config).Labels)
    if (labels["org.aboiteau.check.request"] !== saved.journal.request.requestID || labels["org.aboiteau.check.collector"] !== saved.journal.collectorID) throw new Error()
    return { status: state.Running === true ? "running" : "stopped_unsettled", requestID: saved.journal.request.requestID, executionRetried: false }
  } catch { return { status: "unknown", requestID: saved.journal.request.requestID, executionRetried: false } }
}
