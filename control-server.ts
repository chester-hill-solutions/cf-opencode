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
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"

const WORKSPACE = process.env.WORKSPACE ?? "/workspace"
const STATE_DIR = process.env.XDG_DATA_HOME ?? `${WORKSPACE}/.state/data`
const STOW_DIR = process.env.STOW_DIR ?? `${WORKSPACE}/.stow`
const OPENCODE_PORT = Number(process.env.OPENCODE_PORT ?? 4000)
const CONTROL_PORT = Number(process.env.CONTROL_PORT ?? 4001)
const STOW_PORT = Number(process.env.STOW_PORT ?? 9000)
const STOW_ACCESS_KEY = process.env.STOW_ACCESS_KEY ?? "stow"
const STOW_SECRET_KEY = process.env.STOW_SECRET_KEY ?? "stow-secret"
const WORKSPACE_REPO = process.env.WORKSPACE_REPO ?? ""
const MARKER = `${WORKSPACE}/.harness-initialized`

let opencode: ReturnType<typeof spawn> | undefined
let stow: ReturnType<typeof spawn> | undefined

async function waitFor(url: string, attempts = 150): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      /* not ready */
    }
    await Bun.sleep(200)
  }
  throw new Error(`${url} did not become ready`)
}

async function startStow(): Promise<void> {
  if (stow) return
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
  if (opencode) return
  opencode = spawn(["opencode", "serve", "--hostname", "0.0.0.0", "--port", String(OPENCODE_PORT)], {
    cwd: WORKSPACE,
    env: {
      ...process.env,
      S3_ENDPOINT: `http://127.0.0.1:${STOW_PORT}`,
      S3_ACCESS_KEY_ID: STOW_ACCESS_KEY,
      S3_SECRET_ACCESS_KEY: STOW_SECRET_KEY,
    },
    stdout: "inherit",
    stderr: "inherit",
  })
  await waitFor(`http://127.0.0.1:${OPENCODE_PORT}/api/info`)
}

function initialized(): boolean {
  return existsSync(`${WORKSPACE}/.git`) || existsSync(MARKER)
}

async function run(command: string[]): Promise<void> {
  const proc = spawn(command, { stdout: "inherit", stderr: "inherit" })
  await proc.exited
}

Bun.serve({
  port: CONTROL_PORT,
  async fetch(request) {
    const url = new URL(request.url)

    if (url.pathname === "/health") return Response.json({ ok: true })

    if (url.pathname === "/status") {
      return Response.json({ initialized: initialized(), running: Boolean(opencode), s3: Boolean(stow) })
    }

    if (url.pathname === "/start") {
      if (!initialized() && WORKSPACE_REPO) {
        await run(["git", "clone", "--depth", "1", WORKSPACE_REPO, WORKSPACE])
      }
      await startStow()
      await startOpencode()
      return Response.json({ ok: true })
    }

    if (url.pathname === "/restore" && request.method === "POST") {
      const tmp = "/tmp/restore.tar.gz"
      await Bun.write(tmp, new Response(request.body as ReadableStream))
      rmSync(WORKSPACE, { recursive: true, force: true })
      mkdirSync(WORKSPACE, { recursive: true })
      await run(["tar", "xzf", tmp, "-C", WORKSPACE])
      writeFileSync(MARKER, new Date().toISOString())
      return Response.json({ ok: true })
    }

    if (url.pathname === "/checkpoint") {
      // Flush OpenCode's SQLite WAL so the checkpoint is consistent.
      try {
        await run(["sqlite3", `${STATE_DIR}/opencode.db`, "PRAGMA wal_checkpoint(TRUNCATE)"])
      } catch {
        /* DB may not exist yet */
      }
      const tar = spawn(["tar", "czf", "-", "-C", WORKSPACE, "--exclude", "node_modules", "."], {
        stdout: "pipe",
        stderr: "inherit",
      })
      return new Response(tar.stdout as ReadableStream, {
        headers: { "content-type": "application/gzip" },
      })
    }

    return new Response("not found", { status: 404 })
  },
})

console.log(`control server listening on :${CONTROL_PORT} (local S3 on :${STOW_PORT})`)
