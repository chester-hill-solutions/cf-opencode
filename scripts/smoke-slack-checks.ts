#!/usr/bin/env bun
/** Real Worker/DO/R2 + signed synthetic Slack + real host collector/images.
 * The only fixtures are Slack delivery and the loopback control transport.
 * Never builds/pulls images, loads .dev.vars, sends live Slack, or sends a prompt.
 */
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { boundedDockerRunner, type DockerRunner } from "./workspace-check-docker"
import { runWorkspaceCheckRunner } from "./workspace-check-runner"
import { SLACK_CANARY_CHANNEL } from "../src/slack-canary"

const probeOnly = process.argv.includes("--probe-only")
const directory = await mkdtemp(join(tmpdir(), "aboiteau-slack-check-bridge-"))
const runID = randomUUID(), sourceName = "aboiteau-slack-check-" + runID
const controlToken = "synthetic-control-" + randomUUID(), signingSecret = "synthetic-signing-" + randomUUID()
const apiToken = "synthetic-api-" + randomUUID(), collectorToken = "synthetic-collector-" + randomUUID(), collectorID = randomUUID()
const rootTS = Math.floor(Date.now() / 1000) + ".123456", conversation = SLACK_CANARY_CHANNEL + ":" + rootTS
const docker = boundedDockerRunner(), calls: string[] = [], posts: Record<string, unknown>[] = []
const summary: Record<string, unknown> = { schemaVersion: 1, runID, evidenceDirectory: directory,
  worker: "Production bundled Worker, Conversation, Settings, local SQLite Durable Objects and local R2",
  fixtures: ["synthetic signed Slack HTTP; chat.postMessage captured outside Worker", "fixed loopback control proxy maps the external runtime port and replaces synthetic control authorization"],
  providerExecutionRequested: false, providerCredentialsSupplied: false, promptRequestsObserved: 0,
}
let sourceCreated = false, sourceBase = "", workerBase = "", mf: any
console.log("evidence directory: " + directory)

async function dock(args: string[], input?: string): Promise<string> {
  const result = await docker(args, { timeoutMs: 120000, input })
  if (result.exitCode !== 0 || result.timedOut || result.outputExceeded) throw new Error("Bounded Docker " + args[0] + " failed")
  return new TextDecoder().decode(result.stdout).trim()
}
async function waitFor<T>(description: string, work: () => Promise<T | undefined>, milliseconds = 30000): Promise<T> {
  const end = Date.now() + milliseconds
  while (Date.now() < end) {
    const value = await work()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(description + " deadline exceeded")
}
async function api(path: string, init: RequestInit = {}, token = apiToken) {
  return fetch(workerBase + path, { ...init, redirect: "error", signal: AbortSignal.timeout(30000), headers: { authorization: "Bearer " + token, ...Object.fromEntries(new Headers(init.headers)) } })
}
async function signed(path: string, body: string) {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`))
  const signature = "v0=" + Buffer.from(mac).toString("hex")
  return fetch(workerBase + path, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30000), headers: {
    "content-type": "application/json", "x-slack-request-timestamp": timestamp, "x-slack-signature": signature,
  }, body })
}
async function slack(text: string, id: string, root = false) {
  const body = JSON.stringify({ type: "event_callback", team_id: "TSMOKE", event_id: id, event: {
    type: root ? "app_mention" : "message", channel: SLACK_CANARY_CHANNEL, channel_type: "channel", user: "USMOKE",
    ts: root ? rootTS : Math.floor(Date.now() / 1000) + "." + String(Math.floor(Math.random() * 1000000)).padStart(6, "0"),
    ...(root ? {} : { thread_ts: rootTS }), text,
  } })
  if (root) {
    const decision = await signed("/slack/canary-route?kind=events", body)
    assert.equal(decision.status, 200)
    assert.deepEqual(await decision.json(), { route: "canary", channel: SLACK_CANARY_CHANNEL, threadTs: rootTS })
  }
  const response = await signed("/slack/events", body)
  assert.equal(response.status, 200)
}
async function binding() {
  const response = await api(`/api/conversations/${encodeURIComponent(conversation)}/workspace/repository`)
  assert.equal(response.status, 200)
  return (await response.json() as { workspaceRepository: Record<string, unknown> | null }).workspaceRepository
}
async function git(args: string[]): Promise<string> {
  return dock(["exec", "--user", "1001:1001", sourceName, "env", "-u", "CONTROL_TOKEN", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1", "GIT_ALLOW_PROTOCOL=", "GIT_NO_LAZY_FETCH=1", "GIT_NO_REPLACE_OBJECTS=1", "GIT_GRAFT_FILE=/dev/null", "git", "-C", "/workspace", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args])
}

try {
  const wranglerDirectory = dirname(Bun.resolveSync("wrangler", dirname(import.meta.dir)))
  const { build } = await import(pathToFileURL(Bun.resolveSync("esbuild", wranglerDirectory)).href)
  const { Miniflare, convertV4MiniflareOptions, Response: MFResponse } = await import(pathToFileURL(Bun.resolveSync("miniflare", wranglerDirectory)).href)
  const bundle = join(directory, "worker.mjs")
  await build({ entryPoints: [join(import.meta.dir, "../src/index.ts")], outfile: bundle, bundle: true, format: "esm", platform: "neutral", target: "es2022", external: ["cloudflare:*", "node:*"], conditions: ["workerd", "worker", "browser"], logLevel: "silent" })
  let imageID = "sha256:" + "b".repeat(64), platform = "linux/arm64"
  if (!probeOnly) {
    assert(process.env.AGENT_IMAGE && process.env.CHECK_IMAGE, "Set existing AGENT_IMAGE and CHECK_IMAGE; no build/pull occurs")
    const source = JSON.parse(await dock(["image", "inspect", process.env.AGENT_IMAGE]))[0]
    const checker = JSON.parse(await dock(["image", "inspect", process.env.CHECK_IMAGE]))[0]
    imageID = checker.Id; platform = checker.Os + "/" + checker.Architecture
    summary.sourceImageID = source.Id; summary.sourcePlatform = source.Os + "/" + source.Architecture
    summary.checkerImageID = imageID; summary.checkerPlatform = platform
    await dock(["run", "--pull=never", "--detach", "--name", sourceName, "--label", "org.aboiteau.slack-check.smoke=" + runID,
      "--env", "CONTROL_TOKEN=" + controlToken, "--publish", "127.0.0.1::4001", source.Id])
    sourceCreated = true
    const address = await dock(["port", sourceName, "4001/tcp"])
    assert.match(address, /^127\.0\.0\.1:[0-9]+$/); sourceBase = "http://" + address
    await waitFor("Source health", async () => { try { const response = await fetch(sourceBase + "/health", { signal: AbortSignal.timeout(1000) }); return response.ok ? true : undefined } catch { return undefined } }, 30000)
  }
  mf = new Miniflare(convertV4MiniflareOptions({ host: "127.0.0.1", port: 0, resourcePersistencePath: join(directory, "storage"), workers: [{ name: "aboiteau-slack-check-smoke",
    rootPath: directory, scriptPath: bundle, modules: true,
    compatibilityDate: "2026-08-22", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { CONVERSATION: { className: "Conversation", useSQLite: true }, SETTINGS: { className: "Settings", useSQLite: true } }, r2Buckets: ["CHECKPOINTS"],
    bindings: { API_TOKEN: apiToken, VAULT_MASTER_KEY: "ab".repeat(32), WORKSPACE_REPO: "", OPENCODE_MODEL: "opencode/deepseek-v4.1-flash", POLL_SECONDS: "2", EVENTED_FRESH_CONVERSATIONS: "false",
      CONTAINER_URL: "http://control.fixture", SLACK_SIGNING_SECRET: signingSecret, SLACK_BOT_TOKEN: "synthetic-slack-token", SLACK_BOT_USER_ID: "UBOT",
      SLACK_CANARY_CHANNEL: SLACK_CANARY_CHANNEL, SLACK_CANARY_NEW_THREADS: "true", SLACK_CANARY_START_TS: Math.floor(Date.now() / 1000 - 60) + ".000000",
      CHECK_SLACK_CHANNEL_ID: SLACK_CANARY_CHANNEL, CHECK_COLLECTOR_TOKEN: collectorToken, CHECK_COLLECTOR_ID: collectorID, CHECK_RUNNER_IMAGE_ID: imageID, CHECK_RUNNER_PLATFORM: platform, CHECK_RUNNER_TIMEOUT_MS: "20000" },
    outboundService: async (request: Request) => {
      const url = new URL(request.url)
      calls.push(request.method + " " + url.host + url.pathname)
      if (url.origin === "https://slack.com" && url.pathname === "/api/chat.postMessage") {
        const post = await request.json() as Record<string, unknown>
        assert.equal(post.channel, SLACK_CANARY_CHANNEL); assert.equal(post.thread_ts, rootTS)
        posts.push(post)
        await appendFile(join(directory, "slack-outbox.jsonl"), JSON.stringify(post) + "\n", { mode: 0o600 })
        return new MFResponse(JSON.stringify({ ok: true, channel: SLACK_CANARY_CHANNEL, ts: rootTS }), { headers: { "content-type": "application/json" } })
      }
      if (url.hostname === "control.fixture" && url.port === "4001" && sourceBase) {
        if (url.pathname.startsWith("/opencode/") && !["/opencode/api/config", "/opencode/api/model"].includes(url.pathname)) {
          summary.promptRequestsObserved = Number(summary.promptRequestsObserved) + 1
          throw new Error("Forbidden model/session operation in model-free smoke")
        }
        const target = sourceBase + url.pathname + url.search, headers = new Headers(request.headers)
        headers.set("authorization", "Bearer " + controlToken)
        const response = await fetch(target, { method: request.method, headers, redirect: "error", signal: AbortSignal.timeout(120000),
          ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: await request.arrayBuffer() }),
        })
        return new MFResponse(response.status === 204 ? null : await response.arrayBuffer(), { status: response.status, headers: Object.fromEntries(response.headers) })
      }
      throw new Error("Outbound request refused by local smoke fixture")
    },
  }] }))
  workerBase = (await mf.ready).origin
  assert.equal((await fetch(workerBase + "/health")).status, 200)
  summary.bundleSHA256 = createHash("sha256").update(await readFile(bundle)).digest("hex")
  if (probeOnly) {
    summary.probeOnly = true; summary.passed = true
  } else {
    console.log("signed Slack repository selection")
    await slack("<@UBOT> !repo https://github.com/octocat/hello-world master aboiteau/slack-smoke", "repo-" + runID, true)
    await waitFor("Repository selection", async () => (await binding())?.status === "pending" ? true : undefined)
    assert.equal(calls.some(call => call.includes("control.fixture")), false)
    console.log("signed model catalogue control warming the real runtime")
    await slack("!model", "model-" + runID)
    await waitFor("Bound runtime", async () => (await binding())?.status === "bound" ? true : undefined, 120000)
    await waitFor("Model control reply", async () => posts.length >= 2 ? true : undefined, 120000)
    const fixture = 'import{test,expect}from"bun:test";test("committed bridge fixture",()=>{expect(2+2).toBe(4);console.log("SLACK-BRIDGE-CHECK-RAN")})\n'
    await dock(["exec", "--interactive", "--user", "1001:1001", sourceName, "bun", "-e", 'await Bun.write("/workspace/smoke.test.ts",await Bun.stdin.text())'], fixture)
    await git(["-c", "user.name=Bridge Smoke", "-c", "user.email=smoke@example.invalid", "add", "--", "smoke.test.ts"])
    await git(["-c", "user.name=Bridge Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "Model-free local bridge fixture"])
    summary.commitOID = await git(["rev-parse", "HEAD"])
    await slack('!check ["bun","--no-env-file","--no-install","test","smoke.test.ts"]', "check-" + runID)
    const pendingPath = "/api/check-collector/pending"
    const pending = await waitFor("Actual queued check", async () => {
      const response = await api(pendingPath, {}, collectorToken)
      assert.equal(response.status, 200)
      const body = await response.json() as { pending: Array<Record<string, unknown>> }
      return body.pending.length ? body.pending[0] : undefined
    }, 30000)
    assert.equal(pending.conversationKey, conversation)
    summary.requestID = pending.requestID
    let executions = 0, completion: { url: string; body: string } | undefined
    const tracedDocker: DockerRunner = async (args, options) => { if (args[0] === "start") executions++; return docker(args, options) }
    const fetcher = async (request: Request) => {
      if (request.method === "POST" && new URL(request.url).pathname.endsWith("/complete")) completion = { url: request.url, body: await request.clone().text() }
      return fetch(request)
    }
    const runnerOptions = { url: workerBase, directory: join(directory, "runner"), collectorID, imageID, token: collectorToken, docker: tracedDocker, fetcher }
    console.log("actual host collector claim, Docker execution and authenticated completion")
    const result = await runWorkspaceCheckRunner(runnerOptions)
    assert.equal(result.status, "completed"); assert.equal(result.outcome, "passed"); assert.equal(executions, 1)
    Object.assign(summary, { result, executions })
    assert(completion, "completion must have crossed the real HTTP Worker boundary")
    const acknowledged = await api(new URL(completion.url).pathname, { method: "POST", headers: { "content-type": "application/json" }, body: completion.body }, collectorToken)
    assert.equal(acknowledged.status, 200)
    const replay = await acknowledged.json() as { execution: Record<string, unknown> }
    assert.equal(replay.execution.status, "completed")
    summary.completionReplayAccepted = true
    await writeFile(join(directory, "completion-replay.json"), JSON.stringify(replay, null, 2), { mode: 0o600 })
    const wrong = await api(new URL(completion.url).pathname, { method: "POST", headers: { "content-type": "application/json" }, body: completion.body }, apiToken)
    assert.equal(wrong.status, 401)
    summary.wrongTokenRejected = true
    const second = await runWorkspaceCheckRunner(runnerOptions)
    assert.equal(second.status, "idle"); assert.equal(executions, 1)
    summary.secondRunnerStatus = second.status
    const delivered = await waitFor("Actual check outbox delivery", async () => posts.find(post => typeof post.text === "string" && post.text.includes(String(pending.requestID)) && post.text.includes(": passed.")), 30000)
    assert.equal(delivered.thread_ts, rootTS)
    summary.checkOutboxDelivered = true
    const postsBeforeStatus = posts.length
    await slack("!checks", "status-" + runID)
    await waitFor("Signed check status reply", async () => posts.slice(postsBeforeStatus).find(post => typeof post.text === "string" && post.text.includes(String(pending.requestID)) && post.text.includes(": passed")), 10000)
    assert.equal(summary.promptRequestsObserved, 0)
    Object.assign(summary, { passed: true, executions, completionReplayAccepted: true, wrongTokenRejected: true, secondRunnerStatus: second.status, checkOutboxDelivered: true, signedStatusObserved: true, result })
  }
} catch (error) {
  summary.passed = false; summary.failure = error instanceof Error ? error.message : "Unknown smoke failure"
  process.exitCode = 1
} finally {
  if (mf) {
    try { await mf.dispose(); summary.workerCleanupConfirmed = true }
    catch { summary.workerCleanupConfirmed = false; process.exitCode = 1 }
  }
  if (sourceCreated) {
    try {
      const marker = await dock(["inspect", "--format", '{{index .Config.Labels "org.aboiteau.slack-check.smoke"}}', sourceName])
      assert.equal(marker, runID)
      await dock(["rm", "--force", sourceName])
      summary.sourceCleanupConfirmed = (await dock(["container", "ls", "--all", "--filter", "name=^/" + sourceName + "$", "--format", "{{.ID}}"])) === ""
    } catch { summary.sourceCleanupConfirmed = false; process.exitCode = 1 }
  }
  await writeFile(join(directory, "worker-outbound.json"), JSON.stringify(calls, null, 2), { mode: 0o600 })
  await writeFile(join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 })
  console.log("summary: " + join(directory, "summary.json"))
  console.log(JSON.stringify({ passed: summary.passed, failure: summary.failure, sourceCleanupConfirmed: summary.sourceCleanupConfirmed }))
}
