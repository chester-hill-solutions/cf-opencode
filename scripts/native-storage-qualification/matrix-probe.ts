import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, renameSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { QUALIFICATION_ARTIFACT } from "./artifact"
import { KEY_CASES, MATRIX_VERSION, DIRECT_MARKER, METADATA_MARKER, keyMarker, type CaseResult, type CaseID } from "./matrix"
import { digest, s3Request, type ProbeCredentials } from "./s3-probe-client"
import { parseWorkspaceIdentity, parseWorkspaceReadiness } from "../../stow-workspace"
import { registryFaults } from "./registry-probe"

const ROOT = "/workspace"
const PRIVATE = "/tmp/c2-native-storage-probe"
const STATE = `${ROOT}/.qualification/matrix.json`
const PART_KEY = "matrix/pending-multipart.txt"
const PART = Buffer.from("synthetic-pending-part-v1\n".repeat(128))
const META_KEY = "matrix/metadata.txt"
const META_BODY = Buffer.from(METADATA_MARKER)
const META_HEADERS = { "content-type": "application/vnd.aboiteau.matrix", "cache-control": "max-age=123",
  "content-disposition": "attachment; filename=matrix.txt", "content-encoding": "identity", "x-amz-meta-qualification": "synthetic-v1" }
const DIRECT = "matrix/direct.txt"
const DIRECT_TEXT = DIRECT_MARKER
const SENTINEL = "/tmp/c2-native-storage-ephemeral-sentinel"

type Fixture = {
  version: number
  workspaceID: string
  rows: CaseResult[]
  git?: { head: string; branch: string; diff: string }
  multipart?: { uploadID: string; etag: string }
  writer?: { acknowledgedVersion: number; quiesced: boolean }
}

function command(args: string[]): string {
  const result = Bun.spawnSync(args, { cwd: ROOT, stdout: "pipe", stderr: "pipe", timeout: 10_000 })
  if (result.exitCode !== 0) throw new Error("fixed fixture command failed")
  return result.stdout.toString().trim()
}

function treeHash(root: string): string {
  const entries: string[] = []
  const walk = (path: string) => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) throw new Error("unexpected fixture symlink")
      entries.push(relative(root, full))
      if (stat.isDirectory()) walk(full)
      else entries.push(digest(readFileSync(full)))
    }
  }
  walk(root)
  return digest(entries.join("\0"))
}

const row = (id: CaseID, disposition: CaseResult["disposition"], reason: CaseResult["reason"], httpStatus?: number): CaseResult =>
  ({ id, disposition, reason, ...(httpStatus === undefined ? {} : { httpStatus }) })
const accepted = (status: number) => status >= 200 && status < 300
const refusal = (status: number) => [400, 403, 405, 409, 422, 501].includes(status)
const xmlValue = (xml: string, tag: string) => xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`))?.[1]

function save(fixture: Fixture) {
  writeFileSync(`${STATE}.tmp`, JSON.stringify(fixture))
  renameSync(`${STATE}.tmp`, STATE)
}

async function keyCase(credentials: ProbeCredentials, entry: typeof KEY_CASES[number], mode: string, fixture: Fixture): Promise<CaseResult> {
  const body = Buffer.from(keyMarker(entry.id))
  const aliasSafe = () => readFileSync(`${ROOT}/matrix-alias-canary.txt`, "utf8") === "protected alias bytes\n"
  if (mode !== "first" && (!aliasSafe() || existsSync("/tmp/matrix-outside-canary.txt"))) {
    return row(entry.id, "failed", "mutation_changed_state")
  }
  if (mode === "first") {
    const before = treeHash(ROOT)
    const registryBefore = treeHash("/var/lib/aboiteau/state/stow")
    const outside = digest(readFileSync("/tmp/matrix-outside-canary.txt"))
    const response = await s3Request(credentials, "PUT", entry.key, { body })
    if (digest(readFileSync("/tmp/matrix-outside-canary.txt")) !== outside ||
      readFileSync(`${ROOT}/matrix-alias-canary.txt`, "utf8") !== "protected alias bytes\n") {
      return row(entry.id, "failed", "mutation_changed_state", response.status)
    }
    if (!accepted(response.status)) {
      const head = await s3Request(credentials, "HEAD", entry.key)
      const unchanged = treeHash(ROOT) === before && treeHash("/var/lib/aboiteau/state/stow") === registryBefore && digest(readFileSync("/tmp/matrix-outside-canary.txt")) === outside
      return row(entry.id, refusal(response.status) && head.status === 404 && unchanged ? "refused_before_mutation" : "failed",
        !unchanged ? "mutation_changed_state" : refusal(response.status) && head.status === 404 ? "mutation_refused" : "unexpected_http_status", response.status)
    }
  } else {
    const initial = fixture.rows.find((result) => result.id === entry.id)
    if (initial?.disposition === "failed") return initial
    if (initial?.disposition === "refused_before_mutation") {
      const head = await s3Request(credentials, "HEAD", entry.key)
      return head.status === 404 ? initial : row(entry.id, "failed", "mutation_changed_state", head.status)
    }
  }
  const read = await s3Request(credentials, "GET", entry.key)
  const listed = await s3Request(credentials, "GET", "", { query: { "list-type": "2" } })
  const exactKeys = [...listed.body.toString().matchAll(/<Key>([^<]*)<\/Key>/g)]
    .map((match) => match[1].replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'"))
  const checks = { bytes: read.status === 200 && read.body.equals(body), listedExactKey: listed.status === 200 && exactKeys.includes(entry.key),
    ...(entry.natural ? { filesystemBytes: existsSync(`${ROOT}/${entry.key}`) && readFileSync(`${ROOT}/${entry.key}`).equals(body) } : {}) }
  const bytesMatch = Object.values(checks).every(Boolean)
  return { ...row(entry.id, bytesMatch ? mode === "first" ? "prepared" : "preserved" : "failed",
    bytesMatch ? mode === "first" ? "awaiting_cold_restore" : "bytes_restored" : "bytes_mismatch", read.status), checks }
}

async function metadataCase(credentials: ProbeCredentials, mode: string, fixture: Fixture): Promise<CaseResult> {
  const prior = fixture.rows.find((result) => result.id === "object-metadata")
  if (mode !== "first" && prior?.disposition === "failed") return prior
  if (mode === "first") {
    const before = treeHash(ROOT)
    const registryBefore = treeHash("/var/lib/aboiteau/state/stow")
    const response = await s3Request(credentials, "PUT", META_KEY, { body: META_BODY, headers: META_HEADERS })
    if (!accepted(response.status)) {
      const missing = (await s3Request(credentials, "HEAD", META_KEY)).status === 404
      const safe = refusal(response.status) && missing && treeHash(ROOT) === before && treeHash("/var/lib/aboiteau/state/stow") === registryBefore
      return row("object-metadata", safe ? "refused_before_mutation" : "failed", safe ? "mutation_refused" : "mutation_changed_state", response.status)
    }
  } else if (fixture.rows.find((result) => result.id === "object-metadata")?.disposition === "refused_before_mutation") {
    const missing = (await s3Request(credentials, "HEAD", META_KEY)).status === 404
    return row("object-metadata", missing ? "refused_before_mutation" : "failed", missing ? "mutation_refused" : "mutation_changed_state")
  }
  const [head, read] = await Promise.all([s3Request(credentials, "HEAD", META_KEY), s3Request(credentials, "GET", META_KEY)])
  const checks = { bytes: read.status === 200 && read.body.equals(META_BODY),
    contentType: head.headers["content-type"] === META_HEADERS["content-type"], cacheControl: head.headers["cache-control"] === META_HEADERS["cache-control"],
    contentDisposition: head.headers["content-disposition"] === META_HEADERS["content-disposition"], contentEncoding: head.headers["content-encoding"] === META_HEADERS["content-encoding"],
    userMetadata: head.headers["x-amz-meta-qualification"] === META_HEADERS["x-amz-meta-qualification"] }
  const matches = head.status === 200 && Object.values(checks).every(Boolean)
  return { ...row("object-metadata", matches ? mode === "first" ? "prepared" : "preserved" : "failed",
    matches ? mode === "first" ? "awaiting_cold_restore" : "bytes_restored" : "metadata_mismatch", head.status), checks }
}

async function multipartCase(credentials: ProbeCredentials, mode: string, fixture: Fixture): Promise<CaseResult> {
  const prior = fixture.rows.find((result) => result.id === "unfinished-multipart")
  if (mode !== "first" && prior?.disposition === "failed") return prior
  if (mode === "first") {
    const before = treeHash(ROOT)
    const registryBefore = treeHash("/var/lib/aboiteau/state/stow")
    const response = await s3Request(credentials, "POST", PART_KEY, { query: { uploads: "" } })
    if (!accepted(response.status)) {
      const missing = (await s3Request(credentials, "HEAD", PART_KEY)).status === 404
      const safe = refusal(response.status) && missing && treeHash(ROOT) === before && treeHash("/var/lib/aboiteau/state/stow") === registryBefore
      return row("unfinished-multipart", safe ? "refused_before_mutation" : "failed", safe ? "mutation_refused" : "mutation_changed_state", response.status)
    }
    const uploadID = xmlValue(response.body.toString(), "UploadId")
    if (!uploadID || !/^[A-Za-z0-9._-]{1,256}$/.test(uploadID)) return row("unfinished-multipart", "failed", "multipart_incomplete")
    const part = await s3Request(credentials, "PUT", PART_KEY, { query: { uploadId: uploadID, partNumber: "1" }, body: PART })
    const etag = part.headers.etag
    if (!accepted(part.status) || !etag || !/^"?[a-fA-F0-9]{16,128}"?$/.test(etag)) {
      await s3Request(credentials, "DELETE", PART_KEY, { query: { uploadId: uploadID } })
      return row("unfinished-multipart", "failed", "multipart_incomplete", part.status)
    }
    fixture.multipart = { uploadID, etag }
  } else if (!fixture.multipart) {
    const prior = fixture.rows.find((result) => result.id === "unfinished-multipart")
    if (prior?.disposition !== "refused_before_mutation") return prior ?? row("unfinished-multipart", "failed", "multipart_lost")
    return (await s3Request(credentials, "HEAD", PART_KEY)).status === 404 ? prior : row("unfinished-multipart", "failed", "mutation_changed_state")
  }
  const pending = fixture.multipart!
  const parts = await s3Request(credentials, "GET", PART_KEY, { query: { uploadId: pending.uploadID } })
  if (parts.status !== 200 || !parts.body.toString().includes("<PartNumber>1</PartNumber>") ||
    !parts.body.toString().includes(pending.etag.replaceAll('"', ""))) return row("unfinished-multipart", "failed", "multipart_lost", parts.status)
  if ((await s3Request(credentials, "HEAD", PART_KEY)).status !== 404) return row("unfinished-multipart", "failed", "multipart_incomplete")
  if (mode === "first") return row("unfinished-multipart", "prepared", "awaiting_cold_restore")
  const complete = Buffer.from(`<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${pending.etag}</ETag></Part></CompleteMultipartUpload>`)
  const finished = await s3Request(credentials, "POST", PART_KEY, {
    query: { uploadId: pending.uploadID }, headers: { "content-type": "application/xml" }, body: complete,
  })
  const result = await s3Request(credentials, "GET", PART_KEY)
  const preserved = accepted(finished.status) && !finished.body.toString().includes("<Error>") && result.status === 200 && result.body.equals(PART)
  return row("unfinished-multipart", preserved ? "preserved" : "failed", preserved ? "bytes_restored" : "multipart_lost", finished.status)
}

function gitCase(mode: string, fixture: Fixture): CaseResult {
  const git = (...args: string[]) => command(["git", "-c", "core.hooksPath=/dev/null", ...args])
  if (mode === "first") {
    if (existsSync(`${ROOT}/.git`)) throw new Error("fixture repository is not fresh")
    git("init", "--initial-branch=qualification-fixture")
    writeFileSync(`${ROOT}/matrix/tracked.txt`, "committed synthetic bytes\n")
    git("add", "--", "matrix/tracked.txt")
    git("-c", "user.name=Qualification", "-c", "user.email=qualification@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Synthetic recovery fixture")
    writeFileSync(`${ROOT}/matrix/tracked.txt`, "uncommitted synthetic bytes\n")
    writeFileSync(`${ROOT}/matrix/untracked.txt`, "untracked synthetic bytes\n")
    fixture.git = { head: git("rev-parse", "HEAD"), branch: git("branch", "--show-current"), diff: digest(git("diff", "--binary", "--", "matrix/tracked.txt")) }
  }
  const matches = fixture.git && fixture.git.head === git("rev-parse", "HEAD") && fixture.git.branch === git("branch", "--show-current") &&
    fixture.git.diff === digest(git("diff", "--binary", "--", "matrix/tracked.txt")) &&
    readFileSync(`${ROOT}/matrix/untracked.txt`, "utf8") === "untracked synthetic bytes\n" &&
    readFileSync(`${ROOT}/matrix/tracked.txt`, "utf8") === "uncommitted synthetic bytes\n"
  return row("git-state", matches ? mode === "first" ? "prepared" : "preserved" : "failed", matches ? mode === "first" ? "awaiting_cold_restore" : "bytes_restored" : "git_mismatch")
}

// Bounded adversarial fixture only. This does not stop arbitrary repository processes.
const WRITER = String.raw`
const fs = require("node:fs"); const crypto = require("node:crypto");
const base = "/workspace/.qualification"; const end = Date.now() + 30000;
let version = 0;
function publish() { const payload = "synthetic-" + version + "-" + "x".repeat(32768);
 const body = JSON.stringify({version, payload, hash:crypto.createHash("sha256").update(payload).digest("hex")});
 fs.writeFileSync(base + "/writer-a.json", body); fs.writeFileSync(base + "/writer-b.json", body);
 fs.writeFileSync(base + "/writer-status.json", JSON.stringify({version,deadline:end,stopped:false})); }
(async()=>{ do { version++; publish(); await Bun.sleep(5); }
 while (Date.now()<end && !fs.existsSync("/tmp/c2-native-storage-probe/stop-writer"));
 version++; publish(); fs.writeFileSync(base + "/writer-status.json", JSON.stringify({version,deadline:end,stopped:true})); })();
`

async function writer(mode: string): Promise<{ active: boolean; deadline: number }> {
  const statusPath = `${ROOT}/.qualification/writer-status.json`
  if (mode === "writer-start") {
    if (existsSync(statusPath)) throw new Error("writer was already started")
    const child = Bun.spawn([process.execPath, "-e", WRITER], { stdout: "ignore", stderr: "ignore", stdin: "ignore", detached: true,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/var/lib/aboiteau/state" } })
    child.unref()
  } else writeFileSync(`${PRIVATE}/stop-writer`, "stop")
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const status = JSON.parse(readFileSync(statusPath, "utf8"))
      if (mode === "writer-start" ? status.version >= 2 && !status.stopped : status.stopped) {
        const fixture: Fixture = JSON.parse(readFileSync(STATE, "utf8"))
        if (mode === "writer-start") fixture.writer = { acknowledgedVersion: status.version, quiesced: false }
        else if (fixture.writer) fixture.writer.quiesced = true
        else throw new Error("writer acknowledgement unavailable")
        save(fixture)
        return { active: !status.stopped, deadline: status.deadline }
      }
    } catch { /* writer may be between bounded writes */ }
    await Bun.sleep(20)
  }
  throw new Error("writer acknowledgement unavailable")
}

function writerCase(fixture: Fixture): CaseResult {
  try {
    const a = readFileSync(`${ROOT}/.qualification/writer-a.json`, "utf8")
    const b = readFileSync(`${ROOT}/.qualification/writer-b.json`, "utf8")
    const decoded = JSON.parse(a)
    const status = JSON.parse(readFileSync(`${ROOT}/.qualification/writer-status.json`, "utf8"))
    const matches = a === b && decoded.hash === digest(decoded.payload) && decoded.version >= 2 &&
      fixture.writer && decoded.version > fixture.writer.acknowledgedVersion && status.version === decoded.version &&
      status.stopped === fixture.writer.quiesced
    return row("background-writer", matches ? "preserved" : "failed", matches ? "bytes_restored" : "writer_pair_mismatch")
  } catch { return row("background-writer", "not_exercised", "writer_not_started") }
}

async function main() {
  const mode = process.env.C2_PROBE_MODE
  if (digest(readFileSync("/app/control-server.ts")) !== QUALIFICATION_ARTIFACT.controllerSHA256 ||
    digest(readFileSync("/usr/local/bin/stow-s3")) !== QUALIFICATION_ARTIFACT.binarySHA256) throw new Error("artifact mismatch")
  if (mode === "registry-faults") { console.log(JSON.stringify(await registryFaults())); return }
  if (!["first", "restored", "writer-start", "writer-stop"].includes(mode ?? "") || process.getuid?.() !== 1001 || process.getgid?.() !== 1001) throw new Error("invalid fixed probe identity/mode")
  if (process.env.CONTROL_TOKEN || process.env.C2_CONTROL_TOKEN) throw new Error("control token must not enter the agent probe")
  if (mode === "writer-start" || mode === "writer-stop") { console.log(JSON.stringify(await writer(mode))); return }
  const identity = parseWorkspaceIdentity(JSON.parse(readFileSync("/var/lib/aboiteau/state/stow/identity.json", "utf8")),
    { root: ROOT, registryDir: "/var/lib/aboiteau/state/stow/registry", bucket: "aboiteau-workspace" })
  const credentials = parseWorkspaceReadiness(JSON.parse(readFileSync(`${PRIVATE}/readiness.json`, "utf8")), identity)
  let fixture: Fixture
  const initial = mode === "first"
  if (initial) {
    if (existsSync(STATE) || existsSync(SENTINEL)) throw new Error("fixture has already been used")
    mkdirSync(`${ROOT}/.qualification`, { recursive: true })
    mkdirSync(`${ROOT}/matrix`, { recursive: true })
    writeFileSync(`${ROOT}/matrix-alias-canary.txt`, "protected alias bytes\n")
    writeFileSync("/tmp/matrix-outside-canary.txt", "protected outside bytes\n")
    writeFileSync(`${ROOT}/${DIRECT}`, DIRECT_TEXT)
    fixture = { version: MATRIX_VERSION, workspaceID: identity.workspace_id, rows: [] }
    try { fixture.rows.push(gitCase(mode!, fixture)) } catch { fixture.rows.push(row("git-state", "failed", "git_mismatch")) }
  } else {
    fixture = JSON.parse(readFileSync(STATE, "utf8"))
    if (fixture.version !== MATRIX_VERSION || fixture.workspaceID !== identity.workspace_id) throw new Error("fixture identity mismatch")
  }
  const rows: CaseResult[] = []
  for (const entry of KEY_CASES) {
    try { rows.push(await keyCase(credentials, entry, mode!, fixture)) } catch { rows.push(row(entry.id, "failed", "request_failed")) }
  }
  try { rows.push(await metadataCase(credentials, mode!, fixture)) } catch { rows.push(row("object-metadata", "failed", "request_failed")) }
  try { rows.push(await multipartCase(credentials, mode!, fixture)) } catch { rows.push(row("unfinished-multipart", "failed", "request_failed")) }
  if (initial) rows.push(...fixture.rows)
  else { try { rows.push(gitCase(mode!, fixture)) } catch { rows.push(row("git-state", "failed", "git_mismatch")) } }
  rows.push(initial ? row("background-writer", "prepared", "awaiting_cold_restore") : writerCase(fixture))
  if (initial) { fixture.rows = rows; save(fixture); writeFileSync(SENTINEL, "disk-only sentinel\n") }
  const direct = await s3Request(credentials, "GET", DIRECT)
  const metadata = await s3Request(credentials, "HEAD", META_KEY)
  const sentinelAbsent = initial || !existsSync(SENTINEL)
  console.log(JSON.stringify({ mode, ok: direct.status === 200 && direct.body.toString() === DIRECT_TEXT && sentinelAbsent,
    workspaceID: identity.workspace_id, directFileToS3GetMatches: direct.body.toString() === DIRECT_TEXT,
    s3PutToWorkspaceFileMatches: rows.some((entry) => entry.id === "key-natural" && ["prepared", "preserved"].includes(entry.disposition)),
    metadataTypeMatches: metadata.status === 200 && metadata.headers["content-type"] === META_HEADERS["content-type"],
    ephemeralSentinelAbsent: sentinelAbsent, agentUID: process.getuid(),
    controllerSHA256: QUALIFICATION_ARTIFACT.controllerSHA256, binarySHA256: QUALIFICATION_ARTIFACT.binarySHA256,
    matrixVersion: MATRIX_VERSION, matrix: rows }))
}

main().catch((error) => {
  const code = error instanceof Error && error.message === "writer acknowledgement unavailable" ? "writer_acknowledgement_unavailable" : "unexpected_probe_failure"
  console.error(`fixed recovery probe failed: ${code}`); process.exitCode = 2
})
