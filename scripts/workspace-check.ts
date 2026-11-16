#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { parseWorkspaceRepositoryReceipt } from "../src/workspace-repository"
import { parseWorkspaceCheckIntent, parseWorkspaceCheckRequest, sameWorkspaceCheckRequest, type WorkspaceCheckLocalReceipt } from "../src/workspace-check"
import { verifyWorkspaceCheckSnapshot, WORKSPACE_CHECK_SNAPSHOT_LIMITS } from "../src/workspace-check-snapshot"
import { workspaceAPITarget, workspaceAPIRequest, type WorkspaceFetcher } from "./lib/workspace-api"
import { collectWorkspaceCheck, observeWorkspaceCheck, readLocalCheck, type DockerRunner, type Freshness } from "./workspace-check-docker"

const USAGE = `Usage:
  bun scripts/workspace-check.ts run --url <origin> --conversation <key> \\
    --commit <full SHA> --image sha256:<local image ID> --timeout-ms <1..120000> \\
    --out <new private directory> [--binding-id <expected UUID>] [--json] -- <command> [args...]
  bun scripts/workspace-check.ts observe --out <evidence directory> [--json]

Authentication: ABOITEAU_API_TOKEN environment variable, never passed to Linux.
Only committed files are tested. No setup, dependency installation, network or result upload.
Existing evidence is observed; commands are never automatically repeated.
Exit: 0 local pass or successful historical observation, 2 failed/stale/not-run,
3 unknown/unsettled/existing run directory, 1 request/error.`

interface CLIResult { exitCode: number; stdout: string; stderr: string }
interface CLIOptions { token?: string; fetcher?: WorkspaceFetcher; docker?: DockerRunner; timeoutMs?: number }
const failure = (message: string): CLIResult => ({ exitCode: 1, stdout: "", stderr: message })
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid API metadata")
  return value as Record<string, unknown>
}
function receiptExit(receipt: WorkspaceCheckLocalReceipt): number {
  if (!receipt.cleanupConfirmed || receipt.outcome === "collector_error") return 3
  return receipt.outcome === "passed" && receipt.freshness.before === "matched" && receipt.freshness.after === "matched" ? 0 : 2
}
function renderReceipt(receipt: WorkspaceCheckLocalReceipt, existing: boolean, json: boolean): CLIResult {
  return { exitCode: receiptExit(receipt), stderr: "", stdout: json ? JSON.stringify({ existing, receipt }, null, 2) : [
    existing ? "Historical local evidence; no command was repeated or current freshness checked." : "Local operator evidence; no execution result was uploaded.",
    `Command on committed snapshot: ${receipt.outcome}; cleanup confirmed: ${receipt.cleanupConfirmed}.`,
    `Recorded point-in-time HEAD freshness before/after: ${receipt.freshness.before}/${receipt.freshness.after}.`,
    "Working-tree changes unverified; baseline checks not run; test/config changes not evaluated.",
  ].join("\n") }
}

export async function runWorkspaceCheck(args: string[], options: CLIOptions = {}): Promise<CLIResult> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { exitCode: 0, stdout: USAGE, stderr: "" }
  const action = args[0]
  if (action !== "run" && action !== "observe") return failure(USAGE)
  const values = new Map<string, string>()
  let json = false, argv: string[] = []
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]
    if (flag === "--" && action === "run") { argv = args.slice(index + 1); break }
    if (flag === "--json" && !json) { json = true; continue }
    const allowed = action === "observe" ? ["--out"] : ["--url", "--conversation", "--commit", "--image", "--timeout-ms", "--out", "--binding-id"]
    if (!allowed.includes(flag) || values.has(flag) || !args[index + 1] || args[index + 1].startsWith("--")) return failure(USAGE)
    values.set(flag, args[++index])
  }
  if (!values.get("--out")) return failure(USAGE)
  const directory = resolve(values.get("--out")!)
  if (action === "observe") {
    try {
      const value = await observeWorkspaceCheck(directory, options.docker)
      const result = record(value)
      if (result.receipt) return renderReceipt(result.receipt as WorkspaceCheckLocalReceipt, true, json)
      return { exitCode: 3, stdout: JSON.stringify(value, null, 2), stderr: "" }
    } catch { return failure("Local evidence is missing, unsafe or invalid. No command was repeated.") }
  }
  // Validate all caller data before creating files, authenticating or using Docker.
  let target: ReturnType<typeof workspaceAPITarget>
  let initial: ReturnType<typeof parseWorkspaceCheckRequest>
  try {
    target = workspaceAPITarget(values.get("--url"), values.get("--conversation"), options.token ?? process.env.ABOITEAU_API_TOKEN)
    if (!/^[1-9][0-9]{0,5}$/.test(values.get("--timeout-ms") ?? "")) throw new Error()
    initial = parseWorkspaceCheckRequest({ requestID: crypto.randomUUID(), expectedBindingID: values.get("--binding-id") ?? "11111111-1111-4111-8111-111111111111", commitOID: values.get("--commit"), imageID: values.get("--image"), timeoutMs: Number(values.get("--timeout-ms")), argv })
  } catch { return failure("Use an authenticated HTTPS origin (or HTTP loopback), a valid conversation, full commit, pinned image ID, bounded timeout and explicit argv.") }
  try {
    try { await mkdir(directory, { mode: 0o700 }) }
    catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error
      const previous = await readLocalCheck(directory)
      if (previous.receipt) return { ...renderReceipt(previous.receipt, true, json), exitCode: 3 }
      return { exitCode: 3, stdout: json ? JSON.stringify({ status: "unknown", executionRetried: false }) : "Existing evidence is unresolved. Use observe; no command was repeated.", stderr: "" }
    }
    const api = (path: string, extra: Parameters<typeof workspaceAPIRequest>[2] = {}) => workspaceAPIRequest(target, path, { fetcher: options.fetcher, timeoutMs: options.timeoutMs, ...extra })
    const bindingResponse = await api("repository")
    if (bindingResponse.status !== 200) throw new Error("Binding unavailable")
    const binding = parseWorkspaceRepositoryReceipt(record(bindingResponse.value).workspaceRepository)
    if (values.has("--binding-id") && binding.bindingID !== initial.expectedBindingID) throw new Error("Binding mismatch")
    const request = parseWorkspaceCheckRequest({ ...initial, expectedBindingID: binding.bindingID })
    // Retain request identity before the first possibly lost server acknowledgement.
    await writeFile(join(directory, "request.json"), JSON.stringify({ request, binding }, null, 2) + "\n", { flag: "wx", mode: 0o600 })
    const intentResponse = await api("checks", { method: "POST", body: request, timeoutMs: 30000 })
    if (intentResponse.status !== 200 && intentResponse.status !== 201) throw new Error("Intent unavailable")
    const intent = parseWorkspaceCheckIntent(record(intentResponse.value).workspaceCheck)
    if (!sameWorkspaceCheckRequest(request, intent) || intent.status !== "exported" || !intent.source || JSON.stringify(intent.binding) !== JSON.stringify(binding)) throw new Error("Intent identity mismatch")
    const prefix = "checks/" + request.requestID
    const source = await api(prefix + "/source", { maxBytes: WORKSPACE_CHECK_SNAPSHOT_LIMITS.wireBytes, timeoutMs: 30000 })
    if (source.status !== 200) throw new Error("Source unavailable")
    const snapshot = await verifyWorkspaceCheckSnapshot(source.value)
    if (snapshot.commit !== request.commitOID || snapshot.tree !== intent.source.treeOID || snapshot.snapshotSHA256 !== intent.source.sourceSHA256 || JSON.stringify(snapshot.workspaceRepository) !== JSON.stringify(binding)) throw new Error("Source identity mismatch")
    const freshness = async (): Promise<Freshness> => {
      try {
        const response = await api(prefix + "/freshness")
        if (response.status !== 200) return "unknown"
        const value = record(response.value)
        if (value.requestID !== request.requestID || value.expectedBindingID !== request.expectedBindingID || value.commitOID !== request.commitOID || value.mode !== "committed_only" || value.worktreeChanges !== "unverified" || value.checksNotRun !== true) return "unknown"
        if (value.status === "stale") return "stale"
        return value.status === "current" && value.observedCommitOID === request.commitOID && value.observedTreeOID === snapshot.tree ? "matched" : "unknown"
      } catch { return "unknown" }
    }
    const receipt = await collectWorkspaceCheck({ directory, request, snapshot, before: await freshness(), after: freshness, docker: options.docker })
    return renderReceipt(receipt, false, json)
  } catch { return failure("Workspace check preparation or collection failed. Retain the evidence directory; execution is not automatically retried. No result was uploaded.") }
}

if (import.meta.main) {
  const result = await runWorkspaceCheck(process.argv.slice(2))
  if (result.stdout) console.log(result.stdout)
  if (result.stderr) console.error(result.stderr)
  process.exitCode = result.exitCode
}
