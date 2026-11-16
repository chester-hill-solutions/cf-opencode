#!/usr/bin/env bun
import { constants } from "node:fs"
import { createHash } from "node:crypto"
import { lstat, mkdir, open, realpath, rename, rm, unlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parseWorkspaceCheckRequest, parseWorkspaceCheckLocalReceipt, sameWorkspaceCheckRequest, type WorkspaceCheckLocalReceipt } from "../src/workspace-check"
import { verifyWorkspaceCheckSnapshot, WORKSPACE_CHECK_SNAPSHOT_LIMITS } from "../src/workspace-check-snapshot"
import { parseWorkspaceCheckCollectorClaim, parseWorkspaceCheckCollectorCompletion, parseWorkspaceCheckExecution, type WorkspaceCheckCollectorClaim } from "../src/workspace-check-dispatch"
import { workspaceAPITarget, workspaceAPIRequest, type WorkspaceFetcher } from "./lib/workspace-api"
import { collectWorkspaceCheck, observeWorkspaceCheck, readLocalCheck, runDocker, type DockerRunner, type Freshness } from "./workspace-check-docker"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const KEY = /^[A-Za-z0-9:._-]{1,256}$/
const IMAGE = /^sha256:[0-9a-f]{64}$/
type Claim = WorkspaceCheckCollectorClaim
type Journal = { schemaVersion: 1; origin: string; collectorID: string; claimRequestID: string; conversationKey: string; imageID: string; phase: "claim_requested" | "claimed" | "collecting" | "receipt_ready" | "completed"; claim: Claim | null }
export interface RunnerOptions { url: string; directory: string; collectorID: string; imageID: string; token: string; reconcile?: boolean; fetcher?: WorkspaceFetcher; docker?: DockerRunner }
export interface RunnerResult { status: "idle" | "completed" | "reconciled" | "blocked" | "busy" | "error"; attemptID?: string; executionRetried: false; outcome?: WorkspaceCheckLocalReceipt["outcome"] }
const obj = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid metadata"); return value as Record<string, unknown> }
function parseJournal(value: unknown): Journal {
  const v = obj(value)
  if (Object.keys(v).sort().join(",") !== "claim,claimRequestID,collectorID,conversationKey,imageID,origin,phase,schemaVersion" || v.schemaVersion !== 1 || typeof v.origin !== "string" || typeof v.collectorID !== "string" || !UUID.test(v.collectorID) || typeof v.claimRequestID !== "string" || !UUID.test(v.claimRequestID) || typeof v.conversationKey !== "string" || !KEY.test(v.conversationKey) || [".", ".."].includes(v.conversationKey) || typeof v.imageID !== "string" || !IMAGE.test(v.imageID) || !["claim_requested", "claimed", "collecting", "receipt_ready", "completed"].includes(String(v.phase))) throw new Error("Invalid journal")
  const claim = v.claim === null ? null : parseWorkspaceCheckCollectorClaim(v.claim)
  if ((v.phase !== "claim_requested" && !claim) || (claim && (claim.collectorID !== v.collectorID || claim.claimRequestID !== v.claimRequestID || claim.conversationKey !== v.conversationKey || claim.workspaceCheck.imageID !== v.imageID))) throw new Error("Journal identity mismatch")
  return { schemaVersion: 1, origin: v.origin, collectorID: v.collectorID, claimRequestID: v.claimRequestID, conversationKey: v.conversationKey, imageID: v.imageID, phase: v.phase as Journal["phase"], claim }
}
async function syncDir(path: string) { const fd = await open(path, "r"); try { await fd.sync() } finally { await fd.close() } }
async function privateDirectory(path: string) {
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error("Private operator directory required")
}
async function readJSON(path: string, limit = 65536): Promise<unknown | undefined> {
  let fd
  try { fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined; throw error }
  try {
    const stat = await fd.stat()
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > limit) throw new Error("Unsafe journal")
    return JSON.parse(await fd.readFile("utf8")) as unknown
  } finally { await fd.close() }
}
async function save(directory: string, name: string, value: unknown) {
  const temp = join(directory, ".journal-" + crypto.randomUUID()), fd = await open(temp, "wx", 0o600)
  try { await fd.writeFile(JSON.stringify(value) + "\n"); await fd.sync() } finally { await fd.close() }
  await rename(temp, join(directory, name)); await syncDir(directory)
}
function matches(receipt: WorkspaceCheckLocalReceipt, claim: Claim) {
  const intent = claim.workspaceCheck
  return sameWorkspaceCheckRequest(receipt.request, intent) && JSON.stringify(receipt.binding) === JSON.stringify(intent.binding) && receipt.sourceSHA256 === intent.source?.sourceSHA256 && receipt.treeOID === intent.source?.treeOID
}

async function capturedLog(directory: string, stream: "stdout" | "stderr", receipt: WorkspaceCheckLocalReceipt): Promise<string> {
  const fd = await open(join(directory, stream + ".log"), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await fd.stat()
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 65536) throw new Error("Unsafe captured log")
    const buffer = Buffer.alloc(65537), { bytesRead } = await fd.read(buffer, 0, buffer.length, 0), bytes = buffer.subarray(0, bytesRead)
    if (bytesRead !== receipt.logs[stream].capturedBytes || createHash("sha256").update(bytes).digest("hex") !== receipt.logs[stream].sha256) throw new Error("Captured log changed")
    return bytes.toString("base64")
  } finally { await fd.close() }
}

/** One private host lock, one durable claim, one collector execution. Restart only observes/reconciles. */
export async function runWorkspaceCheckRunner(options: RunnerOptions): Promise<RunnerResult> {
  // Validate credentials/origin and fixed operator image before any disk or network effects.
  const target = workspaceAPITarget(options.url, "collector", options.token)
  if (!UUID.test(options.collectorID) || !IMAGE.test(options.imageID)) throw new Error("Invalid collector configuration")
  target.url.pathname = "/api/check-collector/"
  const api = (path: string, extra: Parameters<typeof workspaceAPIRequest>[2] = {}, cursor?: string) => {
    const pageTarget = { ...target, url: new URL(target.url) }; if (cursor) pageTarget.url.searchParams.set("cursor", cursor)
    return workspaceAPIRequest(pageTarget, path, { fetcher: options.fetcher, ...extra })
  }
  await mkdir(resolve(options.directory), { recursive: true, mode: 0o700 })
  const root = await realpath(resolve(options.directory)); await privateDirectory(root)
  const lock = join(root, "runner.lock")
  try { await mkdir(lock, { mode: 0o700 }) }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") return { status: "busy", executionRetried: false }; throw error }
  try {
    await save(lock, "owner.json", { pid: process.pid, collectorID: options.collectorID, createdAt: Date.now() })
    const raw = await readJSON(join(root, "active.json")), recovering = raw !== undefined
    let journal: Journal
    if (recovering) {
      journal = parseJournal(raw)
      if (journal.origin !== target.url.origin || journal.collectorID !== options.collectorID || journal.imageID !== options.imageID) throw new Error("Runner configuration changed with unresolved evidence")
    } else {
      let candidate: Record<string, unknown> | undefined, cursor: string | undefined
      const seen = new Set<string>()
      for (let page = 0; page < 50; page++) {
        const response = await api("pending", {}, cursor)
        if (response.status !== 200) throw new Error("Queue unavailable")
        const envelope = obj(response.value), pending = envelope.pending
        if (envelope.owner !== undefined && envelope.owner !== null) {
          const owner = obj(envelope.owner)
          if (owner.collectorID === options.collectorID) {
            if (!options.reconcile) return { status: "blocked", executionRetried: false }
            if (owner.imageID !== options.imageID || typeof owner.claimRequestID !== "string" || !UUID.test(owner.claimRequestID)) throw new Error("Unresolved owner identity")
            candidate = owner
          } else return { status: "busy", executionRetried: false }
        }
        if (!Array.isArray(pending) || pending.length > 100) throw new Error("Invalid queue")
        for (const rawEntry of pending) {
          const entry = obj(rawEntry)
          if (entry.status !== "queued" && entry.status !== "claimed") throw new Error("Invalid queue status")
          if (entry.status === "claimed" && entry.collectorID === options.collectorID) {
            if (!options.reconcile) return { status: "blocked", executionRetried: false }
            candidate = entry
          }
          if (!options.reconcile && !candidate && entry.status === "queued" && entry.imageID === options.imageID) candidate = entry
        }
        if (envelope.nextCursor === null) break
        if (typeof envelope.nextCursor !== "string" || !envelope.nextCursor || envelope.nextCursor.length > 512 || seen.has(envelope.nextCursor) || page === 49) throw new Error("Queue pagination unresolved")
        cursor = envelope.nextCursor; seen.add(cursor)
      }
      if (!candidate) return { status: "idle", executionRetried: false }
      const key = candidate.conversationKey
      if (typeof key !== "string" || !KEY.test(key) || [".", ".."].includes(key)) throw new Error("Invalid queue key")
      journal = { schemaVersion: 1, origin: target.url.origin, collectorID: options.collectorID, claimRequestID: options.reconcile ? String(candidate.claimRequestID) : crypto.randomUUID(), conversationKey: key, imageID: options.imageID, phase: "claim_requested", claim: null }
      journal = parseJournal(journal)
      await save(root, "active.json", journal)
    }
    const prefix = "conversations/" + encodeURIComponent(journal.conversationKey)
    if (!journal.claim) {
      const body = { collectorID: journal.collectorID, claimRequestID: journal.claimRequestID, imageID: journal.imageID }
      // Lost acknowledgements use the exact same durable identity, never a new claim.
      let response: Awaited<ReturnType<typeof api>> | undefined
      for (let retry = 0; retry < 2; retry++) { try { response = await api(prefix + "/claim", { method: "POST", body }); break } catch { if (retry) throw new Error("Claim acknowledgement unavailable") } }
      if (response?.status !== 200 && response?.status !== 201) throw new Error("Claim unavailable")
      if (options.reconcile && obj(response.value).claim === null) {
        // The server released a fenced owner for which no actor attempt ever existed.
        await save(root, "reconciled-no-attempt.json", journal)
        await unlink(join(root, "active.json")); await syncDir(root)
        return { status: "reconciled", executionRetried: false }
      }
      const claim = parseWorkspaceCheckCollectorClaim(obj(response.value).claim)
      if (claim.collectorID !== journal.collectorID || claim.claimRequestID !== journal.claimRequestID || claim.conversationKey !== journal.conversationKey || claim.workspaceCheck.imageID !== options.imageID) throw new Error("Claim identity mismatch")
      journal = { ...journal, claim, phase: "claimed" }; await save(root, "active.json", journal)
    }
    const claim = journal.claim!
    const attemptRoot = join(root, journal.claimRequestID)
    await mkdir(attemptRoot, { mode: 0o700, recursive: true }); await privateDirectory(attemptRoot)
    const evidence = join(attemptRoot, "evidence"), route = prefix + "/attempts/" + claim.attemptID
    if (options.reconcile) {
      // An explicit operator observation can release ownership, never change the result or run code.
      const result = await (options.docker ?? runDocker)(["container", "ls", "--all", "--filter", "label=org.aboiteau.check.request=" + claim.workspaceCheck.requestID, "--format", "{{.ID}}"], { timeoutMs: 10000 })
      if (result.exitCode !== 0 || result.timedOut || result.outputExceeded || result.stdoutBytes !== 0 || result.stdout.byteLength !== 0) return { status: "blocked", attemptID: claim.attemptID, executionRetried: false }
      const body = { collectorID: journal.collectorID, claimRequestID: journal.claimRequestID, attemptID: claim.attemptID, cleanupConfirmed: true }
      await save(attemptRoot, "reconcile-request.json", body)
      const response = await api(route + "/reconcile", { method: "POST", body, maxBytes: 32768 })
      const ack = parseWorkspaceCheckExecution(obj(response.value).execution)
      if (response.status !== 200 || ack.requestID !== claim.workspaceCheck.requestID || ack.attempt?.attemptID !== claim.attemptID || ack.attempt.collectorID !== journal.collectorID || ack.attempt.claimRequestID !== journal.claimRequestID || ack.cleanupReconciledAt === null) throw new Error("Reconciliation acknowledgement unavailable")
      await save(attemptRoot, "reconciled.json", ack)
      await unlink(join(root, "active.json")); await syncDir(root)
      return { status: "reconciled", attemptID: claim.attemptID, executionRetried: false }
    }
    let receipt: WorkspaceCheckLocalReceipt | undefined
    try { receipt = (await readLocalCheck(evidence)).receipt }
    catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error }
    if (recovering && !receipt) {
      try { await observeWorkspaceCheck(evidence, options.docker) } catch {}
      return { status: "blocked", attemptID: claim.attemptID, executionRetried: false }
    }
    if (journal.phase === "completed" && receipt && !receipt.cleanupConfirmed) return { status: "blocked", attemptID: claim.attemptID, executionRetried: false }
    if (!receipt) {
      const source = await api(route + "/source", { maxBytes: WORKSPACE_CHECK_SNAPSHOT_LIMITS.wireBytes, timeoutMs: 30000 })
      if (source.status !== 200) throw new Error("Source unavailable")
      const snapshot = await verifyWorkspaceCheckSnapshot(source.value), intent = claim.workspaceCheck
      if (snapshot.commit !== intent.commitOID || snapshot.tree !== intent.source!.treeOID || snapshot.snapshotSHA256 !== intent.source!.sourceSHA256 || JSON.stringify(snapshot.workspaceRepository) !== JSON.stringify(intent.binding)) throw new Error("Source identity mismatch")
      const freshness = async (): Promise<Freshness> => {
        try {
          const r = await api(route + "/freshness"), v = obj(r.value)
          if (r.status !== 200 || v.requestID !== intent.requestID || v.expectedBindingID !== intent.expectedBindingID || v.commitOID !== intent.commitOID || v.mode !== "committed_only" || v.worktreeChanges !== "unverified" || v.checksNotRun !== true) return "unknown"
          return v.status === "stale" ? "stale" : v.status === "current" && v.observedCommitOID === intent.commitOID && v.observedTreeOID === snapshot.tree ? "matched" : "unknown"
        } catch { return "unknown" }
      }
      journal.phase = "collecting"; await save(root, "active.json", journal)
      await mkdir(evidence, { mode: 0o700 })
      const request = parseWorkspaceCheckRequest({ requestID: intent.requestID, expectedBindingID: intent.expectedBindingID, commitOID: intent.commitOID, argv: intent.argv, imageID: intent.imageID, timeoutMs: intent.timeoutMs })
      receipt = await collectWorkspaceCheck({ directory: evidence, request, snapshot, before: await freshness(), after: freshness, docker: options.docker })
    }
    receipt = parseWorkspaceCheckLocalReceipt(receipt)
    if (!matches(receipt, claim)) throw new Error("Receipt identity mismatch")
    journal.phase = "receipt_ready"; await save(root, "active.json", journal)
    const logs = { stdoutBase64: await capturedLog(evidence, "stdout", receipt), stderrBase64: await capturedLog(evidence, "stderr", receipt) }
    const completion = parseWorkspaceCheckCollectorCompletion({ collectorID: journal.collectorID, claimRequestID: journal.claimRequestID, attemptID: claim.attemptID, receipt, logs })
    // Freeze the exact body before the first upload; retries never reinterpret test stdout.
    const savedCompletion = await readJSON(join(attemptRoot, "completion.json"), 200000)
    if (savedCompletion !== undefined && JSON.stringify(savedCompletion) !== JSON.stringify(completion)) throw new Error("Completion changed")
    if (savedCompletion === undefined) await save(attemptRoot, "completion.json", completion)
    const response = await api(route + "/complete", { method: "POST", body: completion, maxBytes: 32768 })
    const ack = parseWorkspaceCheckExecution(obj(response.value).execution)
    if (response.status !== 200 || ack.completionSHA256 !== createHash("sha256").update(JSON.stringify(completion)).digest("hex") || ack.status !== "completed" || ack.requestID !== claim.workspaceCheck.requestID || ack.attempt?.attemptID !== claim.attemptID || ack.attempt.collectorID !== journal.collectorID || ack.attempt.claimRequestID !== journal.claimRequestID || JSON.stringify(ack.receipt) !== JSON.stringify(receipt)) throw new Error("Completion acknowledgement unavailable")
    journal.phase = "completed"; await save(attemptRoot, "completed.json", journal)
    if (!receipt.cleanupConfirmed) { await save(root, "active.json", journal); return { status: "blocked", attemptID: claim.attemptID, outcome: receipt.outcome, executionRetried: false } }
    await unlink(join(root, "active.json")); await syncDir(root)
    return { status: "completed", attemptID: claim.attemptID, outcome: receipt.outcome, executionRetried: false }
  } catch { return { status: "error", executionRetried: false } }
  finally { await rm(lock, { recursive: true, force: true }); await syncDir(root) }
}

export async function runnerCLI(args: string[]): Promise<number> {
  const usage = "Usage: bun scripts/workspace-check-runner.ts [--once | --reconcile] --url <HTTPS origin> --state <private persistent directory> --collector-id <UUID> --image sha256:<local ID>\nAuthentication: CHECK_COLLECTOR_TOKEN environment only. Default polls serially every 5 seconds; unresolved journals stop polling. Existing executions are observed, never repeated. A crash-left runner.lock requires operator reconciliation before removal."
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) { console.log(usage); return 0 }
  const flags = new Map<string, string>(); let once = false, reconcile = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--reconcile" && !reconcile && !once) { reconcile = true; once = true; continue }
    if (args[i] === "--once" && !once) { once = true; continue }
    if (!["--url", "--state", "--collector-id", "--image"].includes(args[i]) || flags.has(args[i]) || !args[i + 1] || args[i + 1].startsWith("--")) { console.error(usage); return 1 }
    flags.set(args[i], args[++i])
  }
  if (flags.size !== 4) { console.error(usage); return 1 }
  let stopping = false
  const stop = () => { stopping = true }
  process.on("SIGINT", stop); process.on("SIGTERM", stop)
  try {
    for (;;) {
      if (stopping) return 0
      const result = await runWorkspaceCheckRunner({ url: flags.get("--url")!, directory: flags.get("--state")!, collectorID: flags.get("--collector-id")!, imageID: flags.get("--image")!, token: process.env.CHECK_COLLECTOR_TOKEN ?? "", reconcile })
      console.log(JSON.stringify(result))
      if (result.status === "error" || result.status === "blocked" || result.status === "busy") return 3
      if (once || stopping) return 0
      await new Promise(resolve => setTimeout(resolve, 5000))
    }
  } catch { console.error("Invalid runner configuration or unsafe local state. No automatic recovery execution."); return 1 }
  finally { process.off("SIGINT", stop); process.off("SIGTERM", stop) }
}
if (import.meta.main) process.exitCode = await runnerCLI(process.argv.slice(2))
