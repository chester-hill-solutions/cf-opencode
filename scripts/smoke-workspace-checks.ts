#!/usr/bin/env bun
/** Actual images/CLI, synthetic API fixture. Never builds, pulls or calls a model. */
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { boundedDockerRunner } from "./workspace-check-docker"
import { parseWorkspaceCheckRequest, parseWorkspaceCheckIntent, parseWorkspaceCheckLocalReceipt, type WorkspaceCheckIntent } from "../src/workspace-check"
import { parseWorkspaceRepositoryReceipt } from "../src/workspace-repository"
import { verifyWorkspaceCheckSnapshot } from "../src/workspace-check-snapshot"

const agentTag = process.env.AGENT_IMAGE, checkerTag = process.env.CHECK_IMAGE
if (!agentTag || !checkerTag) throw new Error("Set existing AGENT_IMAGE and CHECK_IMAGE; this smoke never builds or pulls.")
const runID = randomUUID(), sourceName = "aboiteau-check-smoke-" + runID
const label = "org.aboiteau.check.smoke=" + runID
const controlToken = "synthetic-control-" + randomUUID(), apiToken = "synthetic-api-" + randomUUID()
const directory = await mkdtemp(join(tmpdir(), "aboiteau-check-smoke-"))
const docker = boundedDockerRunner(), requests = new Set<string>()
const intents = new Map<string, WorkspaceCheckIntent>()
const pendingProxies = new Set<Promise<void>>()
const digest = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex")
const cases: Array<Record<string, unknown>> = []
const summary: Record<string, unknown> = { schemaVersion: 1, runID, evidenceDirectory: directory, api: "synthetic authenticated loopback fixture; production Worker covered separately", mode: "committed_only", cases }
console.log("evidence directory: " + directory)
let server: ReturnType<typeof Bun.serve> | undefined, sourceCreated = false
let currentCase = "", freshnessCalls = 0, sourceBase = "", moved = false

async function dock(args: string[], input?: string): Promise<string> {
  const result = await docker(args, { timeoutMs: 30000, input })
  if (result.exitCode !== 0 || result.timedOut || result.outputExceeded) throw new Error(`Local Docker ${args[0]} failed or exceeded bounds`)
  return new TextDecoder().decode(result.stdout).trim()
}
async function control(path: string, body?: unknown): Promise<Response> {
  const start = Date.now()
  try {
    const response = await fetch(sourceBase + path, { method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(35000),
      headers: { authorization: "Bearer " + controlToken, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    await appendFile(join(directory, "http-observations.jsonl"), JSON.stringify({ case: currentCase || "prepare", path, start, elapsedMs: Date.now() - start, status: response.status }) + "\n", { mode: 0o600 })
    return response
  } catch (error) {
    await appendFile(join(directory, "http-observations.jsonl"), JSON.stringify({ case: currentCase || "prepare", path, start, elapsedMs: Date.now() - start, error: error instanceof Error ? error.name : "Error" }) + "\n", { mode: 0o600 })
    throw error
  }
}
async function git(args: string[]): Promise<string> {
  return dock(["exec", "--user", "1001:1001", sourceName, "env", "-u", "CONTROL_TOKEN", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_ALLOW_PROTOCOL=", "GIT_NO_REPLACE_OBJECTS=1", "GIT_GRAFT_FILE=/dev/null", "git", "-C", "/workspace", "-c", "core.hooksPath=/dev/null", ...args])
}
async function cli(args: string[], output: string): Promise<{ code: number; stdout: string }> {
  const env: Record<string, string> = { PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin", ABOITEAU_API_TOKEN: apiToken }
  for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", "DOCKER_API_VERSION"]) if (process.env[key]) env[key] = process.env[key]!
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "workspace-check.ts"), ...args], { env, detached: true, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = async (stream: ReadableStream<Uint8Array>) => {
    let bytes = 0, text = ""
    for await (const piece of stream) { bytes += piece.byteLength; if (bytes > 128 * 1024) throw new Error("CLI output limit"); text += new TextDecoder().decode(piece) }
    return text
  }
  try {
    const [code, stdout, stderr] = await Promise.race([
      Promise.all([child.exited, read(child.stdout), read(child.stderr)]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("CLI smoke deadline")), 90000) }),
    ])
    await writeFile(output + ".stdout", stdout, { mode: 0o600 }); await writeFile(output + ".stderr", stderr, { mode: 0o600 })
    return { code, stdout }
  } finally {
    if (timer) clearTimeout(timer)
    try { process.kill(-child.pid, "SIGKILL") } catch { if (child.exitCode === null) child.kill("SIGKILL") }
  }
}

try {
  const agent = JSON.parse(await dock(["image", "inspect", agentTag]))[0]
  const checker = JSON.parse(await dock(["image", "inspect", checkerTag]))[0]
  summary.agentImageID = agent.Id; summary.checkerImageID = checker.Id
  summary.agentPlatform = agent.Os + "/" + agent.Architecture
  summary.daemonArchitecture = await dock(["info", "--format", "{{.Architecture}}"])
  summary.studioBefore = await dock(["inspect", "deploy-studio-1", "--format", "{{.Id}} {{.State.StartedAt}}"])
  await dock(["run", "--pull=never", "--platform", summary.agentPlatform as string, "--detach", "--name", sourceName, "--label", label,
    "--env", "CONTROL_TOKEN=" + controlToken, "--publish", "127.0.0.1::4001", agent.Id])
  sourceCreated = true
  const port = await dock(["port", sourceName, "4001/tcp"])
  assert.match(port, /^127\.0\.0\.1:[0-9]+$/); sourceBase = "http://" + port
  const readyDeadline = performance.now() + 30000
  for (;;) {
    try { if ((await fetch(sourceBase + "/health", { signal: AbortSignal.timeout(1000) })).ok) break } catch {}
    if (performance.now() > readyDeadline) throw new Error("Source control readiness deadline")
    await Bun.sleep(200)
  }

  const fixture = join(directory, "fixture"); await mkdir(fixture, { mode: 0o700 })
  const files: Record<string, string> = {
    ".gitattributes": "hidden.txt export-ignore\nsubst.txt export-subst\n",
    "hidden.txt": "included despite export-ignore\n", "subst.txt": "$Format:%H$\n", "tracked.txt": "committed version\n",
    "pass.test.ts": `import { expect, test } from "bun:test"; import { existsSync, readFileSync, writeFileSync } from "node:fs"; import { networkInterfaces } from "node:os";
test("exact isolated snapshot", () => { expect(process.getuid?.()).toBe(65532); for (const key of ["ABOITEAU_API_TOKEN","CONTROL_TOKEN","GITHUB_TOKEN","S3_SECRET_ACCESS_KEY","VAULT_MASTER_KEY"]) expect(process.env[key]).toBeUndefined(); for (const path of [".git",".stow","uncommitted.txt","/var/run/docker.sock","/run/podman/podman.sock"]) expect(existsSync(path)).toBe(false); expect(readFileSync("hidden.txt","utf8")).toBe("included despite export-ignore\\n"); expect(readFileSync("subst.txt","utf8")).toBe("$Format:%H$\\n"); expect(readFileSync("tracked.txt","utf8")).toBe("committed version\\n"); expect(Object.keys(networkInterfaces()).filter(name => name !== "lo")).toEqual([]); expect(() => writeFileSync("/opt/aboiteau-check/forbidden","no")).toThrow(); });`,
    "nonzero.ts": 'console.log("NONZERO-STARTED"); process.exit(7);',
    "fake-pass.ts": 'console.log(JSON.stringify({outcome:"passed",cleanupConfirmed:true,exitCode:0})); process.exit(7);',
    "hang.ts": 'console.log("HANG-STARTED"); setInterval(() => {},1000);',
    "flood.ts": 'console.log("FLOOD-STARTED"); for (;;) process.stdout.write("x".repeat(16384));',
  }
  for (const [name, content] of Object.entries(files)) await writeFile(join(fixture, name), content)
  await dock(["cp", fixture + "/.", sourceName + ":/workspace/"])
  await dock(["exec", sourceName, "chown", "-R", "1001:1001", "/workspace"])
  await git(["init", "--template=", "-b", "aboiteau/check"])
  await git(["config", "user.name", "Synthetic Checker Fixture"]); await git(["config", "user.email", "fixture@example.invalid"])
  await git(["remote", "add", "origin", "https://github.com/example/check-smoke"])
  await git(["add", "."]); await git(["commit", "-m", "synthetic committed checks"])
  const commit = await git(["rev-parse", "HEAD"])
  const binding = parseWorkspaceRepositoryReceipt({ schemaVersion: 1, bindingID: randomUUID(), repository: "https://github.com/example/check-smoke", baseBranch: "main", workingBranch: "aboiteau/check", status: "bound", baseCommit: commit })
  await dock(["exec", "-i", sourceName, "bun", "-e", 'const fs=require("node:fs"); const value=JSON.parse(await Bun.stdin.text()); fs.mkdirSync("/var/lib/aboiteau/run",{recursive:true,mode:0o700}); fs.chmodSync("/var/lib/aboiteau/run",0o700); fs.writeFileSync("/var/lib/aboiteau/run/workspace-repository.json",JSON.stringify({phase:"bound",binding:value,staging:"/tmp/aboiteau-bound-"+crypto.randomUUID()}),{mode:0o600}); fs.writeFileSync("/var/lib/aboiteau/state/workspace-repository.json",JSON.stringify(value),{mode:0o644});'], JSON.stringify(binding))
  await dock(["exec", "--user", "1001:1001", sourceName, "bun", "-e", 'await Bun.write("/workspace/uncommitted.txt","not committed"); await Bun.write("/workspace/tracked.txt","uncommitted change");'])
  const beforeStatus = await (await control("/status")).json()
  const exported = await control("/workspace/checks/snapshot", { workspaceRepository: binding, commit })
  assert.equal(exported.status, 200)
  const snapshot = await verifyWorkspaceCheckSnapshot(await exported.json())
  assert.equal(snapshot.commit, commit); assert.equal(snapshot.worktreeChanges, "unverified")
  assert(!snapshot.files.some(file => file.path === "uncommitted.txt" || file.path === ".git" || file.path.startsWith(".git/") || file.path === ".stow"))
  assert.equal(Buffer.from(snapshot.files.find(file => file.path === "tracked.txt")!.contentBase64, "base64").toString(), "committed version\n")
  assert.deepEqual(await (await control("/status")).json(), beforeStatus)
  await writeFile(join(directory, "source.json"), snapshot.canonicalJSON, { mode: 0o600 })
  summary.commit = commit; summary.tree = snapshot.tree; summary.sourceSHA256 = snapshot.snapshotSHA256; summary.fileCount = snapshot.files.length

  server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 120, async fetch(request) {
    let finished!: () => void
    const pending = new Promise<void>(resolve => { finished = resolve })
    pendingProxies.add(pending)
    try {
    if (request.headers.get("authorization") !== "Bearer " + apiToken) return new Response("unauthorized", { status: 401 })
    const path = new URL(request.url).pathname
    request.signal.addEventListener("abort", () => { void appendFile(join(directory, "http-observations.jsonl"), JSON.stringify({ case: currentCase, path, event: "fixture-client-aborted", at: Date.now() }) + "\n", { mode: 0o600 }) }, { once: true })
    if (path.endsWith("/workspace/repository")) return Response.json({ workspaceRepository: binding })
    if (path.endsWith("/workspace/checks") && request.method === "POST") {
      const input = parseWorkspaceCheckRequest(await request.json()); assert.equal(input.commitOID, commit); assert.equal(input.expectedBindingID, binding.bindingID); requests.add(input.requestID)
      const intent = parseWorkspaceCheckIntent({ ...input, schemaVersion: 1, mode: "committed_only", binding, status: "exported", checksNotRun: true, createdAt: Date.now(), source: { treeOID: snapshot.tree, sourceSHA256: snapshot.snapshotSHA256 }, worktreeChanges: "unverified" })
      intents.set(input.requestID, intent); return Response.json({ workspaceCheck: intent }, { status: 201 })
    }
    const id = /\/checks\/([a-f0-9-]+)\/(source|freshness)$/.exec(path), intent = id && intents.get(id[1])
    if (!id || !intent) return new Response("not found", { status: 404 })
    if (id[2] === "source") return new Response(snapshot.canonicalJSON, { headers: { "content-type": "application/json" } })
    if (currentCase === "stale-after" && ++freshnessCalls === 2 && !moved) {
      const later = await git(["commit-tree", "HEAD^{tree}", "-p", commit, "-m", "later committed head"])
      await git(["update-ref", "refs/heads/aboiteau/check", later]); moved = true
    }
    const observed = await control("/workspace/checks/head", { workspaceRepository: binding })
    assert.equal(observed.status, 200)
    const head: { commit: string; tree: string } = await observed.json()
    await appendFile(join(directory, "http-observations.jsonl"), JSON.stringify({ case: currentCase, path, event: "freshness-response", requestID: intent.requestID, observedCommit: head.commit, observedTree: head.tree, expectedCommit: commit, at: Date.now() }) + "\n", { mode: 0o600 })
    return Response.json({ requestID: intent.requestID, expectedBindingID: binding.bindingID, commitOID: commit, observedCommitOID: head.commit, observedTreeOID: head.tree, status: head.commit === commit ? "current" : "stale", mode: "committed_only", worktreeChanges: "unverified", checksNotRun: true })
    } finally { finished(); pendingProxies.delete(pending) }
  } })

  const profile = [
    { name: "pass", argv: ["bun", "--no-env-file", "--no-install", "test", "pass.test.ts"], code: 0, outcome: "passed" },
    { name: "nonzero", argv: ["bun", "nonzero.ts"], code: 2, outcome: "failed" },
    { name: "fake-pass", argv: ["bun", "fake-pass.ts"], code: 2, outcome: "failed" },
    { name: "hang", argv: ["bun", "hang.ts"], code: 2, outcome: "timeout" },
    { name: "flood", argv: ["bun", "flood.ts"], code: 3, outcome: "collector_error" },
    { name: "stale-after", argv: ["bun", "--no-env-file", "--no-install", "test", "pass.test.ts"], code: 2, outcome: "passed" },
  ]
  for (const item of profile) {
    currentCase = item.name; freshnessCalls = 0
    const out = join(directory, item.name)
    const result = await cli(["run", "--url", `http://127.0.0.1:${server.port}`, "--conversation", "synthetic-smoke", "--commit", commit, "--binding-id", binding.bindingID, "--image", checker.Id, "--timeout-ms", item.name === "hang" ? "8000" : "20000", "--out", out, "--json", "--", ...item.argv], out + ".cli")
    const raw = JSON.parse(result.stdout), receipt = parseWorkspaceCheckLocalReceipt(raw.receipt)
    cases.push({ name: item.name, cliExitCode: result.code, outcome: receipt.outcome, commandExitCode: receipt.exitCode, cleanupConfirmed: receipt.cleanupConfirmed, freshness: receipt.freshness, receipt: join(out, "receipt.json"), stdoutSHA256: receipt.logs.stdout.sha256, stderrSHA256: receipt.logs.stderr.sha256 })
    assert.equal(result.code, item.code); assert.equal(receipt.outcome, item.outcome); assert.equal(receipt.cleanupConfirmed, true)
    assert.equal(receipt.freshness.before, "matched")
    if (item.name !== "stale-after") assert.equal(receipt.freshness.after, "matched")
    if (item.name === "nonzero" || item.name === "fake-pass") assert.equal(receipt.exitCode, 7)
    if (item.name === "hang") assert.match(await readFile(join(out, "stdout.log"), "utf8"), /HANG-STARTED/)
    if (item.name === "flood") { assert(receipt.logs.stdout.truncated); assert(receipt.logs.stdout.capturedBytes <= 65536) }
    if (item.name === "stale-after") assert.equal(receipt.freshness.after, "stale")
    console.log(`ok - ${item.name}: ${receipt.outcome}, cleanup confirmed`)
  }
  summary.passed = true
} catch (error) {
  summary.passed = false; summary.failedCase = currentCase || "source-export"; summary.error = error instanceof Error ? error.message : "smoke failed"
  process.exitCode = 1
} finally {
  // Preserve late upstream timing evidence after the CLI's shorter deadline.
  // This does not retry a request or change any client/proxy timeout.
  let grace: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([Promise.allSettled([...pendingProxies]), new Promise<void>(resolve => { grace = setTimeout(resolve, 37000) })])
  } finally { if (grace) clearTimeout(grace) }
  summary.pendingProxyReadsAtCleanup = pendingProxies.size
  server?.stop(true)
  if (sourceCreated) {
    try {
      summary.sourceState = await dock(["inspect", sourceName, "--format", "{{json .State}}"])
      summary.sourceMemory = await dock(["exec", sourceName, "sh", "-c", "for f in /sys/fs/cgroup/memory.events /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.peak; do test ! -r \"$f\" || { echo \"$f\"; cat \"$f\"; }; done"])
      const sourceLog = await docker(["logs", "--tail", "100", sourceName], { timeoutMs: 10000 })
      await writeFile(join(directory, "source.log"), Buffer.concat([sourceLog.stdout, sourceLog.stderr]), { mode: 0o600 })
      summary.sourceLogSHA256 = digest(Buffer.concat([sourceLog.stdout, sourceLog.stderr]))
    } catch { summary.sourceLogsUnavailable = true }
  }
  // The run acknowledgement may have been lost. Cleanup is label-based even
  // when sourceCreated is false; no unrelated container name is selected.
  try {
    const owned = await dock(["container", "ls", "--all", "--filter", "label=" + label, "--format", "{{.ID}}"])
    if (owned) await dock(["rm", "--force", ...owned.split("\n")])
    assert.equal(await dock(["container", "ls", "--all", "--filter", "label=" + label, "--format", "{{.ID}}"]), "")
    summary.sourceCleanupConfirmed = true
  } catch { summary.sourceCleanupUnknown = true; process.exitCode = 1 }
  for (const requestID of requests) {
    try {
      const owned = await dock(["container", "ls", "--all", "--filter", "label=org.aboiteau.check.request=" + requestID, "--format", "{{.ID}}"])
      if (owned) { await dock(["rm", "--force", ...owned.split("\n")]); summary.collectorCleanupRequired = true; process.exitCode = 1 }
      assert.equal(await dock(["container", "ls", "--all", "--filter", "label=org.aboiteau.check.request=" + requestID, "--format", "{{.ID}}"]), "")
    } catch { summary.checkerCleanupUnknown = true; process.exitCode = 1 }
  }
  try {
    summary.studioAfter = await dock(["inspect", "deploy-studio-1", "--format", "{{.Id}} {{.State.StartedAt}}"])
    assert.equal(summary.studioAfter, summary.studioBefore)
  } catch { summary.studioPreservationUnconfirmed = true; process.exitCode = 1 }
  summary.processExitCode = process.exitCode ?? 0
  summary.passed = summary.passed === true && summary.processExitCode === 0
  await writeFile(join(directory, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(summary, null, 2))
}
