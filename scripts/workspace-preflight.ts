#!/usr/bin/env bun
import { inspectWorkspace } from "../workspace-preflight"
import { parseWorkspacePreflight, type WorkspacePreflight } from "../src/workspace-preflight"

const USAGE = `Usage:
  bun scripts/workspace-preflight.ts --workspace <directory> [--json]
  bun scripts/workspace-preflight.ts --url <origin> --conversation <key> [--json]

Remote authentication: ABOITEAU_API_TOKEN environment variable.
Inspection never installs dependencies, runs checks, or starts a cold workspace.
Exit codes: 0 inspected (verification still required), 2 blocked, 1 request/error.`

interface CliResult { exitCode: number; stdout: string; stderr: string }
interface CliOptions {
  token?: string
  fetcher?: (request: Request) => Promise<Response>
}

function failure(message: string): CliResult {
  return { exitCode: 1, stdout: "", stderr: message }
}

function render(report: WorkspacePreflight): string {
  const repository = report.repository
  return [
    report.status === "blocked" ? "Workspace inspection: blocked" : "Workspace inspection: needs verification",
    `Repository: ${repository.kind}; branch: ${repository.branch ?? "unknown/detached"}; HEAD: ${repository.head ?? "unknown"}`,
    `Local changes: ${repository.dirty === null ? "unknown" : repository.dirty ? "yes" : "no"}`,
    `Tools: ${report.tools.map((tool) => `${tool.name}=${tool.available ? "available" : "missing"}`).join(", ") || "none detected"}`,
    `Manifests: ${report.project.manifests.join(", ") || "none detected"}`,
    `Package manager: ${report.project.packageManager ?? "unknown"}; dependencies: ${report.project.dependencies}`,
    `Project guidance: ${report.project.guidance.join(", ") || "none detected"}`,
    "Setup: not run. Checks: not run.",
    ...report.findings.map((finding) => `[${finding.severity}] ${finding.message}`),
    ...report.suggestions.map((suggestion) =>
      `Suggested ${suggestion.purpose} (requires approval; not run): ${JSON.stringify(suggestion.argv)}`),
  ].join("\n")
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("missing body")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 128 * 1024) throw new Error("response too large")
      chunks.push(chunk.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

function coldError(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  if ("code" in value && value.code === "WORKSPACE_NOT_RUNNING") return true
  return "error" in value && value.error !== null && typeof value.error === "object" &&
    "code" in value.error && value.error.code === "WORKSPACE_NOT_RUNNING"
}

export async function runWorkspacePreflight(args: string[], options: CliOptions = {}): Promise<CliResult> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    return { exitCode: 0, stdout: USAGE, stderr: "" }
  }
  const values = new Map<string, string>()
  let json = false
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === "--json" && !json) {
      json = true
      continue
    }
    if (!["--workspace", "--url", "--conversation"].includes(flag) || values.has(flag) ||
      !args[index + 1] || args[index + 1].startsWith("--")) return failure(USAGE)
    values.set(flag, args[++index])
  }
  const local = values.get("--workspace")
  const origin = values.get("--url")
  const conversation = values.get("--conversation")
  if (local ? origin !== undefined || conversation !== undefined : !origin || !conversation) return failure(USAGE)

  let report: WorkspacePreflight
  try {
    if (local) {
      report = parseWorkspacePreflight(await inspectWorkspace(local))
    } else {
      let url: URL
      try {
        url = new URL(origin!)
        const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
          url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
          !/^[A-Za-z0-9:._-]{1,256}$/.test(conversation!)) throw new Error("invalid target")
      } catch {
        return failure("Use an HTTPS origin (or HTTP loopback) and a valid conversation key; omit URL credentials, paths and query strings.")
      }
      const token = options.token ?? process.env.ABOITEAU_API_TOKEN
      if (!token || /[\r\n]/.test(token)) return failure("Set ABOITEAU_API_TOKEN to use the authenticated API.")
      url.pathname = `/api/conversations/${encodeURIComponent(conversation!)}/workspace/preflight`
      const request = new Request(url.toString(), {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      })
      const response = await (options.fetcher ?? ((input) => fetch(input)))(request)
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => {})
        return failure("API authentication was refused. Check ABOITEAU_API_TOKEN and workspace access.")
      }
      const value = await boundedJson(response)
      if (!response.ok) {
        if (coldError(value)) return { exitCode: 2, stdout: "", stderr: "Workspace is not running. This read-only request did not start it; prepare it through the existing workflow, then retry." }
        return failure(`Workspace inspection request failed (HTTP ${response.status}).`)
      }
      report = parseWorkspacePreflight(value)
    }
  } catch {
    return failure("Workspace inspection failed. No setup or check commands were run.")
  }
  return {
    exitCode: report.status === "blocked" ? 2 : 0,
    stdout: json ? JSON.stringify(report, null, 2) : render(report),
    stderr: "",
  }
}

if (import.meta.main) {
  const result = await runWorkspacePreflight(process.argv.slice(2))
  if (result.stdout) console.log(result.stdout)
  if (result.stderr) console.error(result.stderr)
  process.exitCode = result.exitCode
}
