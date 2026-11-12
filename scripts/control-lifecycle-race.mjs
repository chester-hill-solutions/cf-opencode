#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import http from "node:http"

const [baseValue, containerName, kind, archivePath] = process.argv.slice(2)
const token = process.env.CONTROL_TOKEN
const runtime = process.env.RUNTIME ?? "docker"
const deadlineMs = 110_000
let phase = "validate-arguments"
let operationRequest
let releaseOperation
let startSettled = false
let operationStatus
let startStatus
let startProof = false

function fail(errorPhase, error) {
  const errorClass = error && typeof error === "object" && typeof error.name === "string"
    ? error.name
    : "Error"
  process.stdout.write(`${JSON.stringify({ mode: "host-lifecycle-race", ok: false, kind, errorPhase, errorClass, operationStatus, startStatus })}\n`)
  process.exitCode = 1
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function request(base, method, pathname, { body, headers = {}, timeoutMs = deadlineMs } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base)
    const req = http.request(url, { method, headers, agent: false }, (res) => {
      const chunks = []
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
      res.on("error", reject)
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error("request timeout")))
    req.on("error", reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

function observe(container) {
  if (runtime !== "docker" && runtime !== "container") throw new Error("unsupported-runtime")
  const result = spawnSync(runtime, ["exec", container, "bun", "/tmp/stow-s3-probe.ts", "native-lifecycle-observe"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  })
  if (result.error || result.status !== 0) throw new Error("observer-failed")
  let value
  try {
    value = JSON.parse(result.stdout)
  } catch {
    throw new Error("observer-invalid-json")
  }
  if (
    value?.ok !== true ||
    (value.workspaceID !== null && typeof value.workspaceID !== "string") ||
    typeof value.initialized !== "boolean" ||
    !Array.isArray(value.workspaceEntries) ||
    !value.workspaceEntries.every((entry) => typeof entry === "string") ||
    !Number.isInteger(value.opencodeProcessCount) ||
    !Number.isInteger(value.stowProcessCount)
  ) {
    throw new Error("observer-invalid-result")
  }
  return value
}

function sameSnapshot(a, b) {
  return a.workspaceID === b.workspaceID &&
    a.initialized === b.initialized &&
    JSON.stringify(a.workspaceEntries) === JSON.stringify(b.workspaceEntries) &&
    a.opencodeProcessCount === b.opencodeProcessCount &&
    a.stowProcessCount === b.stowProcessCount
}

function beginUpload(base, pathname, archive, auth, timeoutMs) {
  let resolveResponse
  let rejectResponse
  const responsePromise = new Promise((resolve, reject) => {
    resolveResponse = resolve
    rejectResponse = reject
  })
  const url = new URL(pathname, base)
  const req = http.request(url, {
    method: "POST",
    agent: false,
    headers: {
      authorization: auth,
      "content-type": "application/gzip",
      "content-length": archive.length,
    },
  }, (res) => {
    const chunks = []
    res.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
    res.on("end", () => resolveResponse({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
    res.on("error", rejectResponse)
  })
  req.setTimeout(timeoutMs, () => req.destroy(new Error("operation request timeout")))
  req.on("error", rejectResponse)
  req.flushHeaders()
  const split = Math.max(1, Math.floor(archive.length / 2))
  req.write(archive.subarray(0, split))
  let released = false
  const release = () => {
    if (released) return
    released = true
    req.end(archive.subarray(split))
  }
  return { promise: responsePromise, release }
}

function parseJson(response) {
  try {
    return JSON.parse(response.body.toString("utf8"))
  } catch {
    return undefined
  }
}

async function main() {
  if (!baseValue || !containerName || !["seed", "restore"].includes(kind) || !archivePath || !token) {
    throw new Error("invalid-arguments")
  }
  const base = new URL(baseValue).origin
  const archive = await readFile(archivePath)
  if (archive.length < 2) throw new Error("archive-empty")
  const target = kind === "seed" ? "/seed-state" : "/restore?part=state"
  const auth = `Bearer ${token}`
  const before = observe(containerName)
  phase = "start-operation-stream"
  const upload = beginUpload(base, target, archive, auth, deadlineMs)
  operationRequest = upload.promise
  operationRequest.catch(() => {})
  releaseOperation = upload.release

  let startPromise
  let statusRespondedWhileHeld = false
  let noNewStateOrChildrenWhileHeld = false
  let startBlockedUntilBodyComplete = false
  let heldSnapshot
  try {
    phase = "allow-first-chunk-to-arrive"
    await delay(100)
    phase = "queue-start"
    startPromise = request(base, "POST", "/start", {
      headers: { authorization: auth },
      timeoutMs: deadlineMs,
    }).then((result) => {
      startSettled = true
      return result
    })
    startPromise.catch(() => {})
    await Promise.race([startPromise, delay(250)])
    startBlockedUntilBodyComplete = !startSettled

    phase = "observe-held-state"
    const status = await request(base, "GET", "/status", {
      headers: { authorization: auth },
      timeoutMs: 5_000,
    })
    const statusBody = parseJson(status)
    statusRespondedWhileHeld = status.status === 200 && typeof statusBody?.initialized === "boolean"
    heldSnapshot = observe(containerName)
    noNewStateOrChildrenWhileHeld = statusRespondedWhileHeld &&
      statusBody.initialized === before.initialized && sameSnapshot(before, heldSnapshot)
  } finally {
    releaseOperation?.()
  }

  phase = "await-operation-and-start"
  const [operation, start] = await Promise.all([operationRequest, startPromise])
  operationStatus = operation.status
  startStatus = start.status
  const startBody = parseJson(start)
  startProof = startBody?.ok === true && startBody?.eventPersistence === true
  phase = "observe-completed-state"
  const after = observe(containerName)
  const identityMatches = kind === "seed"
    ? typeof after.workspaceID === "string" && after.workspaceID.length > 0 && after.workspaceID !== before.workspaceID
    : typeof after.workspaceID === "string" && after.workspaceID === before.workspaceID
  const ok = operation.status === 200 && start.status === 200 && startBlockedUntilBodyComplete &&
    noNewStateOrChildrenWhileHeld && identityMatches && startProof
  process.stdout.write(`${JSON.stringify({
    mode: "host-lifecycle-race",
    ok,
    kind,
    operationStatus,
    startStatus,
    statusRespondedWhileHeld,
    startBlockedUntilBodyComplete,
    noNewStateOrChildrenWhileHeld,
    workspaceIdentityMatchesOperation: identityMatches,
    runtimeProofReturned: startProof,
  })}\n`)
  if (!ok) process.exitCode = 1
}

const timer = setTimeout(() => {
  releaseOperation?.()
  fail(phase, new Error("deadline"))
  process.exit(1)
}, deadlineMs + 5_000)

main().catch((error) => fail(phase, error)).finally(() => clearTimeout(timer))
