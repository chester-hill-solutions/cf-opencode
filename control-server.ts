/**
 * Container control server. The Durable Object talks to this on :4001 so the
 * container never needs R2 credentials: the DO streams checkpoints to R2.
 *
 * Local S3 ("hot"): native stow-s3 serves the registered workspace and reports
 * its private endpoint credentials over an inherited readiness descriptor.
 * R2 ("cold"): checkpoints are tar.gz streams the DO stores in R2.
 *
 * Snapshots (durable_object policy): the DO captures the writable root on
 * recycle and restores it on the next start. Image-bound, so a deploy that
 * changes the image makes the previous snapshot unusable.
 *
 * Trust split: this process runs as root; only creation of synthetic empty
 * Workspace infrastructure runs as root. Stow serving, OpenCode and every
 * operation that touches user files run as `agent`. Harness state lives outside the
 * agent's workspace, so a repo can never overwrite config or credentials.
 *
 *   GET  /health      liveness
 *   GET  /status      { initialized, running, s3, stateCheckpoint }
 *   POST /start       start stow-s3 and opencode serve, wait until ready
 *   POST /restore?part=workspace|state   body = tar.gz, replaces that root
 *   POST /seed-state  body = tar.gz of the state root, seeds config + credentials
 *   GET  /checkpoint?part=workspace|state&since=  tar.gz or 204
 *   GET  /state-checkpoint  tar.gz of the state root (account seeding)
 *   ANY  /opencode/*  authenticated proxy to OpenCode on 127.0.0.1:4000
 *   GET  /integrations               OpenCode provider integrations
 *   POST /integrations/:id/connect/oauth            begin OAuth
 *   GET  /integrations/:id/connect/oauth/:attempt   poll attempt
 *   POST /integrations/:id/connect/oauth/:attempt/complete
 *   POST /integrations/:id/connect/key              save an API key
 *   GET  /models                     live model catalogue
 */

import { spawn } from "bun"
import { createHash, randomBytes } from "node:crypto"
import {
  chownSync,
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { posix, relative } from "node:path"
import { buildPermissionRules, type PermissionLists } from "./src/permissions"
import {
  ACCOUNTING_POLICY_CONTENT,
  ACCOUNTING_POLICY_ID,
} from "./src/accounting-policy"
import { bearerAuthorized } from "./src/control-auth"
import { createLifecycleGate, stopChild } from "./control-lifecycle"
import { assertSafeArchiveMembers, linkStaysInside, safeRelativeLink } from "./src/tar"
import {
  parseWorkspaceIdentity,
  parseWorkspaceReadiness,
  type WorkspaceIdentity,
  type WorkspaceReadiness,
} from "./stow-workspace"

const WORKSPACE = process.env.WORKSPACE ?? "/workspace"
/** Harness state: OpenCode config, credentials and database. Never the repo. */
const STATE_ROOT = process.env.ABOITEAU_STATE_DIR ?? "/var/lib/aboiteau/state"
const RUN_DIR = process.env.ABOITEAU_RUN_DIR ?? "/var/lib/aboiteau/run"
const STATE_DIR = process.env.XDG_DATA_HOME ?? `${STATE_ROOT}/data`
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT ?? 4000)
const CONTROL_PORT = Number(process.env.CONTROL_PORT ?? 4001)
const STOW_ROOT = `${STATE_ROOT}/stow`
const STOW_REGISTRY = `${STOW_ROOT}/registry`
const STOW_IDENTITY = `${STOW_ROOT}/identity.json`
const STOW_READY = `${process.env.ABOITEAU_RUN_DIR ?? "/var/lib/aboiteau/run"}/stow-ready.json`
const STOW_BUCKET = "aboiteau-workspace"
const STOW_BINARY = "/usr/local/bin/stow-s3"
/** Per-container bearer token supplied by the Durable Object at start. */
const CONTROL_TOKEN = process.env.CONTROL_TOKEN ?? ""
let workspaceRepo = process.env.WORKSPACE_REPO ?? ""
let workspaceBranch = process.env.WORKSPACE_BRANCH ?? "main"
/** GitHub token for cloning private repositories; memory only, never persisted. */
let githubToken = ""
const MARKER = `${STATE_ROOT}/initialized`
/** The unprivileged user that owns the workspace and runs OpenCode. */
const AGENT_UID = Number(process.env.AGENT_UID ?? 1001)
const AGENT_GID = Number(process.env.AGENT_GID ?? 1001)

let opencode: ReturnType<typeof spawn> | undefined
let opencodeGeneration: string | undefined
let opencodeEventPersistence = false
let stow: ReturnType<typeof spawn> | undefined
let stowReadiness: WorkspaceReadiness | undefined
let workspaceIdentity: WorkspaceIdentity | undefined
let opencodePassword = ""
const runLifecycle = createLifecycleGate()
const enqueueLifecycle = runLifecycle

function basicAuth(password: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
}

function nativeWorkspaceAvailable(): boolean {
  if (!stow || stow.exitCode !== null) {
    stowReadiness = undefined
    rmSync(STOW_READY, { force: true })
    return false
  }
  return stowReadiness !== undefined
}

/**
 * Drop privileges for a command.
 *
 * Bun's `spawn` accepts `uid`/`gid` but ignores them on Linux (verified in the
 * image: a child spawned with uid 1001 still ran as root). `setpriv` is part of
 * util-linux and performs the setuid/setgid exec reliably, while preserving the
 * curated environment Bun passes.
 */
export function buildAgentCommand(
  command: string[],
  uid = AGENT_UID,
  gid = AGENT_GID,
): string[] {
  return [
    "setpriv",
    "--reuid",
    String(uid),
    "--regid",
    String(gid),
    "--init-groups",
    "--",
    ...command,
  ]
}

/** Drop privileges only when running as root (the container); local tests run
 * unprivileged already and setpriv is Linux-only. */
export function asAgentCommand(command: string[]): string[] {
  if (typeof process.getuid === "function" && process.getuid() !== 0) return command
  return buildAgentCommand(command)
}

/**
 * OpenCode's own HTTP API, for onboarding: provider integrations and the live
 * model catalogue. The DO is the only caller; never exposed publicly.
 */
async function opencodeFetch(path: string, init?: { method?: string; body?: unknown }): Promise<Response> {
  if (!nativeWorkspaceAvailable()) {
    return Response.json({ error: "native workspace is not ready" }, { status: 503 })
  }
  if (!opencode || opencode.exitCode !== null) {
    return Response.json({ error: "OpenCode is not running" }, { status: 503 })
  }
  return fetch(`http://127.0.0.1:${OPENCODE_PORT}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      ...basicAuth(opencodePassword),
      ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(60_000),
  })
}

/** Clone arguments, adding a credential header for private GitHub repositories. */
function cloneArgs(repo: string): string[] {
  const auth = githubToken && /^https:\/\/github\.com\//.test(repo)
  const encoded = Buffer.from(`x-access-token:${githubToken}`).toString("base64")
  return [
    ...(auth
      ? ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${encoded}`]
      : []),
    "clone",
    "--depth",
    "1",
    "--branch",
    workspaceBranch,
    repo,
  ]
}

export async function waitFor(url: string, attempts = 150, headers?: Record<string, string>): Promise<void> {
  const deadline = performance.now() + attempts * 200
  for (let attempt = 0; attempt < attempts; attempt++) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) break
    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(Math.max(1, Math.min(1000, Math.ceil(remaining)))),
      })
      if (res.ok) return
    } catch {
      /* not ready */
    }
    const pause = Math.min(200, deadline - performance.now())
    if (attempt + 1 < attempts && pause > 0) await Bun.sleep(pause)
  }
  throw new Error(`${url} did not become ready`)
}

function expectedWorkspace() {
  return { root: WORKSPACE, registryDir: STOW_REGISTRY, bucket: STOW_BUCKET }
}

function loadWorkspaceIdentity(): WorkspaceIdentity {
  if (workspaceIdentity) return workspaceIdentity
  const identityStat = tryLstat(STOW_IDENTITY)
  if (!identityStat || !identityStat.isFile() || identityStat.isSymbolicLink()) {
    throw new Error("native workspace identity is missing or unsafe")
  }
  try {
    const value = JSON.parse(readFileSync(STOW_IDENTITY, "utf8")) as unknown
    workspaceIdentity = parseWorkspaceIdentity(value, expectedWorkspace())
  } catch {
    throw new Error("native workspace identity is invalid")
  }
  const rootStat = tryLstat(WORKSPACE)
  const metadataStat = tryLstat(`${WORKSPACE}/.stow`)
  const manifestStat = tryLstat(`${WORKSPACE}/.stow/manifest.json`)
  const registryStat = tryLstat(STOW_REGISTRY)
  if (
    !rootStat?.isDirectory() || rootStat.isSymbolicLink() ||
    !metadataStat?.isDirectory() || metadataStat.isSymbolicLink() ||
    !manifestStat?.isFile() || manifestStat.isSymbolicLink() ||
    !registryStat?.isDirectory() || registryStat.isSymbolicLink()
  ) {
    workspaceIdentity = undefined
    throw new Error("native workspace identity does not match restored workspace data")
  }
  return workspaceIdentity
}

async function prepareWorkspaceIdentity(): Promise<WorkspaceIdentity> {
  if (tryLstat(STOW_IDENTITY)) return loadWorkspaceIdentity()
  if (initialized() || tryLstat(STOW_ROOT)) {
    throw new Error("native workspace identity is missing from existing state")
  }

  let rootExists = false
  try {
    const rootStat = lstatSync(WORKSPACE)
    rootExists = true
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || readdirSync(WORKSPACE).length !== 0) {
      throw new Error("native workspace cannot initialize a nonempty or unsafe workspace root")
    }
  } catch (error) {
    if (isENOENT(error)) rootExists = false
    else throw error
  }
  if (rootExists) rmdirSync(WORKSPACE)

  const inputDir = `${RUN_DIR}/stow-empty-input-${randomBytes(8).toString("hex")}`
  const manifestPath = `${RUN_DIR}/stow-manifest-${randomBytes(8).toString("hex")}.json`
  mkdirSync(inputDir, { recursive: false, mode: 0o700 })
  const manifest = {
    version: 1,
    root: WORKSPACE,
    working_directory: ".",
    registry_dir: STOW_REGISTRY,
    bucket: STOW_BUCKET,
    inputs: [{ source: inputDir, destination: "." }],
  }
  writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600, flag: "wx" })
  try {
    const proc = spawn([STOW_BINARY, "workspace", "prepare", "--manifest", manifestPath], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const outputPromise = new Response(proc.stdout as ReadableStream).text()
    const result = await awaitChildExitBounded(proc, 30_000, "native workspace prepare")
    if (result.timedOut || result.code !== 0) throw new Error("native workspace prepare failed")
    const output = await outputPromise
    let identity: WorkspaceIdentity
    try {
      identity = parseWorkspaceIdentity(JSON.parse(output) as unknown, expectedWorkspace())
    } catch {
      throw new Error("native workspace prepare returned invalid identity")
    }
    // Root creates only the empty Workspace infrastructure. Native workspace
    // files and all serving/writer operations are owned by the agent.
    chownTreeRequired(WORKSPACE, AGENT_UID, AGENT_GID)
    chownTreeRequired(STOW_ROOT, AGENT_UID, AGENT_GID)
    const temporaryIdentity = `${STOW_IDENTITY}.${randomBytes(6).toString("hex")}.tmp`
    writeFileSync(temporaryIdentity, JSON.stringify(identity), { mode: 0o600, flag: "wx" })
    chownSync(temporaryIdentity, AGENT_UID, AGENT_GID)
    renameSync(temporaryIdentity, STOW_IDENTITY)
    workspaceIdentity = identity
    return identity
  } finally {
    rmSync(inputDir, { recursive: true, force: true })
    rmSync(manifestPath, { force: true })
  }
}

export function buildStowEnv(source: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {
    PATH: source.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: source.HOME ?? STATE_ROOT,
    WORKSPACE,
    XDG_DATA_HOME: source.XDG_DATA_HOME ?? `${STATE_ROOT}/data`,
    XDG_CONFIG_HOME: source.XDG_CONFIG_HOME ?? `${STATE_ROOT}/config`,
    XDG_CACHE_HOME: source.XDG_CACHE_HOME ?? `${STATE_ROOT}/cache`,
  }
  if (source.LANG) env.LANG = source.LANG
  if (source.TERM) env.TERM = source.TERM
  return env
}

function waitForWorkspaceReadiness(
  processHandle: ReturnType<typeof spawn>,
  identity: WorkspaceIdentity,
  timeoutMs = 30_000,
): Promise<WorkspaceReadiness> {
  const deadline = performance.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (processHandle.exitCode !== null) return reject(new Error("native workspace server exited before readiness"))
      try {
        const readiness = parseWorkspaceReadiness(JSON.parse(readFileSync(STOW_READY, "utf8")) as unknown, identity)
        resolve(readiness)
        return
      } catch (error) {
        if (error instanceof SyntaxError || isENOENT(error)) {
          // The descriptor is written atomically by the native process to its
          // inherited pipe-backed file. Partial JSON is retried until deadline.
        } else if (error instanceof Error && error.message === "invalid workspace readiness") {
          reject(error)
          return
        }
      }
      if (performance.now() >= deadline) {
        reject(new Error("native workspace readiness timed out"))
        return
      }
      setTimeout(poll, 100)
    }
    poll()
  })
}

async function ensureStow(): Promise<void> {
  if (stow && stow.exitCode === null && stowReadiness) return
  if (opencode && opencode.exitCode === null) {
    await stopChild(opencode, "OpenCode")
    opencode = undefined
    opencodePassword = ""
    opencodeGeneration = undefined
    opencodeEventPersistence = false
  }
  if (stow && stow.exitCode === null) await stopChild(stow, "native workspace")
  if (stow) stow = undefined
  stowReadiness = undefined
  const identity = await prepareWorkspaceIdentity()
  rmSync(STOW_READY, { force: true })
  const launcher = [
    "umask 077; : > \"$1\"; chmod 0600 \"$1\"; exec 3>\"$1\"; uid=$2; gid=$3; shift 3; exec setpriv --reuid \"$uid\" --regid \"$gid\" --init-groups -- \"$@\"",
    "stow-workspace-launcher",
    STOW_READY,
    String(AGENT_UID),
    String(AGENT_GID),
    STOW_BINARY,
    "workspace",
    "serve",
    "--id",
    identity.workspace_id,
    "--registry-dir",
    STOW_REGISTRY,
    "--ready-fd",
    "3",
  ]
  stow = spawn(["bash", "-c", ...launcher], {
    cwd: WORKSPACE,
    env: buildStowEnv(process.env),
    stdout: "ignore",
    stderr: "ignore",
  })
  try {
    stowReadiness = await waitForWorkspaceReadiness(stow, identity)
    if (!nativeWorkspaceAvailable()) throw new Error("native workspace server exited after readiness")
  } catch (error) {
    await stopChild(stow, "native workspace")
    stow = undefined
    stowReadiness = undefined
    rmSync(STOW_READY, { force: true })
    throw error
  }
}

async function startOpencode(): Promise<void> {
  if (!nativeWorkspaceAvailable()) throw new Error("native workspace readiness is required before OpenCode")
  if (!opencode || opencode.exitCode !== null) {
    if (opencode) {
      opencode = undefined
      opencodeGeneration = undefined
      opencodeEventPersistence = false
    }
    // OpenCode v2 requires a password. Use the configured one if present so the
    // Worker and container can share it; otherwise generate a per-start secret.
    opencodePassword = process.env.OPENCODE_PASSWORD ?? randomBytes(32).toString("base64url")
    opencodeGeneration = randomBytes(24).toString("base64url")
    opencode = spawn(
      asAgentCommand(["bun", "/app/runtime/opencode/server.ts"]),
      {
        cwd: WORKSPACE,
        env: buildOpencodeEnv(process.env, opencodePassword, stowReadiness),
        stdout: "inherit",
        stderr: "inherit",
      },
    )
  }
  // A surviving process still needs a fresh health proof after a previous
  // readiness timeout before readiness is advertised again.
  opencodeEventPersistence = false
  await waitFor(`http://127.0.0.1:${OPENCODE_PORT}/api/info`, 300, basicAuth(opencodePassword))
  if (!nativeWorkspaceAvailable()) throw new Error("native workspace exited during OpenCode readiness")
  opencodeEventPersistence = true
}

/**
 * Environment handed to OpenCode. Explicitly allowlisted: the agent's tools
 * inherit this, so the control-plane token and unrelated Worker secrets must
 * never be included.
 */
export function buildOpencodeEnv(
  source: Record<string, string | undefined>,
  password: string,
  readiness: WorkspaceReadiness | undefined,
): Record<string, string> {
  if (!readiness) throw new Error("validated native workspace readiness is required")
  const env: Record<string, string> = {
    PATH: source.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: source.HOME ?? STATE_ROOT,
    WORKSPACE,
    XDG_DATA_HOME: source.XDG_DATA_HOME ?? `${STATE_ROOT}/data`,
    XDG_CONFIG_HOME: source.XDG_CONFIG_HOME ?? `${STATE_ROOT}/config`,
    XDG_CACHE_HOME: source.XDG_CACHE_HOME ?? `${STATE_ROOT}/cache`,
    XDG_STATE_HOME: source.XDG_STATE_HOME ?? `${source.HOME ?? STATE_ROOT}/.local/state`,
    OPENCODE_PORT: String(OPENCODE_PORT),
    OPENCODE_PASSWORD: password,
    OPENCODE_SERVER_PASSWORD: password,
    // Fixed by the harness so project config cannot re-enable detached billing.
    // Caller-provided OPENCODE_CONFIG_CONTENT is intentionally not forwarded.
    OPENCODE_CONFIG_CONTENT: ACCOUNTING_POLICY_CONTENT,
    S3_ENDPOINT: readiness.endpoint,
    S3_REGION: readiness.region,
    S3_BUCKET: readiness.bucket,
    S3_ACCESS_KEY_ID: readiness.access_key_id,
    S3_SECRET_ACCESS_KEY: readiness.secret_access_key,
  }
  if (source.LANG) env.LANG = source.LANG
  if (source.TERM) env.TERM = source.TERM
  return env
}

function writeOpencodeConfig(model?: string, permissions?: PermissionLists) {
  const dir = `${process.env.XDG_CONFIG_HOME ?? `${STATE_ROOT}/config`}/opencode`
  mkdirSync(dir, { recursive: true })
  const config = {
    $schema: "https://opencode.ai/config.json",
    ...(model ? { model } : {}),
    permissions: buildPermissionRules(permissions, WORKSPACE, STATE_ROOT),
  }
  writeFileSync(`${dir}/opencode.json`, JSON.stringify(config, null, 2))
  fixStatePermissions()
}

/** Paths under the state root, depth-first and sorted, excluding hot scratch. */
function stateFiles(root = STATE_ROOT, base = root, out: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${base}/${entry.name}`
    if (base === root && (entry.name === "cache" || entry.name === "log")) continue
    if (entry.isDirectory()) stateFiles(root, path, out)
    else out.push(path)
  }
  return out
}

/**
 * Workspace identity for checkpoint dedupe. Status names alone are not enough:
 * editing an already-modified file leaves them unchanged, which would skip the
 * checkpoint and silently lose the edit. Hash the diff and untracked plus
 * ignored contents — the archive includes ignored files, so an ignored-only
 * edit must not be skipped either. Non-Git workspaces have no diff to hash,
 * so their fingerprint covers every archived path with size and mtime.
 */
export async function workspaceFingerprint(workspace = WORKSPACE): Promise<string> {
  if (existsSync(`${workspace}/.git`)) {
    const head = await runCapture(["git", "-C", workspace, "rev-parse", "HEAD"])
    const status = await runCapture(["git", "-C", workspace, "status", "--porcelain"])
    const diff = await runCapture(["git", "-C", workspace, "diff", "HEAD", "--binary", "--no-color"])
    const untracked = await runCapture(["git", "-C", workspace, "ls-files", "--others", "--exclude-standard", "-z"])
    const ignored = await runCapture(["git", "-C", workspace, "ls-files", "--others", "--ignored", "--exclude-standard", "-z"])
    const paths = new Set([...untracked.split("\0").filter(Boolean), ...ignored.split("\0").filter(Boolean)])
    const trackedGitlinks = new Set<string>()
    const stagedPaths = await runCapture(["git", "-C", workspace, "ls-files", "--stage", "-z"])
    for (const record of stagedPaths.split("\0").filter(Boolean)) {
      const tab = record.indexOf("\t")
      if (tab < 0) throw new Error("cannot parse staged workspace path")
      const mode = record.slice(0, tab).split(" ", 1)[0]
      if (mode === "160000") {
        const path = record.slice(tab + 1)
        paths.add(path)
        trackedGitlinks.add(path)
      }
    }
    const filesToHash = new Set<string>()
    for (const listedPath of [...paths].sort()) {
      const path = listedPath.replace(/\/+$/, "")
      // node_modules is excluded at any depth; the current root `.stow` is part
      // of the native Workspace identity and recovery state.
      const parts = path.split("/")
      if (parts.includes("node_modules")) continue
      const absolutePath = `${workspace}/${path}`
      let info
      try {
        info = lstatSync(absolutePath)
      } catch (error) {
        if (trackedGitlinks.has(path) && isENOENT(error)) continue
        throw new Error(`cannot fingerprint listed workspace path ${path}: ${String(error)}`)
      }
      if (info.isDirectory()) {
        for (const file of workspaceFileEntries(workspace, absolutePath)) {
          filesToHash.add(relative(workspace, file))
        }
      } else {
        filesToHash.add(path)
      }
    }
    const files: string[] = []
    for (const path of [...filesToHash].sort()) {
      const hash = await runCapture(["git", "-C", workspace, "hash-object", "--", path])
      const digest = hash.trim()
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(digest)) {
        throw new Error(`cannot fingerprint listed workspace file ${path}`)
      }
      files.push(`${path}:${digest}`)
    }
    return createHash("sha256").update(`${head}\n${status}\n${diff}\n${files.join("\n")}`).digest("hex")
  }
  const entries = existsSync(workspace) ? workspaceFileEntries(workspace) : []
  const hash = createHash("sha256")
  for (const file of entries) {
    let stat
    try {
      stat = statSync(file)
    } catch {
      continue
    }
    hash.update(`${relative(workspace, file)}\0${stat.size}\0${stat.mtimeMs}\n`)
  }
  return hash.digest("hex")
}

function isENOENT(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function tryLstat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if (isENOENT(error)) return undefined
    throw error
  }
}

/** Every archived file under a non-Git workspace, minus the tar excludes. */
function workspaceFileEntries(root: string, base = root, out: string[] = []): string[] {
  const entries = readdirSync(base, { withFileTypes: true })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "node_modules") continue
    const path = `${base}/${entry.name}`
    if (entry.isDirectory()) workspaceFileEntries(root, path, out)
    else out.push(path)
  }
  return out
}

/**
 * Archive the native Workspace metadata with the workspace bytes. node_modules
 * remains disposable cache; the root `.stow` directory is the persisted identity
 * and may not be omitted from replacement-container recovery.
 */
export async function archiveWorkspace(archive: string, root = WORKSPACE): Promise<number> {
  // Use an explicit NUL-delimited member list so nested trees are not traversed
  // a second time by tar and all native `.stow` metadata is preserved.
  const entries: string[] = ["."]
  let failedToList = false
  const walk = (base: string): void => {
    let children
    try {
      children = readdirSync(base, { withFileTypes: true })
    } catch {
      failedToList = true
      return
    }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (child.name === "node_modules") continue
      const path = `${base}/${child.name}`
      entries.push(relative(root, path))
      if (child.isDirectory()) walk(path)
    }
  }
  walk(root)
  if (failedToList) return 1

  const members = `${archive}.members`
  try {
    if (entries.length > 0) writeFileSync(members, `${entries.join("\0")}\0`, { mode: 0o644 })
    else writeFileSync(members, "", { mode: 0o644 })
    return await run([
      "tar",
      "czf",
      archive,
      "-C",
      root,
      "--no-recursion",
      "--null",
      "--files-from",
      members,
    ])
  } finally {
    rmSync(members, { force: true })
  }
}

/**
 * State identity for checkpoint dedupe. Sizes and mtimes avoid reading the DB
 * and credentials just to decide whether a write is needed.
 */
export function stateFingerprint(root = STATE_ROOT): string {
  const hash = createHash("sha256")
  for (const file of stateFiles(root)) {
    let stat
    try {
      stat = statSync(file)
    } catch {
      continue
    }
    hash.update(`${relative(root, file)}\0${stat.size}\0${stat.mtimeMs}\n`)
  }
  return hash.digest("hex")
}

/** List an archive so restore can reject absolute and `..` members. */
async function assertSafeArchive(path: string): Promise<string> {
  const text = await runCapture(["tar", "tzf", path])
  assertSafeArchiveMembers(text)
  // Hard links carry their target outside the member name, so `tzf` cannot
  // see it. Reject targets that are absolute or escape the extraction root.
  const verbose = await runCapture(["tar", "tzvf", path])
  for (const line of verbose.split("\n")) {
    if (!line.startsWith("h")) continue
    const marker = line.indexOf(" link to ")
    const target = marker >= 0 ? line.slice(marker + " link to ".length).trim() : ""
    if (!safeRelativeLink(target)) {
      throw new Error(`archive hard link escapes the extraction root: ${target || "(missing target)"}`)
    }
  }
  return text
}

/** Account seeds must never transplant a conversation's Stow identity. */
export function accountSeedContainsStow(members: string): boolean {
  return members.split("\n").some((member) => {
    const normalized = posix.normalize(member.replace(/\\/g, "/"))
    return normalized === "stow" || normalized.startsWith("stow/")
  })
}

/**
 * A workspace symlink that resolves outside the workspace can reach harness
 * state (provider credentials) through a path that never names the state root,
 * bypassing the permission rules. Relative links that stay inside are allowed.
 */
async function assertWorkspaceLinks(root = WORKSPACE): Promise<void> {
  const listing = await runCapture(["find", root, "-type", "l", "-print0"])
  for (const link of listing.split("\0").filter(Boolean)) {
    const target = (await runCapture(["readlink", "-f", "--", link])).trim()
    if (!linkStaysInside(root, target)) {
      throw new Error(
        `workspace symlink escapes the workspace: ${link} -> ${target || "(unresolved)"}`,
      )
    }
  }
}

/**
 * A state symlink that resolves outside the state root lets OpenCode, running
 * as the agent, read or overwrite files through a path that never names the
 * state root. Same containment rule as the workspace: links that stay inside
 * are allowed.
 */
async function assertStateLinks(root = STATE_ROOT): Promise<void> {
  if (!existsSync(root)) return
  const listing = await runCapture(["find", root, "-type", "l", "-print0"])
  for (const link of listing.split("\0").filter(Boolean)) {
    const target = (await runCapture(["readlink", "-f", "--", link])).trim()
    if (!linkStaysInside(root, target)) {
      throw new Error(
        `state symlink escapes the state root: ${link} -> ${target || "(unresolved)"}`,
      )
    }
  }
}

function chown(path: string, uid: number, gid: number): void {
  try {
    chownSync(path, uid, gid)
  } catch {
    /* best effort: the image may already have the right owner */
  }
}

/** Strict ownership handoff for newly prepared native Workspace metadata. */
function chownTreeRequired(path: string, uid: number, gid: number): void {
  const before = lstatSync(path)
  if (before.isSymbolicLink()) throw new Error("native workspace prepare created an unsafe symlink")
  chownSync(path, uid, gid)
  const after = lstatSync(path)
  if (after.uid !== uid || after.gid !== gid) throw new Error("native workspace ownership handoff failed")
  if (after.isDirectory()) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      chownTreeRequired(`${path}/${entry.name}`, uid, gid)
    }
  }
}

/** The workspace belongs to the agent. */
function fixWorkspacePermissions(): void {
  if (!existsSync(WORKSPACE)) return
  chown(WORKSPACE, AGENT_UID, AGENT_GID)
  for (const entry of readdirSync(WORKSPACE)) {
    const path = `${WORKSPACE}/${entry}`
    chown(path, AGENT_UID, AGENT_GID)
  }
}

/**
 * State contents belong to the agent: OpenCode must own its database to chmod
 * it, and it already has to read its own credentials. The top-level directory
 * stays root-owned so a future non-agent process cannot replace it.
 */
function fixStatePermissions(): void {
  if (!existsSync(STATE_ROOT)) return
  chown(STATE_ROOT, 0, AGENT_GID)
  chmodSync(STATE_ROOT, 0o770)
  for (const file of stateFiles()) {
    chown(file, AGENT_UID, AGENT_GID)
    try {
      const stat = statSync(file)
      chmodSync(file, stat.isDirectory() ? 0o770 : 0o660)
    } catch {
      /* racing removal */
    }
  }
}

async function startRuntime(): Promise<Response> {
  try {
    // Establish the durable native root before any repository files are copied
    // into it. Existing identities are resumed, never re-prepared.
    await prepareWorkspaceIdentity()
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "native workspace initialization failed" },
      { status: 409 },
    )
  }

  if (!initialized() && workspaceRepo) {
    const tmp = `/tmp/workspace-clone-${randomBytes(8).toString("hex")}`
    const clone = spawn(asAgentCommand(["git", ...cloneArgs(workspaceRepo), tmp]), {
      stdout: "ignore",
      stderr: "pipe",
    })
    const cloneError = await new Response(clone.stderr as ReadableStream).text()
    const code = await clone.exited
    if (code !== 0) {
      return Response.json(
        { error: "workspace clone failed", detail: cloneError.trim().slice(-600) },
        { status: 500 },
      )
    }
    if (tryLstat(`${tmp}/.stow`)) {
      rmSync(tmp, { recursive: true, force: true })
      return Response.json({ error: "workspace repository conflicts with native .stow metadata" }, { status: 409 })
    }
    const copied = await run(["cp", "-a", `${tmp}/.`, WORKSPACE])
    rmSync(tmp, { recursive: true, force: true })
    if (copied !== 0) return Response.json({ error: "workspace copy failed" }, { status: 500 })
    fixWorkspacePermissions()
    try {
      await assertWorkspaceLinks()
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      )
    }
  }

  try {
    await ensureStow()
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "native workspace failed readiness" },
      { status: 503 },
    )
  }
  try {
    await startOpencode()
  } catch {
    await stopChild(opencode, "OpenCode")
    opencode = undefined
    opencodePassword = ""
    opencodeGeneration = undefined
    opencodeEventPersistence = false
    await stopChild(stow, "native workspace")
    stow = undefined
    stowReadiness = undefined
    rmSync(STOW_READY, { force: true })
    return Response.json({ error: "OpenCode failed readiness" }, { status: 503 })
  }
  if (!opencode || opencode.exitCode !== null || !opencodeGeneration || !nativeWorkspaceAvailable()) {
    await stopChild(opencode, "OpenCode")
    opencode = undefined
    opencodePassword = ""
    opencodeGeneration = undefined
    opencodeEventPersistence = false
    await stopChild(stow, "native workspace")
    stow = undefined
    stowReadiness = undefined
    rmSync(STOW_READY, { force: true })
    return Response.json({ error: "OpenCode exited before accounting policy verification" }, { status: 503 })
  }
  mkdirSync(STATE_ROOT, { recursive: true })
  writeFileSync(MARKER, new Date().toISOString())
  return Response.json({
    ok: true,
    accountingPolicy: ACCOUNTING_POLICY_ID,
    opencodeGeneration,
    ...(opencodeEventPersistence ? { eventPersistence: true } : {}),
  })
}

function initialized(): boolean {
  // The marker lives in the state root, outside the workspace. A repository's
  // `.git` is not an initialization signal: it exists as soon as the workspace
  // half of a split restore lands, before the state half.
  return existsSync(MARKER)
}

async function run(command: string[], asAgent = true): Promise<number> {
  const proc = spawn(asAgent ? asAgentCommand(command) : command, {
    stdout: "inherit",
    stderr: "inherit",
  })
  return proc.exited
}

async function runCapture(command: string[], asAgent = true): Promise<string> {
  const proc = spawn(asAgent ? asAgentCommand(command) : command, {
    stdout: "pipe",
    stderr: "ignore",
  })
  const text = await new Response(proc.stdout as ReadableStream).text()
  await proc.exited
  return text
}

async function awaitChildExitBounded(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  operation: string,
): Promise<{ code: number; timedOut: boolean }> {
  const result = await Promise.race([
    child.exited.then((code) => ({ done: true as const, code })),
    Bun.sleep(timeoutMs).then(() => ({ done: false as const })),
  ])
  if (result.done) return { code: result.code, timedOut: false }
  child.kill("SIGTERM")
  const afterTerm = await Promise.race([
    child.exited.then((code) => ({ done: true as const, code })),
    Bun.sleep(2_000).then(() => ({ done: false as const })),
  ])
  if (afterTerm.done) return { code: afterTerm.code, timedOut: true }
  child.kill("SIGKILL")
  const afterKill = await Promise.race([
    child.exited.then((code) => ({ done: true as const, code })),
    Bun.sleep(2_000).then(() => ({ done: false as const })),
  ])
  if (afterKill.done) return { code: afterKill.code, timedOut: true }
  throw new Error(`${operation} process could not be stopped`)
}

/** Drain a request body to disk. Bun.write can wait forever on a wrapped stream. */
async function drainToFile(body: ReadableStream, path: string): Promise<void> {
  const writer = Bun.file(path).writer()
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      writer.write(value)
    }
  } finally {
    await writer.end()
  }
}

/**
 * Locate OpenCode's SQLite database. v2 uses `$XDG_DATA_HOME/opencode/opencode.db`;
 * older layouts used `$XDG_DATA_HOME/opencode.db`. Guessing wrong silently
 * archives a live WAL instead of a consistent backup.
 */
export function databasePath(dataDir = STATE_DIR): string | undefined {
  return [`${dataDir}/opencode/opencode.db`, `${dataDir}/opencode.db`].find((path) =>
    existsSync(path),
  )
}

/**
 * Archive harness state with a consistent SQLite database. The live DB files
 * are excluded and replaced by `.backup` output, so OpenCode can keep running.
 */
async function archiveState(archive: string, accountSeed = false): Promise<number> {
  // Remove a stale archive from an older root-owned image before writing as
  // the agent user.
  rmSync(archive, { force: true })
  const backupDir = "/tmp/cf-opencode-state-backup"
  rmSync(backupDir, { recursive: true, force: true })
  mkdirSync(backupDir, { recursive: true })
  chown(backupDir, AGENT_UID, AGENT_GID)
  const database = databasePath()
  const relativeDatabase = database ? relative(STATE_ROOT, database) : undefined
  const backup = `${backupDir}/opencode.db`
  let copied = false
  if (database) {
    const code = await run(["sqlite3", database, `.backup '${backup}'`])
    copied = code === 0 && existsSync(backup)
    // A missing backup would archive state without its database, which restores
    // to an OpenCode that has forgotten every session.
    if (!copied) {
      rmSync(backupDir, { recursive: true, force: true })
      return 1
    }
  }
  const args = [
    "czf",
    archive,
    "-C",
    STATE_ROOT,
    "--exclude",
    "cache",
    "--exclude",
    "log",
  ]
  if (accountSeed) {
    // GNU tar is already required here for --transform below. Anchored patterns
    // exclude only the state-root Stow registry and initialization marker.
    args.push("--anchored", "--exclude=./stow", "--exclude=./initialized", "--no-anchored")
  }
  if (relativeDatabase) args.push("--exclude", `${relativeDatabase}*`)
  args.push(".")
  if (copied && relativeDatabase) {
    args.push("-C", backupDir, "--transform", `s|^opencode.db$|${relativeDatabase}|`, "opencode.db")
  }
  const code = await run(["tar", ...args])
  rmSync(backupDir, { recursive: true, force: true })
  return code
}

/** Both checkpoint parts advertise the split layout with this header. */
const SPLIT_HEADER = { "x-aboiteau-checkpoint": "split" } as const

if (import.meta.main && !CONTROL_TOKEN) {
  console.error("CONTROL_TOKEN is required; refusing to start the control server")
  process.exit(1)
}

if (import.meta.main) Bun.serve({
  port: CONTROL_PORT,
  idleTimeout: 120,
  async fetch(request) {
    const url = new URL(request.url)

    // /health stays open for readiness probes; every operation needs the
    // per-container token the Durable Object passed at start.
    if (url.pathname !== "/health" && !bearerAuthorized(request.headers.get("authorization"), CONTROL_TOKEN)) {
      return new Response("unauthorized", { status: 401 })
    }

    if (url.pathname === "/health") return Response.json({ ok: true })

    // ---- OpenCode proxy ------------------------------------------------------
    // The DO never holds the OpenCode password. This process owns it, so every
    // OpenCode API call (including the SSE stream) is authenticated here.
    if (url.pathname.startsWith("/opencode/")) {
      if (!nativeWorkspaceAvailable()) {
        return Response.json({ error: "native workspace is not ready" }, { status: 503 })
      }
      if (!opencode || opencode.exitCode !== null) {
        return Response.json({ error: "OpenCode is not running" }, { status: 503 })
      }
      const target = `http://127.0.0.1:${OPENCODE_PORT}${url.pathname.slice("/opencode".length)}${url.search}`
      const headers = new Headers(request.headers)
      headers.set("authorization", basicAuth(opencodePassword).authorization ?? "")
      headers.delete("host")
      headers.delete("content-length")
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        signal: request.signal,
        redirect: "manual",
      })
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: (() => {
          // Fetch decodes the body; keep the client from re-decoding it.
          const headers = new Headers(upstream.headers)
          headers.delete("content-encoding")
          headers.delete("content-length")
          return headers
        })(),
      })
    }

    if (url.pathname === "/configure" && request.method === "POST") {
      return enqueueLifecycle(async () => {
      const settings = (await request.json()) as {
        workspaceRepo?: string
        workspaceBranch?: string
        model?: string
        permissions?: PermissionLists
        githubToken?: string
      }
      if (settings.workspaceRepo) workspaceRepo = settings.workspaceRepo
      if (settings.workspaceBranch) workspaceBranch = settings.workspaceBranch
      if (typeof settings.githubToken === "string") githubToken = settings.githubToken
      writeOpencodeConfig(settings.model, settings.permissions)
      return Response.json({ ok: true })
      })
    }

    if (url.pathname === "/status") {
      return Response.json({
        initialized: initialized(),
        running: opencode?.exitCode === null,
        s3: nativeWorkspaceAvailable(),
        stateCheckpoint: true,
      })
    }

    if (url.pathname === "/start") {
      return enqueueLifecycle(startRuntime)
    }

    if (url.pathname === "/restore" && request.method === "POST") {
      return enqueueLifecycle(async () => {
      const part = url.searchParams.get("part") ?? "workspace"
      if (part !== "workspace" && part !== "state") {
        return Response.json({ error: "unknown restore part" }, { status: 400 })
      }
      const tmp = `/tmp/restore-${part}.tar.gz`
      if (!request.body) return Response.json({ error: "empty restore body" }, { status: 400 })
      await drainToFile(request.body, tmp)
      try {
        await assertSafeArchive(tmp)
      } catch {
        rmSync(tmp, { force: true })
        return Response.json({ error: "archive rejected" }, { status: 400 })
      }
      // A failed restore must not leave the marker behind, or the next start
      // will believe the half-restored root is complete.
      rmSync(MARKER, { force: true })
      // Stop the processes that hold the root before replacing it.
      if (opencode) {
        await stopChild(opencode, "OpenCode")
        opencode = undefined
        opencodePassword = ""
        opencodeGeneration = undefined
        opencodeEventPersistence = false
      }
      if (stow) {
        await stopChild(stow, "native workspace")
        stow = undefined
      }
      stowReadiness = undefined
      workspaceIdentity = undefined
      rmSync(STOW_READY, { force: true })
      if (part === "workspace") {
        rmSync(WORKSPACE, { recursive: true, force: true })
        mkdirSync(WORKSPACE, { recursive: true })
        chown(WORKSPACE, AGENT_UID, AGENT_GID)
        const code = await run(["tar", "xzf", tmp, "-C", WORKSPACE])
        rmSync(tmp, { force: true })
        if (code !== 0) return Response.json({ error: "restore failed" }, { status: 500 })
        fixWorkspacePermissions()
        try {
          await assertWorkspaceLinks()
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 500 },
          )
        }
      } else {
        rmSync(STATE_ROOT, { recursive: true, force: true })
        mkdirSync(STATE_ROOT, { recursive: true })
        // The marker belongs only to a complete split restore. Native state
        // identity and registry are restored from the state archive.
        // Extract as the agent, and let it own the root temporarily so tar can
        // apply the archive's metadata to `.` without a permission error.
        chown(STATE_ROOT, AGENT_UID, AGENT_GID)
        const code = await run(["tar", "xzf", tmp, "-C", STATE_ROOT])
        rmSync(tmp, { force: true })
        if (code !== 0) {
          rmSync(MARKER, { force: true })
          return Response.json({ error: "restore failed" }, { status: 500 })
        }
        fixStatePermissions()
        try {
          await assertStateLinks()
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 500 },
          )
        }
      }
      // A split restore is only complete once the state part is restored (or
      // the caller says there is no state part), so a failure in between keeps
      // `initialized` false and the restore is retried.
      const explicitPart = url.searchParams.has("part")
      const final = !explicitPart || part === "state" || url.searchParams.get("final") === "1"
      if (final) {
        mkdirSync(STATE_ROOT, { recursive: true })
        writeFileSync(MARKER, new Date().toISOString())
      }
      return Response.json({ ok: true, part })
      })
    }

    if (url.pathname === "/checkpoint") {
      return enqueueLifecycle(async () => {
      const part = url.searchParams.get("part") ?? "workspace"
      if (part === "workspace") {
        // Check identity before archiving: a no-op turn must not cost a write.
        const fingerprint = await workspaceFingerprint()
        if (url.searchParams.get("since") === fingerprint) {
          return new Response(null, { status: 204, headers: SPLIT_HEADER })
        }
        // Archive to a file so the response carries a content length. R2 will
        // not accept an unknown-length stream.
        const archive = "/tmp/cf-opencode-workspace.tar.gz"
        rmSync(archive, { force: true })
        const code = await archiveWorkspace(archive, WORKSPACE)
        if (code !== 0) return Response.json({ error: "checkpoint failed" }, { status: 500 })
        const file = Bun.file(archive)
        return new Response(file, {
          headers: {
            "content-type": "application/gzip",
            "content-length": String(file.size),
            "x-workspace-fingerprint": fingerprint,
            ...SPLIT_HEADER,
          },
        })
      }
      if (part === "state") {
        const fingerprint = stateFingerprint()
        if (url.searchParams.get("since") === fingerprint) {
          return new Response(null, { status: 204, headers: { "x-state-fingerprint": fingerprint } })
        }
        if (!existsSync(STATE_ROOT) || stateFiles().length === 0) {
          return Response.json({ error: "no state to checkpoint" }, { status: 404 })
        }
        const archive = "/tmp/cf-opencode-state.tar.gz"
        const code = await archiveState(archive)
        if (code !== 0) return Response.json({ error: "state checkpoint failed" }, { status: 500 })
        const file = Bun.file(archive)
        return new Response(file, {
          headers: {
            "content-type": "application/gzip",
            "content-length": String(file.size),
            "x-state-fingerprint": fingerprint,
          },
        })
      }
      return Response.json({ error: "unknown checkpoint part" }, { status: 400 })
      })
    }

    // ---- onboarding: OpenCode provider integrations -------------------------

    if (url.pathname === "/integrations" && request.method === "GET") {
      return opencodeFetch("/api/integration")
    }

    if (url.pathname === "/models" && request.method === "GET") {
      return opencodeFetch("/api/model")
    }

    if (url.pathname === "/usage" && request.method === "GET") {
      const query = url.searchParams.toString()
      return opencodeFetch(`/api/experimental/session/stats${query ? `?${query}` : ""}`)
    }

    const connect = url.pathname.match(/^\/integrations\/([^/]+)\/connect\/(oauth|key)$/)
    if (connect && request.method === "POST") {
      const [, integrationID, method] = connect
      const body = await request.json().catch(() => ({}))
      return opencodeFetch(`/api/integration/${encodeURIComponent(integrationID!)}/connect/${method}`, {
        method: "POST",
        body,
      })
    }

    const attempt = url.pathname.match(/^\/integrations\/([^/]+)\/connect\/oauth\/([^/]+)(\/complete)?$/)
    if (attempt) {
      const [, integrationID, attemptID, complete] = attempt
      const base = `/api/integration/${encodeURIComponent(integrationID!)}/connect/oauth/${encodeURIComponent(attemptID!)}`
      if (complete && request.method === "POST") {
        const body = await request.json().catch(() => ({}))
        return opencodeFetch(`${base}/complete`, { method: "POST", body })
      }
      if (!complete && request.method === "GET") return opencodeFetch(base)
      if (!complete && request.method === "DELETE") return opencodeFetch(base, { method: "DELETE" })
    }

    // ---- onboarding: account state (config + provider credentials) ----------

    if (url.pathname === "/seed-state" && request.method === "POST") {
      return enqueueLifecycle(async () => {
      const tmp = "/tmp/seed-state.tar.gz"
      if (!request.body) return Response.json({ error: "empty seed body" }, { status: 400 })
      const canSeed = () =>
        (!opencode || opencode.exitCode !== null) &&
        (!stow || stow.exitCode !== null) &&
        !initialized() &&
        !existsSync(`${STATE_ROOT}/stow/identity.json`)
      if (!canSeed()) return Response.json({ error: "account seed is only allowed for a fresh stopped workspace" }, { status: 409 })
      await drainToFile(request.body, tmp)
      let members: string
      try {
        members = await assertSafeArchive(tmp)
      } catch {
        rmSync(tmp, { force: true })
        return Response.json({ error: "archive rejected" }, { status: 400 })
      }
      if (accountSeedContainsStow(members)) {
        rmSync(tmp, { force: true })
        return Response.json({ error: "account seed contains conversation workspace identity" }, { status: 400 })
      }
      // State may have changed while the request body was being streamed.
      if (!canSeed()) {
        rmSync(tmp, { force: true })
        return Response.json({ error: "account seed is only allowed for a fresh stopped workspace" }, { status: 409 })
      }
      mkdirSync(STATE_ROOT, { recursive: true })
      // Temporary agent ownership lets tar set metadata on `.`.
      chown(STATE_ROOT, AGENT_UID, AGENT_GID)
      // Older account archives may include the initialized marker. It only
      // belongs to a restored conversation and must never make a seeded
      // workspace appear initialized before its own Stow identity is created.
      const code = await run([
        "tar", "xzf", tmp, "-C", STATE_ROOT,
        "--anchored", "--exclude=initialized", "--exclude=./initialized",
      ])
      rmSync(tmp, { force: true })
      if (code !== 0) return Response.json({ error: "seed failed" }, { status: 500 })
      // Do not let unusual normalized archive spellings install a marker that
      // makes this freshly seeded account appear to have a native Workspace.
      rmSync(MARKER, { force: true })
      fixStatePermissions()
      try {
        await assertStateLinks()
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        )
      }
      return Response.json({ ok: true })
      })
    }

    if (url.pathname === "/state-checkpoint" && request.method === "GET") {
      return enqueueLifecycle(async () => {
      // Pause OpenCode so the credential database is a consistent snapshot.
      if (opencode) {
        await stopChild(opencode, "OpenCode")
        opencode = undefined
        opencodePassword = ""
        opencodeGeneration = undefined
        opencodeEventPersistence = false
      }
      if (!existsSync(STATE_ROOT) || stateFiles().length === 0) {
        return Response.json({ error: "no account state yet" }, { status: 404 })
      }
      const archive = "/tmp/cf-opencode-account-state.tar.gz"
      const code = await archiveState(archive, true)
      if (code !== 0) return Response.json({ error: "state checkpoint failed" }, { status: 500 })
      const file = Bun.file(archive)
      return new Response(file, {
        headers: { "content-type": "application/gzip", "content-length": String(file.size) },
      })
      })
    }

    return new Response("not found", { status: 404 })
  },
})

if (import.meta.main) console.log(`control server listening on :${CONTROL_PORT}`)
