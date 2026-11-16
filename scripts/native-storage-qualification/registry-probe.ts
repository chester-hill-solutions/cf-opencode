import { mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { digest } from "./s3-probe-client"
import type { CaseResult } from "./matrix"

/** Root-only, fixed fault injection in the already guarded disposable namespace. */
export async function registryFaults(): Promise<{ rows: CaseResult[]; originalRestored: boolean }> {
  if (process.getuid?.() !== 0 || !process.env.C2_CONTROL_TOKEN ||
    !existsSync("/workspace/.qualification/matrix.json")) throw new Error("disposable registry fixture required")
  const scratch = "/tmp/c2-registry-faults"
  if (existsSync(scratch)) throw new Error("registry fault fixture was already used")
  mkdirSync(scratch, { mode: 0o700 })
  const identityPath = "/var/lib/aboiteau/state/stow/identity.json"
  const originalID = JSON.parse(readFileSync(identityPath, "utf8")).workspace_id
  const rows: CaseResult[] = []
  const control = (path: string, method = "GET", body?: ArrayBuffer) => fetch(`http://127.0.0.1:4001${path}`, {
    method, headers: { authorization: `Bearer ${process.env.C2_CONTROL_TOKEN}` },
    ...(body ? { body } : {}), signal: AbortSignal.timeout(60_000), redirect: "manual",
  })
  const command = (args: string[]) => {
    if (Bun.spawnSync(args, { stdout: "ignore", stderr: "ignore", timeout: 15_000 }).exitCode !== 0) throw new Error("fixed archive operation failed")
  }
  const tree = (path: string): string => digest(readdirSync(path).sort().map((name) => {
    const full = join(path, name)
    const stat = lstatSync(full)
    if (stat.isSymbolicLink()) throw new Error("unexpected fixture link")
    return name + ":" + (stat.isDirectory() ? tree(full) : digest(readFileSync(full)))
  }).join("\0"))
  const archive = async (part: "workspace" | "state"): Promise<Uint8Array<ArrayBuffer>> => {
  const archiveResponse = await control(`/checkpoint?part=${part}`)
  if (!archiveResponse.ok || !archiveResponse.body) throw new Error("state fixture archive unavailable")
  const reader = archiveResponse.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    bytes += next.value.byteLength
    if (bytes > 32 * 1024 * 1024) { await reader.cancel(); throw new Error("state fixture exceeds bound") }
    chunks.push(next.value)
  }
  const good = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) { good.set(chunk, offset); offset += chunk.byteLength }
  return good
  }
  const workspaceBefore = tree("/workspace")
  const goodWorkspace = await archive("workspace")
  const good = await archive("state")
  await Bun.write(`${scratch}/good.tar.gz`, good)
  const restoreGood = async () => {
    for (const [part, bytes] of [["workspace", goodWorkspace], ["state", good]] as const) {
      const restored = await control(`/restore?part=${part}`, "POST", bytes.buffer)
      await restored.body?.cancel()
      if (!restored.ok) throw new Error("original fixture restore failed")
    }
    if (tree("/workspace") !== workspaceBefore) throw new Error("original workspace changed")
  }
  let originalRestored = false
  try {
    for (const fault of ["missing", "mismatch"] as const) {
      const id = fault === "missing" ? "registry-missing" : "registry-mismatch"
      try {
        await restoreGood()
        const dir = `${scratch}/${fault}`
        mkdirSync(dir)
        command(["tar", "xzf", `${scratch}/good.tar.gz`, "-C", dir])
        if (!existsSync(`${dir}/stow/registry`)) throw new Error("baseline registry missing")
        if (fault === "missing") rmSync(`${dir}/stow/registry`, { recursive: true })
        else {
          const identity = JSON.parse(readFileSync(`${dir}/stow/identity.json`, "utf8"))
          identity.workspace_id = "ws_matrix_deliberately_wrong"
          writeFileSync(`${dir}/stow/identity.json`, JSON.stringify(identity))
        }
        const badArchive = `${scratch}/${fault}.tar.gz`
        command(["tar", "czf", badArchive, "-C", dir, "."])
        const restored = await control("/restore?part=state", "POST", await Bun.file(badArchive).arrayBuffer())
        await restored.body?.cancel()
        if (!restored.ok) throw new Error("fixed fault restore failed")
        const before = tree("/workspace")
        const registryBefore = tree("/var/lib/aboiteau/state/stow")
        const started = await control("/start", "POST")
        await started.body?.cancel()
        const status = await (await control("/status")).json() as { running?: boolean; s3?: boolean }
        const refused = [409, 503].includes(started.status) && status.running === false && status.s3 === false &&
          before === tree("/workspace") && registryBefore === tree("/var/lib/aboiteau/state/stow")
        rows.push({ id, disposition: refused ? "refused_before_mutation" : "failed",
          reason: refused ? "registry_refused" : "registry_started_or_mutated", httpStatus: started.status })
      } catch { rows.push({ id, disposition: "failed", reason: "request_failed" }) }
    }
  } finally {
    try {
      await restoreGood()
      const started = await control("/start", "POST")
      await started.body?.cancel()
      originalRestored = started.ok && tree("/workspace") === workspaceBefore && JSON.parse(readFileSync(identityPath, "utf8")).workspace_id === originalID
    } catch { originalRestored = false }
  }
  if (!originalRestored) return { originalRestored, rows: rows.map((row) => ({ ...row, disposition: "failed", reason: "fixture_restore_failed" })) }
  return { rows, originalRestored }
}
