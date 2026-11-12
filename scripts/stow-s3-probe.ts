/**
 * Disposable in-container characterization of Bun's signed S3 client against
 * the existing generic `stow-s3 serve --backend filesystem` endpoint.
 * Credentials and keys are fixed synthetic fixture values and are never
 * included in output.
 */

export {}

const mode = process.argv[2]
if (mode !== "characterize" && mode !== "mutate") {
  process.stderr.write("usage: bun stow-s3-probe.ts characterize|mutate\n")
  process.exit(64)
}

const bucket = "stow-characterization"
const client = new Bun.S3Client({
  endpoint: "http://127.0.0.1:9000",
  bucket,
  region: "us-east-1",
  accessKeyId: "stow",
  secretAccessKey: "stow-secret",
  virtualHostedStyle: false,
})

const result: Record<string, unknown> = { client: "Bun.S3Client", bucket }
let operation = "initialize-client"

// A hard deadline ensures a broken local S3 endpoint cannot leave a Docker
// exec hanging indefinitely. The host runner also has an outer process timeout.
const deadline = setTimeout(() => {
  process.stdout.write(`${JSON.stringify({ ...result, mode, ok: false, timedOut: true })}\n`)
  process.exit(124)
}, 12_000)

try {
  if (mode === "mutate") {
    operation = "object-mutation-put"
    await client.file("characterization-object-mutation.txt").write("synthetic-second-object-mutation-v1\n")
    result.objectMutationPut = true
    result.ok = true
    process.stdout.write(`${JSON.stringify({ ...result, mode })}\n`)
  } else {
    const directKey = "characterization-direct.txt"
    const objectKey = "characterization-object-only.txt"
    const directMarker = "synthetic-direct-workspace-bytes-v1\n"
    const objectMarker = "synthetic-object-store-only-bytes-v1\n"

    operation = "direct-workspace-write"
    await Bun.write(`/workspace/${directKey}`, directMarker)
    result.directFileWritten = true

    operation = "direct-file-s3-exists"
    const directObject = client.file(directKey)
    result.directFileVisibleInS3 = await directObject.exists()

    operation = "object-only-put"
    const object = client.file(objectKey)
    // Record only the URL pathname; presigned query parameters are deliberately
    // discarded so credentials/signatures never enter the evidence.
    result.objectURLPath = new URL(object.presign({ method: "PUT", expiresIn: 60 })).pathname
    await object.write(objectMarker)
    result.objectPut = true
    operation = "object-only-get"
    result.objectGetMatches = (await object.text()) === objectMarker
    operation = "object-workspace-visibility"
    result.objectVisibleAsWorkspaceFile = await Bun.file(`/workspace/${objectKey}`).exists()

    if (result.directFileVisibleInS3 !== false || result.objectGetMatches !== true || result.objectVisibleAsWorkspaceFile !== false) {
      result.ok = false
      process.stdout.write(`${JSON.stringify({ ...result, mode })}\n`)
      process.exit(2)
    }

    result.ok = true
    process.stdout.write(`${JSON.stringify({ ...result, mode })}\n`)
  }
} catch (error) {
  // Error messages may contain request URLs or storage details; record only the
  // class so the bounded fixture never prints credentials or request content.
  result.ok = false
  result.errorClass = error instanceof Error ? error.name : "unknown"
  result.operation = operation
  if (typeof error === "object" && error !== null) {
    const fields = error as { status?: unknown; statusCode?: unknown; code?: unknown }
    const status = fields.statusCode ?? fields.status
    if (typeof status === "number" && Number.isInteger(status)) result.errorStatus = status
    if (typeof fields.code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(fields.code)) {
      result.errorCode = fields.code
    }
  }
  process.stdout.write(`${JSON.stringify({ ...result, mode })}\n`)
  process.exit(1)
} finally {
  clearTimeout(deadline)
}
