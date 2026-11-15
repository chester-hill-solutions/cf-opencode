import { execFileSync, spawnSync } from "node:child_process"
import { lstatSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { connect as netConnect } from "node:net"
import { PROVIDER_PROXY_HOST, PROVIDER_PROXY_PATH } from "../../src/provider-egress"
import { providerQualificationPassed, type ProviderQualificationResult } from "./result"
import { scanSameUIDEnvironments, scanStateFiles } from "./scans"
import { ChatCompletionSSEParser } from "./sse"

const STATE = "/var/lib/aboiteau/state"
const WORKSPACE = "/workspace"
const UPSTREAM_MARKER = "R1_7A_UPSTREAM_"
const STREAM_MARKER = "R1_7A_STREAM_OK"
const MAX_RESPONSE = 48 * 1024
const PROXY_URL = `http://${PROVIDER_PROXY_HOST}${PROVIDER_PROXY_PATH}`

function containsUpstreamSecret(bytes: Uint8Array | string): boolean {
  return typeof bytes === "string" ? bytes.includes(UPSTREAM_MARKER) : Buffer.from(bytes).includes(UPSTREAM_MARKER)
}

function stateExposure(): { exposed: boolean; complete: boolean; filesRead: number } {
  const scan = scanStateFiles(STATE, {
    entries: (path) => readdirSync(path),
    inspect(path) {
      const stat = lstatSync(path)
      return {
        kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
        size: stat.size,
      }
    },
    read: (path) => readFileSync(path),
  })
  let exposed = scan.exposed
  let complete = scan.complete
  // Repeat the direct read using the command vector exposed to the agent.
  try {
    const output = execFileSync("find", [STATE, "-type", "f", "-exec", "cat", "{}", "+"], {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    })
    exposed ||= containsUpstreamSecret(output)
  } catch {
    complete = false
  }
  try {
    if (scan.files.length > 0) {
      const output = execFileSync("cat", scan.files, {
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      })
      exposed ||= containsUpstreamSecret(output)
    }
  } catch {
    complete = false
  }
  return { exposed, complete, filesRead: scan.filesRead }
}

function sameUIDProcessExposure(): {
  exposed: boolean
  completed: boolean
  environmentsRead: number
  ownEnvironmentRead: boolean
} {
  const uid = process.getuid?.()
  if (uid === undefined) return { exposed: false, completed: false, environmentsRead: 0, ownEnvironmentRead: false }
  const scan = scanSameUIDEnvironments(String(process.pid), uid, {
    processIDs: () => readdirSync("/proc"),
    processUID: (pid) => statSync(`/proc/${pid}`).uid,
    environment: (pid) => readFileSync(`/proc/${pid}/environ`),
  })
  return {
    exposed: scan.exposed,
    completed: scan.complete,
    environmentsRead: scan.environmentsRead,
    ownEnvironmentRead: scan.ownEnvironmentRead,
  }
}

async function controlledBunExposure(): Promise<{ leaked: boolean; completed: boolean }> {
  const path = `${WORKSPACE}/.r1-provider-egress-${process.pid}.test.ts`
  const outputMarker = "R1_PROVIDER_TEST_LEAK="
  const source = `import { test } from "bun:test"; import { execFileSync } from "node:child_process"; test("repository test cannot read upstream secret", () => { let leaked=false; try { leaked=execFileSync("find", ["${STATE}", "-type", "f", "-exec", "cat", "{}", "+"], { maxBuffer: 67108864 }).includes("${UPSTREAM_MARKER}"); } catch {} process.stdout.write("${outputMarker}"+(leaked?"1":"0")); if (leaked) throw new Error("synthetic upstream marker visible"); });`
  try {
    writeFileSync(path, source, { mode: 0o600, flag: "wx" })
    const result = spawnSync(process.execPath, ["test", path], {
      cwd: WORKSPACE,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 16 * 1024,
    })
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
    return {
      leaked: output.includes(`${outputMarker}1`),
      completed: result.status === 0 && output.includes(`${outputMarker}0`),
    }
  } catch {
    return { leaked: false, completed: false }
  } finally {
    try {
      unlinkSync(path)
    } catch {
      // Do not expose or retain a temporary repository test.
    }
  }
}

async function postCompletion(token: string, model: string, stream: boolean, headers?: HeadersInit): Promise<Response> {
  return fetch(PROXY_URL, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(6000),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({
      model,
      stream,
      messages: [{ role: "user", content: "Return the qualification marker." }],
    }),
  })
}

async function jsonResponse(token: string, model: string): Promise<boolean> {
  try {
    const response = await postCompletion(token, model, false)
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return false
    const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> }
    return body.choices?.[0]?.message?.content === STREAM_MARKER
  } catch {
    return false
  }
}

async function sseResponse(token: string, model: string): Promise<{ ok: boolean; chunks: number }> {
  try {
    const response = await postCompletion(token, model, true)
    if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
      await response.body?.cancel()
      return { ok: false, chunks: 0 }
    }
    const reader = response.body.getReader()
    const parser = new ChatCompletionSSEParser(MAX_RESPONSE)
    let bytes = 0
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_RESPONSE) {
        await reader.cancel()
        return { ok: false, chunks: 0 }
      }
      parser.push(next.value)
    }
    const parsed = parser.finish()
    return { ok: parsed.valid && parsed.content.includes(STREAM_MARKER), chunks: parsed.chunks }
  } catch {
    return { ok: false, chunks: 0 }
  }
}

async function rejected(request: () => Promise<Response>, expected: number): Promise<boolean> {
  try {
    const response = await request()
    await response.body?.cancel()
    return response.status === expected
  } catch {
    return false
  }
}

async function blockedFetch(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual" })
    await response.body?.cancel()
    return false
  } catch {
    return true
  }
}

async function blockedTCP(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: "1.1.1.1", port: 443 })
    let finished = false
    const done = (blocked: boolean) => {
      if (finished) return
      finished = true
      socket.destroy()
      resolve(blocked)
    }
    socket.setTimeout(2000, () => done(true))
    socket.once("connect", () => done(false))
    socket.once("error", () => done(true))
  })
}

async function main(): Promise<void> {
  const token = process.env.PROVIDER_PROXY_TOKEN ?? ""
  const model = process.env.PROVIDER_PROXY_MODEL ?? ""
  const repoTest = await controlledBunExposure()
  const state = stateExposure()
  const sameUID = sameUIDProcessExposure()
  const result: ProviderQualificationResult = {
    agentUID1001: process.getuid?.() === 1001,
    cwdIsWorkspace: process.cwd() === WORKSPACE,
    configHasScopedToken: false,
    stateHasUpstreamSecret: state.exposed,
    stateScanCompleted: state.complete,
    stateFilesRead: state.filesRead,
    envHasUpstreamSecret: Object.values(process.env).some((value) => typeof value === "string" && value.includes(UPSTREAM_MARKER)),
    sameUIDProcHasUpstreamSecret: sameUID.exposed,
    sameUIDProcScanCompleted: sameUID.completed,
    sameUIDEnvironmentsRead: sameUID.environmentsRead,
    ownEnvironmentRead: sameUID.ownEnvironmentRead,
    repoBunTestCanReadUpstreamSecret: repoTest.leaked,
    repoBunTestCompleted: repoTest.completed,
    httpJson: false,
    sse: false,
    sseChunks: 0,
    wrongTokenRejected: false,
    wrongModelRejected: false,
    wrongPathRejected: false,
    hostSpoofRejected: false,
    wrongMethodRejected: false,
    exampleHttpBlocked: false,
    openaiHttpsBlocked: false,
    rawIPHttpsBlocked: false,
    rawIPTCPBlocked: false,
  }
  try {
    const config = JSON.parse(readFileSync(`${STATE}/config/opencode/opencode.json`, "utf8"))
    result.configHasScopedToken =
      config?.providers?.["aboiteau-proxy"]?.settings?.apiKey === token &&
      config?.providers?.["aboiteau-proxy"]?.settings?.baseURL === `http://${PROVIDER_PROXY_HOST}/v1` &&
      config?.model === `aboiteau-proxy/${model}`
  } catch {
    // The explicit false is part of the qualification result.
  }

  if (token.startsWith("prx_") && model) {
    result.httpJson = await jsonResponse(token, model)
    const sse = await sseResponse(token, model)
    result.sse = sse.ok
    result.sseChunks = sse.chunks
    result.wrongTokenRejected = await rejected(() => postCompletion(`prx_${"0".repeat(64)}`, model, true), 401)
    result.wrongModelRejected = await rejected(() => postCompletion(token, `${model}-wrong`, true), 403)
    result.wrongPathRejected = await rejected(() => fetch(`http://${PROVIDER_PROXY_HOST}/v1/not-allowed`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model, stream: true, messages: [] }),
      signal: AbortSignal.timeout(2000),
    }), 404)
    result.hostSpoofRejected = await rejected(() => postCompletion(token, model, true, { host: "spoof.invalid" }), 404)
    result.wrongMethodRejected = await rejected(() => fetch(PROXY_URL, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    }), 405)
  }

  result.exampleHttpBlocked = await blockedFetch("http://example.com/")
  result.openaiHttpsBlocked = await blockedFetch("https://api.openai.com/")
  result.rawIPHttpsBlocked = await blockedFetch("https://1.1.1.1/")
  result.rawIPTCPBlocked = await blockedTCP()

  const encoded = JSON.stringify(result)
  if (encoded.length > 8192) throw new Error("qualification result exceeded output limit")
  process.stdout.write(`${encoded}\n`)
  if (!providerQualificationPassed(result)) process.exitCode = 1
}

await main().catch(() => {
  process.stdout.write('{"probeFailed":true}\n')
  process.exitCode = 1
})
