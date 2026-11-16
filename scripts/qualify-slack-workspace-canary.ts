#!/usr/bin/env bun
/** Opt-in operator qualification only. Never creates a Slack message or sends a model prompt. */
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { parseWorkspaceRepositoryReceipt, parseWorkspaceRepositorySelection } from "../src/workspace-repository"
import { parseWorkspaceCheckArgv, parseWorkspaceCheckIntent } from "../src/workspace-check"
import { parseWorkspaceCheckExecution } from "../src/workspace-check-dispatch"
import { verifyWorkspaceCheckSnapshot } from "../src/workspace-check-snapshot"
import { parseWorkspacePreflight } from "../src/workspace-preflight"

const CHANNEL = "C0A5YNXLP6C", TS = /^[1-9]\d{8,12}\.\d{6}$/
type Fetcher = (request: Request) => Promise<Response>
export interface QualificationOptions {
  origin: string; channel: string; threadTS: string; startTS: string
  repository: string; baseBranch: string; workingBranch: string
  modelRef?: string; imageID: string; argv: string[]; apiToken: string; signingSecret: string
  recycle?: boolean; timeoutMs?: number; fetcher?: Fetcher
  evidence?(name: string, value: unknown): Promise<void>
  sleep?(milliseconds: number): Promise<void>
}
const micro = (value: string) => { const [s, f] = value.split("."); return BigInt(s!) * 1_000_000n + BigInt(f!) }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid response"); return value as Record<string, unknown> }
function validate(options: QualificationOptions) {
  const origin = new URL(options.origin)
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
    !((origin.protocol === "https:" && origin.hostname.startsWith("cf-opencode-arfin-canary-")) || (origin.protocol === "http:" && origin.hostname === "127.0.0.1")) ||
    options.channel !== CHANNEL || !TS.test(options.threadTS) || !TS.test(options.startTS) || micro(options.threadTS) < micro(options.startTS) ||
    !options.apiToken || !/^[\x21-\x7e]{1,4096}$/.test(options.apiToken) || options.signingSecret.length < 32 || !/^sha256:[a-f0-9]{64}$/.test(options.imageID) ||
    (options.modelRef !== undefined && !/^[A-Za-z0-9][A-Za-z0-9./:_#-]{0,199}$/.test(options.modelRef))) throw new Error("Invalid isolated qualification configuration")
  return { origin, key: `${options.channel}:${options.threadTS}`, selection: parseWorkspaceRepositorySelection({ repository: options.repository, baseBranch: options.baseBranch, workingBranch: options.workingBranch }), argv: parseWorkspaceCheckArgv(options.argv) }
}
async function signature(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return "v0=" + [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`)))].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

/** Entire transport/body bounded per call; never prints a remote body or credential. */
async function request(fetcher: Fetcher, url: URL, init: RequestInit, limit = 4 * 1024 * 1024) {
  let stopped = false
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, reader: { cancel(reason?: unknown): Promise<void> } | undefined
  const operation = (async () => {
    const response = await fetcher(new Request(url.toString(), { ...init, signal: controller.signal, redirect: "error" }))
    if (stopped) { void response.body?.cancel().catch(() => {}); throw new Error("Late qualification response") }
    const bodyReader = response.body?.getReader()
    reader = bodyReader
    const decoder = new TextDecoder("utf-8", { fatal: true }), chunks: string[] = []; let size = 0
    if (bodyReader) for (;;) {
      const next = await bodyReader.read(); if (next.done) break
      size += next.value.byteLength; if (size > limit) throw new Error("Qualification body limit")
      chunks.push(decoder.decode(next.value, { stream: true }))
    }
    chunks.push(decoder.decode()); const text = chunks.join("")
    let value: unknown = null; try { value = JSON.parse(text) } catch {}
    return { status: response.status, value }
  })()
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Qualification transport deadline")), 30_000) })]) }
  finally { stopped = true; if (timer) clearTimeout(timer); controller.abort(); try { void reader?.cancel().catch(() => {}) } catch {} }
}

export async function qualifySlackWorkspaceCanary(options: QualificationOptions): Promise<Record<string, unknown>> {
  const { origin, key, selection, argv } = validate(options), fetcher = options.fetcher ?? fetch
  const evidence = options.evidence ?? (async () => {}), sleep = options.sleep ?? (ms => Bun.sleep(ms))
  const base = `/api/conversations/${encodeURIComponent(key)}`
  const api = (suffix: string, method = "GET", body?: unknown) => request(fetcher, new URL(base + suffix, origin), {
    method, headers: { authorization: "Bearer " + options.apiToken, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  async function passiveState() {
    const result = await api(""); if (result.status !== 200) throw new Error("Qualification state unavailable")
    const state = object(result.value)
    if (state.sessionID || state.budgetReservation || state.usageExecution || (Array.isArray(state.queue) && state.queue.length) ||
      (state.phase !== undefined && state.phase !== "idle")) throw new Error("Unexpected session/provider/admission work; stop qualification")
    return state
  }
  async function poll<T>(operation: () => Promise<T | undefined>): Promise<T> {
    const until = Date.now() + Math.min(300_000, Math.max(1000, options.timeoutMs ?? 180_000))
    for (;;) { const value = await operation(); if (value !== undefined) return value; if (Date.now() >= until) throw new Error("Qualification observation deadline; retain evidence, never repeat execution automatically"); await sleep(500) }
  }
  let sequence = 0
  async function control(text: string, root = false) {
    // Fixed synthetic operator actor, never a real user's identity. No arbitrary prompt path.
    if (!/^!model(?: [A-Za-z0-9./:_#-]+)?$/.test(text) && !text.startsWith("!check ")) throw new Error("Qualification control refused")
    const value = micro(options.threadTS) + BigInt(sequence++)
    const ts = `${value / 1_000_000n}.${String(value % 1_000_000n).padStart(6, "0")}`
    const eventID = "qualification_" + crypto.randomUUID()
    const body = JSON.stringify({ type: "event_callback", event_id: eventID, event: {
      type: "app_mention", channel: options.channel, channel_type: "channel", user: "UQUALIFICATION", ts,
      ...(root ? {} : { thread_ts: options.threadTS }), text,
    } })
    const timestamp = String(Math.floor(Date.now() / 1000)), headers = { "content-type": "application/json", "x-slack-request-timestamp": timestamp, "x-slack-signature": await signature(options.signingSecret, timestamp, body) }
    // Commit the event identity before a possibly lost dispatch acknowledgement.
    await evidence("control-" + sequence, { eventID, text, syntheticActor: "UQUALIFICATION" })
    const proof = await request(fetcher, new URL("/slack/canary-route?kind=events", origin), { method: "POST", headers, body }, 4096)
    const decision = object(proof.value)
    if (proof.status !== 200 || decision.route !== "canary" || decision.channel !== options.channel || decision.threadTs !== options.threadTS) throw new Error("Canary ownership not acknowledged; no control dispatched")
    const result = await request(fetcher, new URL("/slack/events", origin), { method: "POST", headers, body }, 4096)
    if (result.status !== 200) throw new Error("Control dispatch acknowledgement unknown; do not resend automatically")
    return eventID
  }
  const before = await api("/workspace/repository")
  if (before.status !== 200 || object(before.value).workspaceRepository !== null) throw new Error("Qualification requires a fresh, unbound canary thread")
  const cold = await api("/workspace/preflight")
  if (![409, 503].includes(cold.status) || object(cold.value).code !== "WORKSPACE_NOT_RUNNING") throw new Error("Cold passive preflight did not refuse")
  await evidence("scope", { schemaVersion: 1, origin: origin.origin, conversationKey: key, channel: options.channel, threadTS: options.threadTS, selection, mode: "committed_only", syntheticActor: "UQUALIFICATION", inferenceRequested: false })
  const selected = await api("/workspace/repository", "PUT", selection)
  if (selected.status !== 201) throw new Error("Fresh binding was not durably created; retain scope and do not adopt an existing task")
  await evidence("selection", selected.value)
  await control(options.modelRef ? `!model ${options.modelRef}` : "!model", true)
  const binding = await poll(async () => {
    const state = await passiveState(), result = await api("/workspace/repository")
    if (result.status !== 200) throw new Error("Binding observation failed")
    const raw = object(result.value).workspaceRepository
    if (object(raw).status !== "bound" || (options.modelRef && state.modelOverride !== options.modelRef)) return undefined
    return parseWorkspaceRepositoryReceipt(raw)
  })
  await evidence("warm-binding", binding)
  const preflight = await api("/workspace/preflight")
  if (preflight.status !== 200) throw new Error("Warm passive preflight unavailable")
  await evidence("preflight", parseWorkspacePreflight(preflight.value))
  const eventID = await control("!check " + JSON.stringify(argv))
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${key}\0${eventID}`)))].map(byte => byte.toString(16).padStart(2, "0")).join("")
  const requestID = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
  const intent = await poll(async () => {
    await passiveState()
    const result = await api(`/workspace/checks/${requestID}`)
    if (result.status === 404) return undefined
    if (result.status !== 200) throw new Error("Queued intent unavailable")
    const selected = parseWorkspaceCheckIntent(object(result.value).workspaceCheck)
    if (selected.status !== "exported") return undefined
    if (JSON.stringify(selected.binding) !== JSON.stringify(binding) || JSON.stringify(selected.argv) !== JSON.stringify(argv) || selected.imageID !== options.imageID) throw new Error("Queued authorization differs from qualification scope")
    return selected
  })
  const source = await api(`/workspace/checks/${requestID}/source`)
  if (source.status !== 200) throw new Error("Frozen source unavailable")
  const graph = await verifyWorkspaceCheckSnapshot(source.value)
  if (graph.commit !== intent.commitOID || graph.tree !== intent.source!.treeOID || graph.snapshotSHA256 !== intent.source!.sourceSHA256 || JSON.stringify(graph.workspaceRepository) !== JSON.stringify(binding)) throw new Error("Frozen source identity mismatch")
  await evidence("queued", { conversationKey: key, requestID, workspaceCheck: intent, sourceSHA256: graph.snapshotSHA256,
    next: "Run the separately configured trusted workspace-check-runner --once. This helper never uploads a completion." })
  const refused = await request(fetcher, new URL("/api/check-collector/pending", origin), { headers: { authorization: "Bearer " + options.apiToken } }, 4096)
  if (refused.status !== 401) throw new Error("Ordinary API capability unexpectedly reaches collector authority")
  const execution = await poll(async () => {
    await passiveState()
    const result = await api(`/workspace/checks/${requestID}`)
    if (result.status !== 200) throw new Error("Trusted result unavailable")
    const raw = object(result.value).execution
    if (raw === null || raw === undefined) return undefined
    const record = parseWorkspaceCheckExecution(raw)
    if (record.status !== "completed") return undefined
    return record
  })
  await evidence("execution", execution)
  const receipt = execution.receipt!
  if (receipt.outcome !== "passed" || !receipt.cleanupConfirmed || receipt.freshness.before !== "matched" || receipt.freshness.after !== "matched" ||
    receipt.sourceSHA256 !== graph.snapshotSHA256 || JSON.stringify(receipt.binding) !== JSON.stringify(binding)) throw new Error("Trusted collector did not establish a current passing committed-tree result")
  let coldRestore = "not_requested"
  if (options.recycle) {
    // Existing lifecycle capture uses legacy Git fingerprinting. Only opt in for
    // the reviewed, credential-free fixture; this is not the no-script export path.
    await poll(async () => {
      const result = await api(`/workspace/checks/${requestID}`)
      if (result.status !== 200) throw new Error("Notification acknowledgement unavailable")
      const current = parseWorkspaceCheckExecution(object(result.value).execution)
      return current.notification.status !== "pending" ? true : undefined
    })
    const stopped = await api("/recycle", "POST")
    if (stopped.status !== 200 || object(stopped.value).ok !== true) throw new Error("Checkpoint/stop was not confirmed; do not automatically retry")
    await evidence("recycle", stopped.value)
    const coldAgain = await api("/workspace/preflight")
    if (![409, 503].includes(coldAgain.status) || object(coldAgain.value).code !== "WORKSPACE_NOT_RUNNING") throw new Error("Cold post-checkpoint runtime was not observed")
    const retained = await api("/workspace/repository")
    if (retained.status !== 200 || JSON.stringify(parseWorkspaceRepositoryReceipt(object(retained.value).workspaceRepository)) !== JSON.stringify(binding)) throw new Error("Durable binding changed while cold")
    await control(options.modelRef ? `!model ${options.modelRef}` : "!model")
    await poll(async () => { const result = await api("/workspace/preflight"); if (result.status !== 200) return undefined; parseWorkspacePreflight(result.value); return true })
    await passiveState()
    const restored = await api("/workspace/repository")
    if (restored.status !== 200 || JSON.stringify(parseWorkspaceRepositoryReceipt(object(restored.value).workspaceRepository)) !== JSON.stringify(binding)) throw new Error("Restored workspace binding/base identity changed")
    const freshness = await api(`/workspace/checks/${requestID}/freshness`)
    if (freshness.status !== 200 || object(freshness.value).status !== "current" || object(freshness.value).observedCommitOID !== intent.commitOID || object(freshness.value).observedTreeOID !== graph.tree) throw new Error("Restored checkout HEAD/tree differs from frozen source")
    const retainedSource = await api(`/workspace/checks/${requestID}/source`)
    if (retainedSource.status !== 200 || (await verifyWorkspaceCheckSnapshot(retainedSource.value)).snapshotSHA256 !== graph.snapshotSHA256) throw new Error("Historical frozen source changed after restore")
    coldRestore = "binding_head_tree_and_historical_source_preserved"
    await evidence("cold-restore", { binding, commitOID: intent.commitOID, treeOID: graph.tree, sourceSHA256: graph.snapshotSHA256, legacyFingerprintScope: true })
  }
  const summary = { schemaVersion: 1, conversationKey: key, requestID, collectorID: execution.attempt!.collectorID, attemptID: execution.attempt!.attemptID,
    outcome: receipt.outcome, cleanupConfirmed: receipt.cleanupConfirmed, sourceSHA256: graph.snapshotSHA256, inferenceRequested: false,
    worktreeChanges: "unverified", baselineChecks: "not_run", testOrConfigChanges: "not_evaluated", catalogueSelectionVerified: Boolean(options.modelRef), coldRestore }
  await evidence("summary", summary)
  return summary
}

if (import.meta.main) {
  try {
    const flags = new Map<string, string>(); let execute = false
    for (let i = 2; i < process.argv.length; i++) {
      const flag = process.argv[i]!
      if (flag === "--execute") { execute = true; continue }
      if (!["--config", "--secrets", "--out"].includes(flag) || flags.has(flag) || !process.argv[i + 1]) throw new Error("Invalid qualification arguments")
      flags.set(flag, process.argv[++i]!)
    }
    if (!execute) { console.log("Prepared only. Explicit --execute is required for delegated canary controls; no requests were sent."); process.exit(0) }
    const path = resolve(flags.get("--secrets") ?? ""), stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error("Private operator secrets file required")
    const secret = object(JSON.parse(await readFile(path, "utf8"))), spec = object(JSON.parse(await readFile(resolve(flags.get("--config") ?? ""), "utf8")))
    const out = resolve(flags.get("--out") ?? ""); await mkdir(out, { mode: 0o700 })
    const result = await qualifySlackWorkspaceCanary({ ...spec, apiToken: secret.API_TOKEN, signingSecret: secret.SLACK_SIGNING_SECRET,
      evidence: async (name, value) => writeFile(resolve(out, name + ".json"), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }),
    } as QualificationOptions)
    console.log(JSON.stringify(result))
  } catch { console.error("Qualification incomplete. Retain private evidence; no prompt or automatic execution retry was requested."); process.exitCode = 1 }
}
