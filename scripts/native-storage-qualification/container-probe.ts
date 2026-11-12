/** Fixed, no-argument container-side probe used only by the staging C2 Worker. */
export const NATIVE_STORAGE_PROBE = String.raw`
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"

const expectedControllerSHA256 = "e70c25065a74c2d5384df19dd8c1612949b1b08d790b368a72cd0f5212cdd3a3"
const expectedBinarySHA256 = "780c3ccf89abdb4355e1b943ab686693d7436bd08cefdffd0f315226815f27da"
const root = "/workspace"
const identityPath = "/var/lib/aboiteau/state/stow/identity.json"
const readinessPath = "/tmp/c2-native-storage-probe/readiness.json"
const sentinelPath = "/tmp/c2-native-storage-ephemeral-sentinel"
const directKey = "c2-direct-file.txt"
const objectKey = "c2-s3-object.txt"
const metadataKey = "c2-object-metadata.txt"
const directText = "c2-synthetic-direct-workspace-bytes-v1\n"
const objectText = "c2-synthetic-s3-workspace-bytes-v1\n"
const metadataText = "c2-synthetic-content-type-metadata-v1\n"
const metadataType = "application/vnd.aboiteau.c2-probe"

function fail(message) {
  process.stderr.write(message + "\n")
  process.exit(2)
}

function loopback(urlValue) {
  let url
  try { url = new URL(urlValue) } catch { return false }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  return url.protocol === "http:" && Boolean(url.port) &&
    (host === "localhost" || host === "127.0.0.1" || host === "::1") &&
    !url.username && !url.password && !url.search && !url.hash
}

async function main() {
  const mode = process.env.C2_PROBE_MODE
  if (mode !== "first" && mode !== "restored") fail("invalid fixed probe mode")
  if (process.getuid?.() !== 1001 || process.getgid?.() !== 1001) fail("probe did not run as workspace agent")

  const identity = JSON.parse(readFileSync(identityPath, "utf8"))
  const readiness = JSON.parse(readFileSync(readinessPath, "utf8"))
  if (identity.version !== 1 || readiness.version !== 1 ||
      typeof identity.workspace_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(identity.workspace_id) ||
      identity.root !== root || identity.working_directory !== root ||
      identity.registry_dir !== "/var/lib/aboiteau/state/stow/registry" || identity.bucket !== "aboiteau-workspace" ||
      readiness.workspace_id !== identity.workspace_id || readiness.root !== identity.root ||
      (readiness.working_directory !== identity.working_directory && readiness.working_directory !== ".") ||
      readiness.registry_dir !== identity.registry_dir ||
      readiness.bucket !== identity.bucket || !loopback(readiness.endpoint) ||
      !readiness.region || !readiness.access_key_id || !readiness.secret_access_key) {
    fail("native workspace identity or readiness did not validate")
  }

  const controllerSHA256 = createHash("sha256").update(readFileSync("/app/control-server.ts")).digest("hex")
  const binarySHA256 = createHash("sha256").update(readFileSync("/usr/local/bin/stow-s3")).digest("hex")
  if (controllerSHA256 !== expectedControllerSHA256 || binarySHA256 !== expectedBinarySHA256) {
    fail("container source or native binary pin mismatch")
  }

  const sentinelExists = existsSync(sentinelPath)
  if (mode === "first" && sentinelExists) fail("ephemeral sentinel already existed")
  if (mode === "restored" && sentinelExists) fail("ephemeral sentinel survived container recycle")

  const client = new Bun.S3Client({
    endpoint: readiness.endpoint,
    region: readiness.region,
    bucket: identity.bucket,
    accessKeyId: readiness.access_key_id,
    secretAccessKey: readiness.secret_access_key,
    virtualHostedStyle: false,
  })

  let directFileToS3GetMatches = false
  let s3PutToWorkspaceFileMatches = false
  let metadataTypeMatches = false
  if (mode === "first") {
    await Bun.write(root + "/" + directKey, directText)
    directFileToS3GetMatches = await client.file(directKey).text() === directText
    await client.file(objectKey).write(objectText)
    s3PutToWorkspaceFileMatches = await Bun.file(root + "/" + objectKey).text() === objectText
    await client.file(metadataKey).write(metadataText, { type: metadataType })
    metadataTypeMatches = (await client.file(metadataKey).stat()).type === metadataType
    await Bun.write(sentinelPath, "must-not-be-in-checkpoint\n")
  } else {
    directFileToS3GetMatches = await client.file(directKey).text() === directText
    s3PutToWorkspaceFileMatches = await Bun.file(root + "/" + objectKey).text() === objectText
    const metadata = client.file(metadataKey)
    metadataTypeMatches = (await metadata.text()) === metadataText &&
      (await metadata.stat()).type === metadataType
  }

  const ok = directFileToS3GetMatches && s3PutToWorkspaceFileMatches && metadataTypeMatches &&
    (mode === "restored" ? !sentinelExists : true)
  process.stdout.write(JSON.stringify({
    mode,
    ok,
    workspaceID: identity.workspace_id,
    directFileToS3GetMatches,
    s3PutToWorkspaceFileMatches,
    metadataTypeMatches,
    ephemeralSentinelAbsent: !sentinelExists,
    agentUID: process.getuid(),
    controllerSHA256,
    binarySHA256,
  }) + "\n")
  if (!ok) process.exit(2)
}

main().catch(() => fail("native storage probe failed"))
`
