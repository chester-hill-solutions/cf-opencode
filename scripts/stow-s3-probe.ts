/**
 * Disposable Bun.S3Client probes for generic Stow storage (R0-15A) and the
 * native Workspace readiness endpoint (B1). Credentials and readiness payloads
 * are read only inside the container and are never included in output.
 */

import { isIP } from "node:net"
import { isAbsolute, relative, resolve } from "node:path"

export {}

type JsonObject = Record<string, unknown>
type WorkspaceManifest = {
  version: 1
  root: string
  working_directory: string
  registry_dir: string
  bucket: string
  inputs: [{ source: string; destination: string }]
}
type WorkspaceIdentity = {
  workspaceID: string
  root: string
  workingDirectory: string
  registryDir: string
  bucket: string
}
type S3ClientConfiguration = {
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
}

const mode = process.argv[2]
let operation = "validate-arguments"
let s3ClientConstructions = 0

const directKey = "b1-direct.txt"
const s3Key = "b1-s3-write.txt"
const directMarker = "synthetic-b1-direct-workspace-bytes-v1\n"
const s3Marker = "synthetic-b1-s3-object-bytes-v1\n"

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
}

function readString(value: JsonObject, field: string): string | undefined {
  const found = value[field]
  return typeof found === "string" && found.length > 0 ? found : undefined
}

function canonicalWithin(rootValue: string, pathValue: string): string | undefined {
  const root = resolve(rootValue)
  const candidate = resolve(root, pathValue)
  const rel = relative(root, candidate)
  if (rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))) {
    return candidate
  }
  return undefined
}

function validWorkspaceID(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function expectedManifest(value: unknown): WorkspaceManifest | undefined {
  const manifest = asObject(value)
  if (!manifest || manifest.version !== 1) return undefined
  const root = readString(manifest, "root")
  const workingDirectory = readString(manifest, "working_directory")
  const registryDir = readString(manifest, "registry_dir")
  const bucket = readString(manifest, "bucket")
  const inputs = Array.isArray(manifest.inputs) ? manifest.inputs : undefined
  const firstInput = inputs?.length === 1 ? asObject(inputs[0]) : undefined
  if (
    root !== "/workspace/stow-workspace" ||
    workingDirectory !== "." ||
    registryDir !== "/var/lib/aboiteau/state/stow/registry" ||
    bucket !== "aboiteau-workspace" ||
    !firstInput ||
    Object.keys(firstInput).length !== 2 ||
    firstInput.source !== "/tmp/stow-b1/seed.txt" ||
    firstInput.destination !== "seed.txt"
  ) {
    return undefined
  }
  return {
    version: 1,
    root,
    working_directory: workingDirectory,
    registry_dir: registryDir,
    bucket,
    inputs: [{ source: "/tmp/stow-b1/seed.txt", destination: "seed.txt" }],
  }
}

function validateIdentity(
  manifestValue: unknown,
  preparedValue: unknown,
): { identity?: WorkspaceIdentity; booleans: Record<string, boolean> } {
  const manifest = expectedManifest(manifestValue)
  const prepared = asObject(preparedValue)
  const preparedWorkingDirectoryValue = readString(prepared ?? {}, "working_directory")
  const identity = prepared
    ? {
        workspaceID: readString(prepared, "workspace_id") ?? "",
        root: readString(prepared, "root") ?? "",
        workingDirectory: preparedWorkingDirectoryValue ?? "",
        registryDir: readString(prepared, "registry_dir") ?? "",
        bucket: readString(prepared, "bucket") ?? "",
      }
    : undefined

  const preparedWorkingDirectory = identity && manifest
    ? canonicalWithin(manifest.root, identity.workingDirectory)
    : undefined
  const manifestWorkingDirectory = manifest
    ? canonicalWithin(manifest.root, manifest.working_directory)
    : undefined
  const booleans = {
    manifestV1: Boolean(manifest),
    preparedV1: prepared?.version === 1,
    workspaceIDValid: Boolean(identity && validWorkspaceID(identity.workspaceID)),
    rootMatches: Boolean(identity && manifest && resolve(identity.root) === resolve(manifest.root)),
    workingDirectoryWithinRoot: Boolean(preparedWorkingDirectory),
    workingDirectoryMatches: Boolean(
      preparedWorkingDirectory && manifestWorkingDirectory && preparedWorkingDirectory === manifestWorkingDirectory,
    ),
    registryMatches: Boolean(identity && manifest && resolve(identity.registryDir) === resolve(manifest.registry_dir)),
    bucketMatches: Boolean(identity && manifest && identity.bucket === manifest.bucket),
  }

  if (
    !manifest ||
    !identity ||
    !preparedWorkingDirectoryValue ||
    !booleans.preparedV1 ||
    !booleans.workspaceIDValid ||
    !booleans.rootMatches ||
    !booleans.workingDirectoryWithinRoot ||
    !booleans.workingDirectoryMatches ||
    !booleans.registryMatches ||
    !booleans.bucketMatches
  ) {
    return { booleans }
  }

  return {
    identity: {
      ...identity,
      root: resolve(identity.root),
      workingDirectory: preparedWorkingDirectory!,
      registryDir: resolve(identity.registryDir),
    },
    booleans,
  }
}

function loopbackEndpoint(value: unknown): URL | undefined {
  if (typeof value !== "string" || value.length > 512) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash || !url.port) return undefined
  const port = Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  const ipVersion = isIP(hostname)
  const loopback =
    hostname === "localhost" ||
    (ipVersion === 4 && Number(hostname.split(".")[0]) === 127) ||
    (ipVersion === 6 && hostname === "::1")
  return loopback ? url : undefined
}

function validateReadiness(
  manifestValue: unknown,
  preparedValue: unknown,
  readinessValue: unknown,
): { identity?: WorkspaceIdentity; client?: S3ClientConfiguration; booleans: Record<string, boolean> } {
  const identityResult = validateIdentity(manifestValue, preparedValue)
  const readiness = asObject(readinessValue)
  const identity = identityResult.identity
  const endpoint = readiness ? loopbackEndpoint(readiness.endpoint) : undefined
  const endpointValid = Boolean(endpoint)
  const readinessMatches = {
    readinessV1: readiness?.version === 1,
    workspaceIDMatches: Boolean(identity && readiness?.workspace_id === identity.workspaceID),
    rootMatches: Boolean(identity && typeof readiness?.root === "string" && resolve(readiness.root) === resolve(identity.root)),
    workingDirectoryMatches: Boolean(
      identity && typeof readiness?.working_directory === "string" &&
        canonicalWithin(identity.root, readiness.working_directory) === identity.workingDirectory,
    ),
    registryMatches: Boolean(
      identity && typeof readiness?.registry_dir === "string" && resolve(readiness.registry_dir) === resolve(identity.registryDir),
    ),
    bucketMatches: Boolean(identity && readiness?.bucket === identity.bucket),
    endpointLoopback: endpointValid,
    regionPresent: Boolean(readString(readiness ?? {}, "region")),
    accessKeyPresent: Boolean(readString(readiness ?? {}, "access_key_id")),
    secretKeyPresent: Boolean(readString(readiness ?? {}, "secret_access_key")),
  }
  const booleans = { ...identityResult.booleans, ...readinessMatches }

  if (
    !identity ||
    !readiness ||
    !endpoint ||
    !readinessMatches.readinessV1 ||
    !readinessMatches.workspaceIDMatches ||
    !readinessMatches.rootMatches ||
    !readinessMatches.workingDirectoryMatches ||
    !readinessMatches.registryMatches ||
    !readinessMatches.bucketMatches ||
    !readinessMatches.regionPresent ||
    !readinessMatches.accessKeyPresent ||
    !readinessMatches.secretKeyPresent
  ) {
    return { booleans }
  }

  return {
    identity,
    booleans,
    client: {
      endpoint: readiness.endpoint as string,
      region: readiness.region as string,
      accessKeyId: readiness.access_key_id as string,
      secretAccessKey: readiness.secret_access_key as string,
      bucket: identity.bucket,
    },
  }
}

async function readJson(path: string): Promise<unknown> {
  return Bun.file(path).json()
}

function newClient(config: S3ClientConfiguration): Bun.S3Client {
  s3ClientConstructions++
  return new Bun.S3Client({
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    virtualHostedStyle: false,
  })
}

function safeIdentityFlags(
  identity: WorkspaceIdentity | undefined,
  manifestValue: unknown,
): Record<string, boolean> {
  const manifest = expectedManifest(manifestValue)
  return {
    workspaceIDPresent: Boolean(identity?.workspaceID),
    rootMatches: Boolean(identity && manifest && resolve(identity.root) === resolve(manifest.root)),
    registryMatches: Boolean(identity && manifest && resolve(identity.registryDir) === resolve(manifest.registry_dir)),
    bucketMatches: Boolean(identity && manifest && identity.bucket === manifest.bucket),
  }
}

async function prepareCheck(manifestPath: string, preparedPath: string): Promise<void> {
  operation = "validate-prepared-descriptor"
  const [manifest, prepared] = await Promise.all([readJson(manifestPath), readJson(preparedPath)])
  const checked = validateIdentity(manifest, prepared)
  const ok = Boolean(checked.identity)
  process.stdout.write(`${JSON.stringify({
    mode,
    ok,
    ...safeIdentityFlags(checked.identity, manifest),
    workspaceIDValid: checked.booleans.workspaceIDValid === true,
    workingDirectoryWithinRoot: checked.booleans.workingDirectoryWithinRoot === true,
    workingDirectoryMatchesManifest: checked.booleans.workingDirectoryMatches === true,
    versionMatches: checked.booleans.manifestV1 === true && checked.booleans.preparedV1 === true,
  })}\n`)
  if (!ok) process.exit(2)
}

async function validationSelfTest(manifestPath: string, preparedPath: string, readyPath: string): Promise<void> {
  operation = "readiness-validation-selftest"
  const [manifestValue, preparedValue, readyValue] = await Promise.all([
    readJson(manifestPath),
    readJson(preparedPath),
    readJson(readyPath),
  ])
  const base = validateReadiness(manifestValue, preparedValue, readyValue)
  if (!base.client || !base.identity) {
    process.stdout.write(`${JSON.stringify({ mode, ok: false, validReadinessAccepted: false, s3ClientConstructions })}\n`)
    process.exit(2)
  }
  const readiness = asObject(readyValue)!
  const prepared = asObject(preparedValue)!
  const missingWorkingDirectory = { ...prepared }
  delete missingWorkingDirectory.working_directory
  const missingPreparedWorkingDirectoryRejected =
    !validateIdentity(manifestValue, missingWorkingDirectory).identity
  const relativeWorkingDirectory = validateIdentity(manifestValue, {
    ...prepared,
    working_directory: ".",
  })
  const relativeWorkingDirectoryCanonicalized =
    relativeWorkingDirectory.identity?.workingDirectory === resolve("/workspace/stow-workspace")
  const rejects = (changed: JsonObject): boolean =>
    !validateReadiness(manifestValue, preparedValue, changed).client

  const versionRejected = rejects({ ...readiness, version: 2 })
  const foreignRootRejected = rejects({ ...readiness, root: "/tmp/stow-b1-foreign-root" })
  const foreignWorkspaceIDRejected = rejects({ ...readiness, workspace_id: "codex-foreign-workspace" })
  const offLoopbackEndpointRejected = rejects({ ...readiness, endpoint: "http://192.0.2.1:9000" })
  const noClientBeforeValidation = s3ClientConstructions === 0
  const ok = versionRejected && foreignRootRejected && foreignWorkspaceIDRejected && offLoopbackEndpointRejected &&
    missingPreparedWorkingDirectoryRejected && relativeWorkingDirectoryCanonicalized && noClientBeforeValidation
  process.stdout.write(`${JSON.stringify({
    mode,
    ok,
    validReadinessAccepted: true,
    versionRejected,
    foreignRootRejected,
    foreignWorkspaceIDRejected,
    offLoopbackEndpointRejected,
    missingPreparedWorkingDirectoryRejected,
    relativeWorkingDirectoryCanonicalized,
    noClientBeforeValidation,
    s3ClientConstructions,
  })}\n`)
  if (!ok) process.exit(2)
}

async function workspaceCheck(
  manifestPath: string,
  preparedPath: string,
  readyPath: string,
  phase: "first" | "restart",
): Promise<void> {
  operation = "validate-readiness-before-client"
  const [manifestValue, preparedValue, readyValue] = await Promise.all([
    readJson(manifestPath),
    readJson(preparedPath),
    readJson(readyPath),
  ])
  const checked = validateReadiness(manifestValue, preparedValue, readyValue)
  if (!checked.client || !checked.identity) {
    process.stdout.write(`${JSON.stringify({
      mode,
      phase,
      ok: false,
      readinessValid: false,
      ...safeIdentityFlags(checked.identity, manifestValue),
      endpointLoopback: checked.booleans.endpointLoopback === true,
      s3ClientConstructed: false,
    })}\n`)
    process.exit(2)
  }

  // Construct the client only after the complete manifest/descriptor/readiness
  // identity and endpoint checks pass.
  const client = newClient(checked.client)
  const absoluteWorkingDirectory = checked.identity.workingDirectory
  const directPath = resolve(absoluteWorkingDirectory, directKey)
  const s3Path = resolve(absoluteWorkingDirectory, s3Key)
  const directBytes = new TextEncoder().encode(directMarker)
  const s3Bytes = new TextEncoder().encode(s3Marker)
  let directReadMatches = false
  let s3WriteMatches = false

  if (phase === "first") {
    operation = "write-direct-workspace-file"
    await Bun.write(directPath, directBytes)
  }

  operation = phase === "first" ? "read-direct-file-from-s3" : "read-preserved-direct-file-from-s3"
  const directObjectBytes = new Uint8Array(await client.file(directKey).arrayBuffer())
  directReadMatches = directObjectBytes.length === directBytes.length &&
    directObjectBytes.every((value, index) => value === directBytes[index])

  if (phase === "first") {
    operation = "put-s3-object"
    await client.file(s3Key).write(s3Bytes)
  }
  operation = phase === "first" ? "read-s3-put-from-workspace" : "read-preserved-s3-put-from-workspace"
  const workspaceBytes = new Uint8Array(await Bun.file(s3Path).arrayBuffer())
  s3WriteMatches = workspaceBytes.length === s3Bytes.length && workspaceBytes.every((value, index) => value === s3Bytes[index])

  const identityFlags = safeIdentityFlags(checked.identity, manifestValue)
  const ok = directReadMatches && s3WriteMatches && Object.values(identityFlags).every(Boolean)
  process.stdout.write(`${JSON.stringify({
    mode,
    phase,
    ok,
    readinessValid: true,
    ...identityFlags,
    endpointLoopback: true,
    directFileToS3GetMatches: directReadMatches,
    s3PutToWorkspaceFileMatches: s3WriteMatches,
    s3ClientConstructed: true,
  })}\n`)
  if (!ok) process.exit(2)
}

const args = process.argv.slice(3)
const expectedArguments: Record<string, number> = {
  characterize: 0,
  mutate: 0,
  "workspace-prepare-check": 2,
  "workspace-validation-selftest": 3,
  "workspace-first": 3,
  "workspace-restart": 3,
}
if (!mode || expectedArguments[mode] === undefined || args.length !== expectedArguments[mode]) {
  process.stderr.write("usage: bun stow-s3-probe.ts characterize|mutate|workspace-prepare-check|workspace-validation-selftest|workspace-first|workspace-restart [private files]\n")
  process.exit(64)
}

const deadline = setTimeout(() => {
  process.stdout.write(`${JSON.stringify({ mode, ok: false, operation, timedOut: true })}\n`)
  process.exit(124)
}, mode === "workspace-prepare-check" || mode === "workspace-validation-selftest" ? 15_000 : 12_000)

try {
  if (mode === "characterize" || mode === "mutate") {
    const bucket = "stow-characterization"
    const client = newClient({
      endpoint: "http://127.0.0.1:9000",
      region: "us-east-1",
      bucket,
      accessKeyId: "stow",
      secretAccessKey: "stow-secret",
    })
    if (mode === "mutate") {
      operation = "object-mutation-put"
      await client.file("characterization-object-mutation.txt").write("synthetic-second-object-mutation-v1\n")
      process.stdout.write(`${JSON.stringify({ client: "Bun.S3Client", bucket, objectMutationPut: true, ok: true, mode })}\n`)
    } else {
      const genericDirectKey = "characterization-direct.txt"
      const objectKey = "characterization-object-only.txt"
      const directMarker = "synthetic-direct-workspace-bytes-v1\n"
      const objectMarker = "synthetic-object-store-only-bytes-v1\n"

      operation = "direct-workspace-write"
      await Bun.write(`/workspace/${genericDirectKey}`, directMarker)
      operation = "direct-file-s3-exists"
      const directVisible = await client.file(genericDirectKey).exists()

      operation = "object-only-put"
      const object = client.file(objectKey)
      const objectURLPath = new URL(object.presign({ method: "PUT", expiresIn: 60 })).pathname
      await object.write(objectMarker)
      operation = "object-only-get"
      const objectGetMatches = (await object.text()) === objectMarker
      operation = "object-workspace-visibility"
      const objectVisibleAsWorkspace = await Bun.file(`/workspace/${objectKey}`).exists()

      const ok = !directVisible && objectGetMatches && !objectVisibleAsWorkspace
      process.stdout.write(`${JSON.stringify({
        client: "Bun.S3Client",
        bucket,
        directFileWritten: true,
        directFileVisibleInS3: directVisible,
        objectURLPath,
        objectPut: true,
        objectGetMatches,
        objectVisibleAsWorkspaceFile: objectVisibleAsWorkspace,
        ok,
        mode,
      })}\n`)
      if (!ok) process.exit(2)
    }
  } else if (mode === "workspace-prepare-check") {
    await prepareCheck(args[0], args[1])
  } else if (mode === "workspace-validation-selftest") {
    await validationSelfTest(args[0], args[1], args[2])
  } else if (mode === "workspace-first") {
    await workspaceCheck(args[0], args[1], args[2], "first")
  } else if (mode === "workspace-restart") {
    await workspaceCheck(args[0], args[1], args[2], "restart")
  }
} catch (error) {
  const errorFields = error && typeof error === "object"
    ? error as { name?: unknown; status?: unknown; statusCode?: unknown; code?: unknown }
    : undefined
  const result: JsonObject = {
    mode,
    ok: false,
    operation,
    errorClass: typeof errorFields?.name === "string" ? errorFields.name : "unknown",
  }
  const status = errorFields?.statusCode ?? errorFields?.status
  if (typeof status === "number" && Number.isInteger(status)) result.errorStatus = status
  if (typeof errorFields?.code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(errorFields.code)) {
    result.errorCode = errorFields.code
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exit(1)
} finally {
  clearTimeout(deadline)
}
