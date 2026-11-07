/**
 * Container control server. The Durable Object talks to this on :4001 so the
 * container never needs R2 credentials: the DO streams checkpoints to R2.
 *
 * Local S3 ("hot"): stow-s3 serves the workspace as an S3 endpoint on :9000,
 * so agents and tools can use s3:// against the same bytes they edit on disk.
 * R2 ("cold"): checkpoints are tar.gz streams the DO stores in R2.
 *
 * Snapshots (durable_object policy): the DO captures the writable root on
 * recycle and restores it on the next start. Image-bound, so a deploy that
 * changes the image makes the previous snapshot unusable.
 *
 * Trust split: this process runs as root; OpenCode, stow-s3 and every tar/copy
 * that touches user files run as `agent`. Harness state lives outside the
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
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { relative } from "node:path"
import { buildPermissionRules, type PermissionLists } from "./src/permissions"
import { bearerAuthorized } from "./src/control-auth"
import { assertSafeArchiveMembers } from "./src/tar"

const WORKSPACE = process.env.WORKSPACE ?? "/workspace"
/** Harness state: OpenCode config, credentials and database. Never the repo. */
const STATE_ROOT = process.env.ABOITEAU_STATE_DIR ?? "/var/lib/aboiteau/state"
const STATE_DIR = process.env.XDG_DATA_HOME ?? `${STATE_ROOT}/data`
const STOW_DIR = process.env.STOW_DIR ?? `${WORKSPACE}/.stow`
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT ?? 4000)
const CONTROL_PORT = Number(process.env.CONTROL_PORT ?? 4001)
const STOW_PORT = Number(process.env.STOW_PORT ?? 9000)
const STOW_ACCESS_KEY = process.env.STOW_ACCESS_KEY ?? "stow"
const STOW_SECRET_KEY = process.env.STOW_SECRET_KEY ?? "stow-secret"
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
let stow: ReturnType<typeof spawn> | undefined
let opencodePassword = ""

function basicAuth(password: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
}

/**
 * OpenCode's own HTTP API, for onboarding: provider integrations and the live
 * model catalogue. The DO is the only caller; never exposed publicly.
 */
async function opencodeFetch(path: string, init?: { method?: string; body?: unknown }): Promise<Response> {
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

async function waitFor(url: string, attempts = 150, headers?: Record<string, string>): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url, { headers })
      if (res.ok) return
    } catch {
      /* not ready */
    }
    await Bun.sleep(200)
  }
  throw new Error(`${url} did not become ready`)
}

async function startStow(): Promise<void> {
  if (stow && stow.exitCode === null) return
  if (stow) stow = undefined
  mkdirSync(STOW_DIR, { recursive: true })
  stow = spawn(
    [
      "stow-s3",
      "serve",
      "--port",
      String(STOW_PORT),
      "--host",
      "127.0.0.1",
      "--data-dir",
      STOW_DIR,
      "--backend",
      "filesystem",
      "--access-key",
      STOW_ACCESS_KEY,
      "--secret-key",
      STOW_SECRET_KEY,
    ],
    { cwd: WORKSPACE, env: process.env, uid: AGENT_UID, gid: AGENT_GID, stdout: "inherit", stderr: "inherit" },
  )
  await waitFor(`http://127.0.0.1:${STOW_PORT}/_stow/health`)
}

async function startOpencode(): Promise<void> {
  if (opencode && opencode.exitCode === null) return
  if (opencode) opencode = undefined
  // OpenCode v2 requires a password. Use the configured one if present so the
  // Worker and container can share it; otherwise generate a per-start secret.
  opencodePassword = process.env.OPENCODE_PASSWORD ?? randomBytes(32).toString("base64url")
  opencode = spawn(
    ["opencode", "serve", "--hostname", "127.0.0.1", "--port", String(OPENCODE_PORT)],
    {
      cwd: WORKSPACE,
      env: buildOpencodeEnv(process.env, opencodePassword),
      uid: AGENT_UID,
      gid: AGENT_GID,
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  await waitFor(`http://127.0.0.1:${OPENCODE_PORT}/api/info`, 300, basicAuth(opencodePassword))
}

/**
 * Environment handed to OpenCode. Explicitly allowlisted: the agent's tools
 * inherit this, so the control-plane token and unrelated Worker secrets must
 * never be included.
 */
export function buildOpencodeEnv(
  source: Record<string, string | undefined>,
  password: string,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: source.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: source.HOME ?? STATE_ROOT,
    WORKSPACE,
    XDG_DATA_HOME: source.XDG_DATA_HOME ?? `${STATE_ROOT}/data`,
    XDG_CONFIG_HOME: source.XDG_CONFIG_HOME ?? `${STATE_ROOT}/config`,
    XDG_CACHE_HOME: source.XDG_CACHE_HOME ?? `${STATE_ROOT}/cache`,
    OPENCODE_PASSWORD: password,
    OPENCODE_SERVER_PASSWORD: password,
    S3_ENDPOINT: `http://127.0.0.1:${STOW_PORT}`,
    S3_ACCESS_KEY_ID: STOW_ACCESS_KEY,
    S3_SECRET_ACCESS_KEY: STOW_SECRET_KEY,
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
    permissions: buildPermissionRules(permissions),
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
 * checkpoint and silently lose the edit. Hash the diff and untracked contents.
 */
export async function workspaceFingerprint(workspace = WORKSPACE): Promise<string> {
  if (existsSync(`${workspace}/.git`)) {
    const head = await runCapture(["git", "-C", workspace, "rev-parse", "HEAD"])
    const status = await runCapture(["git", "-C", workspace, "status", "--porcelain"])
    const diff = await runCapture(["git", "-C", workspace, "diff", "HEAD", "--binary", "--no-color"])
    const untracked = await runCapture(["git", "-C", workspace, "ls-files", "--others", "--exclude-standard", "-z"])
    const files: string[] = []
    for (const path of untracked.split("\0").filter(Boolean).sort()) {
      // Derived harness data: the source diff already covers workspace edits.
      if (path.startsWith(".stow/") || path.startsWith("node_modules/")) continue
      const hash = await runCapture(["git", "-C", workspace, "hash-object", "--", path])
      files.push(`${path}:${hash.trim()}`)
    }
    return createHash("sha256").update(`${head}\n${status}\n${diff}\n${files.join("\n")}`).digest("hex")
  }
  const entries = existsSync(workspace) ? readdirSync(workspace).sort().join(",") : ""
  return createHash("sha256").update(`nogit:${entries}`).digest("hex")
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
async function assertSafeArchive(path: string): Promise<void> {
  const text = await runCapture(["tar", "tzf", path])
  assertSafeArchiveMembers(text)
}

function chown(path: string, uid: number, gid: number): void {
  try {
    chownSync(path, uid, gid)
  } catch {
    /* best effort: the image may already have the right owner */
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
 * State is root-owned and group-writable by the agent, so OpenCode can write its
 * database but the repo cannot rewrite harness config or credentials.
 */
function fixStatePermissions(): void {
  if (!existsSync(STATE_ROOT)) return
  chown(STATE_ROOT, 0, AGENT_GID)
  chmodSync(STATE_ROOT, 0o770)
  for (const file of stateFiles()) {
    chown(file, 0, AGENT_GID)
    try {
      const stat = statSync(file)
      chmodSync(file, stat.isDirectory() ? 0o770 : 0o660)
    } catch {
      /* racing removal */
    }
  }
}

function initialized(): boolean {
  // The marker lives in the state root, outside the workspace. A repository's
  // `.git` is not an initialization signal: it exists as soon as the workspace
  // half of a split restore lands, before the state half.
  return existsSync(MARKER)
}

async function run(command: string[], asAgent = true): Promise<number> {
  const proc = spawn(command, {
    ...(asAgent ? { uid: AGENT_UID, gid: AGENT_GID } : {}),
    stdout: "inherit",
    stderr: "inherit",
  })
  return proc.exited
}

async function runCapture(command: string[], asAgent = true): Promise<string> {
  const proc = spawn(command, {
    ...(asAgent ? { uid: AGENT_UID, gid: AGENT_GID } : {}),
    stdout: "pipe",
    stderr: "ignore",
  })
  const text = await new Response(proc.stdout as ReadableStream).text()
  await proc.exited
  return text
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
 * Archive harness state with a consistent SQLite database. The live DB files
 * are excluded and replaced by `.backup` output, so OpenCode can keep running.
 */
async function archiveState(archive: string): Promise<number> {
  // Remove a stale archive from an older root-owned image before writing as
  // the agent user.
  rmSync(archive, { force: true })
  const backupDir = "/tmp/cf-opencode-state-backup"
  rmSync(backupDir, { recursive: true, force: true })
  mkdirSync(backupDir, { recursive: true })
  chown(backupDir, AGENT_UID, AGENT_GID)
  const database = `${STATE_DIR}/opencode.db`
  const relativeDatabase = relative(STATE_ROOT, database)
  const backup = `${backupDir}/opencode.db`
  let copied = false
  if (existsSync(database)) {
    const code = await run(["sqlite3", database, `.backup '${backup}'`])
    copied = code === 0 && existsSync(backup)
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
    "--exclude",
    `${relativeDatabase}*`,
    ".",
  ]
  if (copied) {
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
    }

    if (url.pathname === "/status") {
      return Response.json({
        initialized: initialized(),
        running: opencode?.exitCode === null,
        s3: stow?.exitCode === null,
        stateCheckpoint: true,
      })
    }

    if (url.pathname === "/start") {
      if (!initialized() && workspaceRepo) {
        // Clone beside the workspace and merge, so a stale `.stow` or marker
        // cannot make `git clone` refuse a non-empty directory.
        const tmp = "/tmp/workspace-clone"
        rmSync(tmp, { recursive: true, force: true })
        const clone = spawn(["git", ...cloneArgs(workspaceRepo), tmp], {
          uid: AGENT_UID,
          gid: AGENT_GID,
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
        const copied = await run(["cp", "-a", `${tmp}/.`, WORKSPACE])
        rmSync(tmp, { recursive: true, force: true })
        if (copied !== 0) return Response.json({ error: "workspace copy failed" }, { status: 500 })
        fixWorkspacePermissions()
      }
      await startStow()
      await startOpencode()
      // Mark the container initialized only after both processes are up, so a
      // failed start is retried instead of being treated as an empty workspace.
      mkdirSync(STATE_ROOT, { recursive: true })
      writeFileSync(MARKER, new Date().toISOString())
      // The OpenCode password never leaves this process; the DO uses the
      // token-authenticated /opencode/* proxy instead.
      return Response.json({ ok: true })
    }

    if (url.pathname === "/restore" && request.method === "POST") {
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
      // Stop the processes that hold the root before replacing it.
      if (opencode) {
        opencode.kill()
        await opencode.exited.catch(() => {})
        opencode = undefined
        opencodePassword = ""
      }
      if (part === "workspace") {
        if (stow) {
          stow.kill()
          await stow.exited.catch(() => {})
          stow = undefined
        }
        rmSync(WORKSPACE, { recursive: true, force: true })
        mkdirSync(WORKSPACE, { recursive: true })
        chown(WORKSPACE, AGENT_UID, AGENT_GID)
        const code = await run(["tar", "xzf", tmp, "-C", WORKSPACE])
        rmSync(tmp, { force: true })
        if (code !== 0) return Response.json({ error: "restore failed" }, { status: 500 })
        // Legacy archives carried `.state` inside the workspace. Move it out
        // once, so a migration keeps the account credentials.
        const legacy = `${WORKSPACE}/.state`
        if (existsSync(legacy)) {
          mkdirSync(STATE_ROOT, { recursive: true })
          chown(STATE_ROOT, 0, AGENT_GID)
          chmodSync(STATE_ROOT, 0o770)
          await run(["cp", "-a", `${legacy}/.`, STATE_ROOT])
          rmSync(legacy, { recursive: true, force: true })
          fixStatePermissions()
        }
        fixWorkspacePermissions()
      } else {
        rmSync(STATE_ROOT, { recursive: true, force: true })
        mkdirSync(STATE_ROOT, { recursive: true })
        chown(STATE_ROOT, 0, AGENT_GID)
        chmodSync(STATE_ROOT, 0o770)
        const code = await run(["tar", "xzf", tmp, "-C", STATE_ROOT])
        rmSync(tmp, { force: true })
        if (code !== 0) return Response.json({ error: "restore failed" }, { status: 500 })
        fixStatePermissions()
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
    }

    if (url.pathname === "/checkpoint") {
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
        const code = await run([
          "tar",
          "czf",
          archive,
          "-C",
          WORKSPACE,
          "--exclude",
          "node_modules",
          "--exclude",
          ".stow",
          ".",
        ])
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
      const tmp = "/tmp/seed-state.tar.gz"
      if (!request.body) return Response.json({ error: "empty seed body" }, { status: 400 })
      await drainToFile(request.body, tmp)
      try {
        await assertSafeArchive(tmp)
      } catch {
        rmSync(tmp, { force: true })
        return Response.json({ error: "archive rejected" }, { status: 400 })
      }
      mkdirSync(STATE_ROOT, { recursive: true })
      chown(STATE_ROOT, 0, AGENT_GID)
      chmodSync(STATE_ROOT, 0o770)
      const code = await run(["tar", "xzf", tmp, "-C", STATE_ROOT])
      rmSync(tmp, { force: true })
      if (code !== 0) return Response.json({ error: "seed failed" }, { status: 500 })
      fixStatePermissions()
      return Response.json({ ok: true })
    }

    if (url.pathname === "/state-checkpoint" && request.method === "GET") {
      // Pause OpenCode so the credential database is a consistent snapshot.
      if (opencode) {
        opencode.kill()
        await opencode.exited.catch(() => {})
        opencode = undefined
        opencodePassword = ""
      }
      if (!existsSync(STATE_ROOT) || stateFiles().length === 0) {
        return Response.json({ error: "no account state yet" }, { status: 404 })
      }
      const archive = "/tmp/cf-opencode-account-state.tar.gz"
      const code = await archiveState(archive)
      if (code !== 0) return Response.json({ error: "state checkpoint failed" }, { status: 500 })
      const file = Bun.file(archive)
      return new Response(file, {
        headers: { "content-type": "application/gzip", "content-length": String(file.size) },
      })
    }

    return new Response("not found", { status: 404 })
  },
})

if (import.meta.main) console.log(`control server listening on :${CONTROL_PORT} (local S3 on :${STOW_PORT})`)
