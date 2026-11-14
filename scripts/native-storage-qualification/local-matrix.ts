import { mkdtempSync, chmodSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { QUALIFICATION_ARTIFACT } from "./artifact"
import { MATRIX_VERSION, matrixPassed, preparationPassed, projectMatrix, type CaseResult } from "./matrix"
import { projectSafeProbe } from "./qualification-contract"
import { seedSession, verifySession, type SessionFixture } from "./session-probe"
import { makeClient } from "../../src/opencode"
import { digest } from "./s3-probe-client"

// Local evidence only, intentionally outside the green test gate. Exit 2 records
// observed matrix failures. No network, volume mounts, account credentials or R2.
const image = process.env.IMAGE ?? "cf-opencode-metadata-candidate:fa5411b"
const token = "R0-15-SYNTHETIC-CONTROL-TOKEN"
const program = resolve(import.meta.dir, "../../.wrangler/native-storage-preflight/probe.js")
const scratch = mkdtempSync(join(tmpdir(), "aboiteau-matrix-"))
chmodSync(scratch, 0o700)
const frozenProgram = join(scratch, "probe.js")
const names = ["aboiteau-matrix-" + crypto.randomUUID(), "aboiteau-matrix-" + crypto.randomUUID()]
const created = new Set<string>()
const observations: Record<string, unknown> = { observedAt: new Date().toISOString(), matrixVersion: MATRIX_VERSION,
  scope: "local container split-archive recovery; not Cloudflare/R2 or custom-shape qualification",
  conditions: { network: "none", volumes: [], credentials: "synthetic only", providerPrompts: 0 }, image: QUALIFICATION_ARTIFACT.image,
  disposableContainers: names }
let stage = "inspect-image"
function setStage(value: string) { stage = value; console.error(`local matrix: ${value}`) }
let lastSessionRequest: { path: string; status: number } | undefined

function docker(args: string[], required = true, timeout = 120_000): string {
  const result = Bun.spawnSync(["docker", ...args], { stdout: "pipe", stderr: "pipe", timeout })
  if (required && result.exitCode !== 0) {
    observations.lastDockerFailure = { operation: args[0], stage, exitCode: result.exitCode,
      probeCode: result.stderr.toString().match(/fixed recovery probe failed: ([a-z_]+)/)?.[1] ?? null }
    throw new Error(`docker ${args[0]} failed at ${stage} (${result.exitCode})`)
  }
  return result.stdout.toString()
}

function control(name: string, path: string, method = "GET", body?: string, output?: string): { status: number; body: string } {
  const raw = docker(["exec", name, "curl", "--silent", "--show-error", "--max-time", "90",
    "--header", `authorization: Bearer ${token}`, "--header", "content-type: application/json",
    "--request", method, ...(body === undefined ? [] : ["--data-binary", body]),
    ...(output ? ["--output", output] : []), "--write-out", "\n%{http_code}", `http://127.0.0.1:4001${path}`])
  const split = raw.lastIndexOf("\n")
  return { status: Number(raw.slice(split + 1)), body: raw.slice(0, split) }
}

async function start(name: string): Promise<void> {
  // Creation can succeed even when the Docker client times out before replying.
  created.add(name)
  docker(["run", "--pull=never", "--network=none", "--platform", "linux/amd64", "--detach", "--name", name,
    "--env", `CONTROL_TOKEN=${token}`, image])
  for (let attempt = 0; attempt < 100; attempt++) {
    const healthy = docker(["exec", name, "curl", "--silent", "--fail", "--max-time", "1", "http://127.0.0.1:4001/health"], false)
    if (healthy.includes("ok")) return
    await Bun.sleep(100)
  }
  throw new Error("local control server did not become healthy")
}

function installProbe(name: string): void {
  docker(["cp", frozenProgram, `${name}:/tmp/matrix-probe.js`])
  docker(["exec", name, "install", "-d", "-o", "1001", "-g", "1001", "-m", "0700", "/tmp/c2-native-storage-probe"])
  docker(["exec", name, "install", "-o", "1001", "-g", "1001", "-m", "0600",
    "/var/lib/aboiteau/run/stow-ready.json", "/tmp/c2-native-storage-probe/readiness.json"])
}

function probe(name: string, mode: string, root = false): unknown {
  return JSON.parse(docker(["exec", "--user", root ? "0:0" : "1001:1001", name,
    "env", "-u", "CONTROL_TOKEN", "-u", "C2_CONTROL_TOKEN", "HOME=/var/lib/aboiteau/state",
    "XDG_CONFIG_HOME=/var/lib/aboiteau/state/config", "XDG_DATA_HOME=/var/lib/aboiteau/state/data",
    `C2_PROBE_MODE=${mode}`, ...(root ? [`C2_CONTROL_TOKEN=${token}`] : []), "bun", "/tmp/matrix-probe.js"]))
}

function client(name: string): ReturnType<typeof makeClient> {
  return makeClient(async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const result = control(name, "/opencode" + url.pathname + url.search, request.method,
      request.method === "GET" ? undefined : await request.text())
    lastSessionRequest = { path: url.pathname, status: result.status }
    return new Response(result.body, { status: result.status, headers: { "content-type": "application/json" } })
  })
}

try {
  await Bun.write(frozenProgram, await Bun.file(program).arrayBuffer())
  const artifact = JSON.parse(docker(["image", "inspect", image]))[0]
  if (artifact.Os !== "linux" || artifact.Architecture !== "amd64" || !artifact.RepoDigests?.includes(QUALIFICATION_ARTIFACT.image)) throw new Error("local image does not match frozen OCI provenance")
  observations.localImageID = artifact.Id
  observations.probeSHA256 = digest(await Bun.file(frozenProgram).text())
  observations.sourceBase = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim()
  setStage("start-initial")
  await start(names[0])
  if (control(names[0], "/configure", "POST", JSON.stringify({ workspaceRepo: "", model: "" })).status !== 200 ||
    control(names[0], "/start", "POST").status !== 200) throw new Error("local runtime startup failed")
  installProbe(names[0])
  setStage("prepare-matrix")
  const first = projectSafeProbe(probe(names[0], "first"))
  observations.firstProbe = first
  if (!first?.ok) throw new Error("baseline probe failed")
  let session: SessionFixture | undefined
  try { session = await seedSession(client(names[0])) } catch { observations.sessionSeedFailure = lastSessionRequest }
  observations.syntheticSessionCreated = Boolean(session)
  setStage("active-writer-capture")
  const writer = probe(names[0], "writer-start") as { active: boolean; deadline: number }
  const writerStart = Date.now()
  let workspace = control(names[0], "/checkpoint?part=workspace", "GET", undefined, "/tmp/matrix-workspace.tar.gz")
  const attempts = [{ status: workspace.status, durationMs: Date.now() - writerStart }]
  const writerExercised = writer.active && Date.now() < writer.deadline
  let writerMode = "active"
  if (workspace.status !== 200) {
    const status = JSON.parse(control(names[0], "/status").body)
    if (!status.running) throw new Error("refused capture did not retain runtime")
    const stopped = probe(names[0], "writer-stop") as { active: boolean }
    if (stopped.active) throw new Error("writer did not quiesce")
    writerMode = "quiesced"
    const retryStart = Date.now()
    workspace = control(names[0], "/checkpoint?part=workspace", "GET", undefined, "/tmp/matrix-workspace.tar.gz")
    attempts.push({ status: workspace.status, durationMs: Date.now() - retryStart })
  }
  observations.writerCapture = { mode: writerMode, exercised: writerExercised, attempts }
  if (workspace.status !== 200 || control(names[0], "/checkpoint?part=state", "GET", undefined, "/tmp/matrix-state.tar.gz").status !== 200) throw new Error("split capture failed")
  for (const part of ["workspace", "state"]) docker(["cp", `${names[0]}:/tmp/matrix-${part}.tar.gz`, `${scratch}/${part}.tar.gz`])
  docker(["rm", "--force", names[0]])
  created.delete(names[0])
  observations.originalRemovedBeforeRestore = true
  setStage("cold-restore")
  await start(names[1])
  for (const part of ["workspace", "state"]) {
    docker(["cp", `${scratch}/${part}.tar.gz`, `${names[1]}:/tmp/matrix-${part}.tar.gz`])
    if (control(names[1], `/restore?part=${part}`, "POST", `@/tmp/matrix-${part}.tar.gz`).status !== 200) throw new Error("split restore failed")
  }
  if (control(names[1], "/start", "POST").status !== 200) throw new Error("restored runtime failed")
  installProbe(names[1])
  setStage("verify-matrix")
  const restored = projectSafeProbe(probe(names[1], "restored"))
  observations.restoredProbe = restored
  if (!restored?.ok || restored.workspaceID !== first.workspaceID) throw new Error("baseline cold recovery failed")
  if (!writerExercised) restored.matrix = restored.matrix.map((row) => row.id === "background-writer"
    ? { id: row.id, disposition: "not_exercised", reason: "writer_not_started" } : row)
  setStage("registry-faults")
  const registry = probe(names[1], "registry-faults", true) as { rows: unknown; originalRestored: boolean }
  const registryRows = projectMatrix(registry.rows, ["registry-missing", "registry-mismatch"])
  if (!registryRows || !registry.originalRestored) throw new Error("registry fixture was not restored")
  setStage("verify-opencode-history")
  let sessionPreserved = false
  try { sessionPreserved = Boolean(session && await verifySession(client(names[1]), session)) } catch { /* Record failure. */ }
  const sessionRow: CaseResult = { id: "opencode-session", disposition: sessionPreserved ? "preserved" : "failed", reason: sessionPreserved ? "bytes_restored" : "session_mismatch" }
  const matrix = [...restored.matrix, sessionRow, ...registryRows]
  observations.matrix = matrix
  const passed = preparationPassed(first.matrix) && matrixPassed(matrix)
  observations.qualificationPassed = passed
  observations.result = passed ? "LOCAL_MATRIX_PASSED" : "OBSERVED_RECOVERY_FAILURES"
  process.exitCode = passed ? 0 : 2
} catch {
  observations.result = "LOCAL_PROBE_INCOMPLETE"
  observations.failedStage = stage
  observations.qualificationPassed = false
  process.exitCode = 1
} finally {
  let cleanupSucceeded = true
  for (const name of created) if (docker(["rm", "--force", name], false, 15_000).trim() !== name) cleanupSucceeded = false
  rmSync(scratch, { recursive: true, force: true })
  observations.cleanupAttempted = true
  observations.cleanupSucceeded = cleanupSucceeded
  if (!cleanupSucceeded) process.exitCode = 1
  console.log(JSON.stringify(observations, null, 2))
}
