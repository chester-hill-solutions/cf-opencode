#!/usr/bin/env bun
import {
  parseWorkspaceRepositoryBinding,
  parseWorkspaceRepositorySelection,
  sameWorkspaceRepositorySelection,
  type WorkspaceRepositoryBinding,
  type WorkspaceRepositorySelection,
} from "../src/workspace-repository"

import { workspaceAPITarget, workspaceAPIRequest, type WorkspaceAPITarget } from "./lib/workspace-api"

const USAGE = `Usage:
  bun scripts/workspace-repository.ts get --url <origin> --conversation <key> [--json]
  bun scripts/workspace-repository.ts select --url <origin> --conversation <key> \\
    --repository https://github.com/owner/repo --base-branch main --working-branch aboiteau/task-123 [--json]

Authentication: ABOITEAU_API_TOKEN environment variable; no token argument.
Selection saves intent only. It does not start a runtime or call a provider.
Exit codes: 0 successful API operation, 2 binding conflict, 1 request/error.`

interface CliResult { exitCode: number; stdout: string; stderr: string }
interface CliOptions {
  token?: string
  fetcher?: (request: Request) => Promise<Response>
  /** Tests may shorten the bounded request deadline. */
  timeoutMs?: number
}

function failure(message: string, exitCode = 1): CliResult {
  return { exitCode, stdout: "", stderr: message }
}

function render(binding: WorkspaceRepositoryBinding | null): string {
  if (!binding) return "Workspace repository: not selected. No runtime was started."
  return [
    `Workspace repository: ${binding.status}`,
    `Repository: ${binding.repository}`,
    `Base branch: ${binding.baseBranch}; original base commit: ${binding.baseCommit ?? "not resolved"}`,
    `Working branch: ${binding.workingBranch}`,
    binding.status === "pending"
      ? "Intent is saved. The first message will attempt checkout; no runtime or provider was started by this command."
      : "The server reports a materialized binding. This does not establish that setup or checks passed.",
  ].join("\n")
}

export async function runWorkspaceRepository(args: string[], options: CliOptions = {}): Promise<CliResult> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { exitCode: 0, stdout: USAGE, stderr: "" }
  const action = args[0]
  if (action !== "get" && action !== "select") return failure(USAGE)
  const values = new Map<string, string>()
  let json = false
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]
    if (flag === "--json" && !json) { json = true; continue }
    const allowed = action === "get" ? ["--url", "--conversation"] : ["--url", "--conversation", "--repository", "--base-branch", "--working-branch"]
    if (!allowed.includes(flag) || values.has(flag) || !args[index + 1] || args[index + 1].startsWith("--")) return failure(USAGE)
    values.set(flag, args[++index])
  }
  let target: WorkspaceAPITarget
  try { target = workspaceAPITarget(values.get("--url"), values.get("--conversation"), options.token ?? process.env.ABOITEAU_API_TOKEN) }
  catch { return failure("Use an HTTPS origin (or HTTP loopback), a valid conversation key and ABOITEAU_API_TOKEN, without URL credentials or extra paths.") }
  let selection: WorkspaceRepositorySelection | undefined
  if (action === "select") {
    try {
      selection = parseWorkspaceRepositorySelection({ repository: values.get("--repository"), baseBranch: values.get("--base-branch"), workingBranch: values.get("--working-branch") })
    } catch { return failure("Select requires a supported GitHub repository, base branch and distinct working branch.") }
  }
  try {
    const response = await workspaceAPIRequest(target, "repository", { method: action === "get" ? "GET" : "PUT", ...(selection ? { body: selection } : {}), fetcher: options.fetcher, timeoutMs: options.timeoutMs })
    if (response.status === 401 || response.status === 403) return failure("API authentication was refused. Check ABOITEAU_API_TOKEN and workspace access.")
    if (response.status === 409) return failure("Workspace binding conflicts with existing state or accepted work. Inspect the binding or use a new conversation.", 2)
    if (response.status !== 200 && !(action === "select" && response.status === 201)) return failure(`Workspace repository request failed (HTTP ${response.status}).`)
    const value = response.value
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "workspaceRepository")) throw new Error()
    const raw = (value as Record<string, unknown>).workspaceRepository
    const binding = raw === null ? null : parseWorkspaceRepositoryBinding(raw)
    if (selection && (!binding || !sameWorkspaceRepositorySelection(selection, binding))) throw new Error()
    const body = { workspaceRepository: binding }
    return { exitCode: 0, stdout: json ? JSON.stringify(body, null, 2) : render(binding), stderr: "" }
  } catch { return failure("Workspace repository request failed or returned invalid metadata. No setup, checks or provider execution were requested by this command.") }
}

if (import.meta.main) {
  const result = await runWorkspaceRepository(process.argv.slice(2))
  if (result.stdout) console.log(result.stdout)
  if (result.stderr) console.error(result.stderr)
  process.exitCode = result.exitCode
}
