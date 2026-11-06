/**
 * Container control server. The Durable Object talks to this on :4001 so the
 * container never needs R2 credentials: the DO streams checkpoints to R2.
 *
 * Local S3 ("hot"): stow-s3 serves the workspace as an S3 endpoint on :9000,
 * so agents and tools can use s3:// against the same bytes they edit on disk.
 * R2 ("cold"): checkpoints are tar.gz streams the DO stores in R2.
 *
 *   GET  /health      liveness
 *   GET  /status      { initialized, running, s3 }
 *   POST /start       start stow-s3 and opencode serve, wait until ready
 *   POST /restore     body = tar.gz, replaces /workspace
 *   GET  /checkpoint  tar.gz stream of /workspace (deps excluded)
 */

import { spawn } from "bun"
import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { buildPermissionRules, type PermissionLists } from "./src/permissions"

const WORKSPACE = process.env.WORKSPACE ?? "/workspace"
const STATE_DIR = process.env.XDG_DATA_HOME ?? `${WORKSPACE}/.state/data`
const STOW_DIR = process.env.STOW_DIR ?? `${WORKSPACE}/.stow`
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT ?? 4000)
const CONTROL_PORT = Number(process.env.CONTROL_PORT ?? 4001)
const STOW_PORT = Number(process.env.STOW_PORT ?? 9000)
const STOW_ACCESS_KEY = process.env.STOW_ACCESS_KEY ?? "stow"
const STOW_SECRET_KEY = process.env.STOW_SECRET_KEY ?? "stow-secret"
let workspaceRepo = process.env.WORKSPACE_REPO ?? ""
let workspaceBranch = process.env.WORKSPACE_BRANCH ?? "main"
const MARKER = `${WORKSPACE}/.harness-initialized`

let opencode: ReturnType<typeof spawn> | undefined
let stow: ReturnType<typeof spawn> | undefined
let opencodePassword = ""

function basicAuth(password: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
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
    { cwd: WORKSPACE, env: process.env, stdout: "inherit", stderr: "inherit" },
  )
  await waitFor(`http://127.0.0.1:${STOW_PORT}/_stow/health`)
}

async function startOpencode(): Promise<void> {
  if (opencode && opencode.exitCode === null) return
  if (opencode) opencode = undefined
  // OpenCode v2 requires a password. Use the configured one if present so the
  // Worker and container can share it; otherwise generate a per-start secret.
  opencodePassword = process.env.OPENCODE_PASSWORD ?? randomBytes(32).toString("base64url")
  opencode = spawn(["opencode", "serve", "--hostname", "0.0.0.0", "--port", String(OPENCODE_PORT)], {
    cwd: WORKSPACE,
    env: {
      ...process.env,
      OPENCODE_PASSWORD: opencodePassword,
      OPENCODE_SERVER_PASSWORD: opencodePassword,
      S3_ENDPOINT: `http://127.0.0.1:${STOW_PORT}`,
      S3_ACCESS_KEY_ID: STOW_ACCESS_KEY,
      S3_SECRET_ACCESS_KEY: STOW_SECRET_KEY,
    },
    stdout: "inherit",
    stderr: "inherit",
  })
  await waitFor(`http://127.0.0.1:${OPENCODE_PORT}/api/info`, 150, basicAuth(opencodePassword))
}

function writeOpencodeConfig(model?: string, permissions?: PermissionLists) {
  const dir = `${process.env.XDG_CONFIG_HOME ?? `${WORKSPACE}/.state/config`}/opencode`
  mkdirSync(dir, { recursive: true })
  const config = {
    $schema: "https://opencode.ai/config.json",
    ...(model ? { model } : {}),
    permissions: buildPermissionRules(permissions),
  }
  writeFileSync(`${dir}/opencode.json`, JSON.stringify(config, null, 2))
}

function initialized(): boolean {
  return existsSync(`${WORKSPACE}/.git`) || existsSync(MARKER)
}

async function run(command: string[]): Promise<number> {
  const proc = spawn(command, { stdout: "inherit", stderr: "inherit" })
  return proc.exited
}

async function runCapture(command: string[]): Promise<string> {
  const proc = spawn(command, { stdout: "pipe", stderr: "ignore" })
  const text = await new Response(proc.stdout as ReadableStream).text()
  await proc.exited
  return text
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

if (import.meta.main) Bun.serve({
  port: CONTROL_PORT,
  idleTimeout: 120,
  async fetch(request) {
    const url = new URL(request.url)

    if (url.pathname === "/health") return Response.json({ ok: true })

    if (url.pathname === "/configure" && request.method === "POST") {
      const settings = (await request.json()) as {
        workspaceRepo?: string
        workspaceBranch?: string
        model?: string
        permissions?: PermissionLists
      }
      if (settings.workspaceRepo) workspaceRepo = settings.workspaceRepo
      if (settings.workspaceBranch) workspaceBranch = settings.workspaceBranch
      writeOpencodeConfig(settings.model, settings.permissions)
      return Response.json({ ok: true })
    }

    if (url.pathname === "/status") {
      return Response.json({
        initialized: initialized(),
        running: opencode?.exitCode === null,
        s3: stow?.exitCode === null,
      })
    }

    if (url.pathname === "/start") {
      if (!initialized() && workspaceRepo) {
        // /workspace already contains .state from the entrypoint, so clone
        // beside it and merge the repository in.
        const tmp = "/tmp/workspace-clone"
        rmSync(tmp, { recursive: true, force: true })
        const code = await run(["git", "clone", "--depth", "1", "--branch", workspaceBranch, workspaceRepo, tmp])
        if (code !== 0) return Response.json({ error: "workspace clone failed" }, { status: 500 })
        const copied = await run(["cp", "-a", `${tmp}/.`, WORKSPACE])
        rmSync(tmp, { recursive: true, force: true })
        if (copied !== 0) return Response.json({ error: "workspace copy failed" }, { status: 500 })
      }
      await startStow()
      await startOpencode()
      return Response.json({ ok: true, password: opencodePassword })
    }

    if (url.pathname === "/restore" && request.method === "POST") {
      const tmp = "/tmp/restore.tar.gz"
      if (!request.body) return Response.json({ error: "empty restore body" }, { status: 400 })
      // Stream the upload to disk. Bun.write with a Response-wrapped stream can
      // wait forever, so drain the request body into a file sink directly.
      const writer = Bun.file(tmp).writer()
      const reader = request.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          writer.write(value)
        }
      } finally {
        await writer.end()
      }
      // Stop the processes that hold the workspace before replacing it.
      if (opencode) {
        opencode.kill()
        await opencode.exited.catch(() => {})
        opencode = undefined
        opencodePassword = ""
      }
      if (stow) {
        stow.kill()
        await stow.exited.catch(() => {})
        stow = undefined
      }
      rmSync(WORKSPACE, { recursive: true, force: true })
      mkdirSync(WORKSPACE, { recursive: true })
      const code = await run(["tar", "xzf", tmp, "-C", WORKSPACE])
      if (code !== 0) return Response.json({ error: "restore failed" }, { status: 500 })
      writeFileSync(MARKER, new Date().toISOString())
      return Response.json({ ok: true })
    }

    if (url.pathname === "/checkpoint") {
      // Check identity before pausing OpenCode: a no-op turn must not cost a
      // restart. Only an actual archive needs a consistent, paused workspace.
      const fingerprint = await workspaceFingerprint()
      if (url.searchParams.get("since") === fingerprint) {
        return new Response(null, { status: 204 })
      }

      // Pause OpenCode so the archive is a consistent snapshot; /start resumes it.
      if (opencode) {
        opencode.kill()
        await opencode.exited.catch(() => {})
        opencode = undefined
        opencodePassword = ""
      }
      try {
        await run(["sqlite3", `${STATE_DIR}/opencode.db`, "PRAGMA wal_checkpoint(TRUNCATE)"])
      } catch {
        /* DB may not exist yet */
      }
      // Archive to a file so the response carries a content length. R2 will
      // not accept an unknown-length stream.
      const archive = "/tmp/cf-opencode-checkpoint.tar.gz"
      const code = await run(["tar", "czf", archive, "-C", WORKSPACE, "--exclude", "node_modules", "."])
      if (code !== 0) return Response.json({ error: "checkpoint failed" }, { status: 500 })
      const file = Bun.file(archive)
      return new Response(file, {
        headers: {
          "content-type": "application/gzip",
          "content-length": String(file.size),
          "x-workspace-fingerprint": fingerprint,
        },
      })
    }

    return new Response("not found", { status: 404 })
  },
})

if (import.meta.main) console.log(`control server listening on :${CONTROL_PORT} (local S3 on :${STOW_PORT})`)
