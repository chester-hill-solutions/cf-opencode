import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runWorkspacePreflight } from "../scripts/workspace-preflight"
import type { WorkspacePreflight } from "../src/workspace-preflight"

const report: WorkspacePreflight = {
  schemaVersion: 1,
  mode: "read_only",
  status: "needs_verification",
  repository: { kind: "git", head: "a".repeat(40), branch: "main", dirty: false },
  tools: [{ name: "bun", available: true }],
  project: { packageManager: "bun", manifests: ["package.json"], scripts: ["test"], guidance: [], dependencies: "missing" },
  suggestions: [{ purpose: "check", argv: ["bun", "run", "test"], requiresApproval: true }],
  findings: [],
  verification: { setup: "not_run", checks: "not_run" },
}

describe("workspace preflight CLI", () => {
  test("inspects a real local project without executing its scripts or contacting the API", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aboiteau-preflight-cli-"))
    try {
      writeFileSync(join(directory, "package.json"), JSON.stringify({ packageManager: "bun@1.3.5", scripts: { test: "touch MUST-NOT-RUN" } }))
      writeFileSync(join(directory, "bun.lock"), JSON.stringify({ lockfileVersion: 1 }))
      const result = await runWorkspacePreflight(["--workspace", directory, "--json"], {
        fetcher: async () => { throw new Error("local inspection must not contact API") },
      })
      const parsed = JSON.parse(result.stdout)
      expect(result.exitCode).toBe(0)
      expect(parsed.mode).toBe("read_only")
      expect(parsed.project.scripts).toEqual(["test"])
      expect(parsed.verification).toEqual({ setup: "not_run", checks: "not_run" })
      expect(existsSync(join(directory, "MUST-NOT-RUN"))).toBe(false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("uses only the authenticated passive endpoint and labels verification honestly", async () => {
    const requests: Request[] = []
    const result = await runWorkspacePreflight(["--url", "https://example.test", "--conversation", "channel:thread"], {
      token: "fixture-token",
      fetcher: async (request) => { requests.push(request); return Response.json(report) },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe("https://example.test/api/conversations/channel%3Athread/workspace/preflight")
    expect(requests[0].method).toBe("GET")
    expect(requests[0].headers.get("authorization")).toBe("Bearer fixture-token")
    expect(requests[0].redirect).toBe("error")
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("needs verification")
    expect(result.stdout).toContain("Setup: not run. Checks: not run.")
    expect(result.stdout).toContain("requires approval; not run")
    expect(JSON.stringify(result)).not.toContain("fixture-token")
  })

  test("rejects insecure or credential-bearing origins before sending a token", async () => {
    let fetched = false
    for (const origin of ["http://example.test", "https://user:secret@example.test", "https://example.test/other", "https://example.test/?token=secret"]) {
      const result = await runWorkspacePreflight(["--url", origin, "--conversation", "test"], {
        token: "fixture-token", fetcher: async () => { fetched = true; return Response.json(report) },
      })
      expect(result.exitCode).toBe(1)
      expect(JSON.stringify(result)).not.toContain("secret")
    }
    expect(fetched).toBe(false)
  })

  test("treats a cold workspace as blocked without trying another endpoint", async () => {
    let count = 0
    const result = await runWorkspacePreflight(["--url", "http://127.0.0.1:4000", "--conversation", "test"], {
      token: "fixture-token",
      fetcher: async () => { count++; return Response.json({ code: "WORKSPACE_NOT_RUNNING" }, { status: 503 }) },
    })
    expect(count).toBe(1)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain("did not start it")
  })

  test("does not print raw authentication failures or malformed/oversized bodies", async () => {
    for (const response of [
      new Response("server-secret", { status: 401 }),
      Response.json({ serverSecret: "server-secret" }),
      new Response("server-secret".repeat(20_000)),
    ]) {
      const result = await runWorkspacePreflight(["--url", "https://example.test", "--conversation", "test"], {
        token: "fixture-token", fetcher: async () => response,
      })
      expect(result.exitCode).toBe(1)
      expect(JSON.stringify(result)).not.toContain("server-secret")
      expect(JSON.stringify(result)).not.toContain("fixture-token")
    }
  })

  test("exports a versioned JSON report and preserves blocked exit status", async () => {
    const result = await runWorkspacePreflight(["--url", "https://example.test", "--conversation", "test", "--json"], {
      token: "fixture-token", fetcher: async () => Response.json({ ...report, status: "blocked", repository: { kind: "unavailable", head: null, branch: null, dirty: null }, findings: [{ code: "repository_unavailable", severity: "blocker", message: "Repository metadata cannot be inspected safely." }] }),
    })
    expect(result.exitCode).toBe(2)
    expect(JSON.parse(result.stdout).verification).toEqual({ setup: "not_run", checks: "not_run" })
  })

  test("rejects ambiguous local/remote modes and unsupported flags", async () => {
    for (const args of [[], ["--token", "secret"], ["--workspace", ".", "--url", "https://example.test"], ["--url", "https://example.test"]]) {
      const result = await runWorkspacePreflight(args)
      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain("Usage:")
      expect(result.stderr).not.toContain("secret")
    }
  })
})
