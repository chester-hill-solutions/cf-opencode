import { expect, test } from "bun:test"
import { qualifySlackWorkspaceCanary, type QualificationOptions } from "../scripts/qualify-slack-workspace-canary"
import { verifySlackSignature } from "../src/adapters/slack"
import { checkBinding, checkSnapshot } from "./fixtures/workspace-check"
import type { WorkspaceCheckIntent } from "../src/workspace-check"

const imageID = `sha256:${"b".repeat(64)}`
function options(): QualificationOptions {
  return { origin: "https://cf-opencode-arfin-canary-fixture.workers.dev", channel: "C0A5YNXLP6C", threadTS: "1794775000.000001", startTS: "1794775000.000000",
    repository: checkBinding.repository, baseBranch: checkBinding.baseBranch, workingBranch: checkBinding.workingBranch, imageID,
    argv: ["bun", "--no-env-file", "--no-install", "check.ts"], apiToken: "FAKE_API_ONLY", signingSecret: "FAKE_DELEGATION_SECRET_0123456789_ABCDEF", modelRef: "fixture/model", sleep: async () => {} }
}
async function fixture(config: { legacy?: boolean; cleanupUnknown?: boolean } = {}) {
  const calls: string[] = [], controls: string[] = [], evidence: Record<string, unknown> = {}, snapshot = await checkSnapshot()
  let selected = false, warm = false, intent: WorkspaceCheckIntent | undefined, recycled = false
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array()))].map(x => x.toString(16).padStart(2, "0")).join("")
  const input = options()
  const fetcher = async (request: Request): Promise<Response> => {
    const url = new URL(request.url), path = url.pathname
    calls.push(request.method + " " + path)
    expect(path).not.toContain("/messages"); expect(path).not.toContain("onboarding")
    if (path.startsWith("/slack/")) {
      const body = await request.text()
      expect(await verifySlackSignature({ signingSecret: input.signingSecret, timestamp: request.headers.get("x-slack-request-timestamp"), signature: request.headers.get("x-slack-signature"), body })).toBe(true)
      const payload = JSON.parse(body)
      expect(payload.event.user).toBe("UQUALIFICATION")
      if (path === "/slack/canary-route") return Response.json(config.legacy ? { route: "legacy", channel: null, threadTs: null } : { route: "canary", channel: input.channel, threadTs: input.threadTS })
      controls.push(payload.event.text)
      if (payload.event.text.startsWith("!model")) warm = true
      else {
        expect(payload.event.text).toBe("!check " + JSON.stringify(input.argv))
        const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${input.channel}:${input.threadTS}\0${payload.event_id}`)))].map(x => x.toString(16).padStart(2, "0")).join("")
        const requestID = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
        intent = { requestID, expectedBindingID: checkBinding.bindingID, commitOID: snapshot.commit, argv: input.argv, imageID, timeoutMs: 1000,
          schemaVersion: 1, mode: "committed_only", binding: checkBinding, status: "exported", checksNotRun: true, createdAt: Date.now(),
          source: { treeOID: snapshot.tree, sourceSHA256: snapshot.snapshotSHA256 }, worktreeChanges: "unverified" }
      }
      return new Response("ok")
    }
    expect(request.headers.get("authorization")).toBe("Bearer " + input.apiToken)
    if (path === "/api/check-collector/pending") return new Response("unauthorized", { status: 401 })
    if (path.endsWith("/workspace/repository")) {
      if (request.method === "PUT") { selected = true; return Response.json({ workspaceRepository: { ...checkBinding, status: "pending", baseCommit: null } }, { status: 201 }) }
      return Response.json({ workspaceRepository: selected ? warm || recycled ? checkBinding : { ...checkBinding, status: "pending", baseCommit: null } : null })
    }
    if (path.endsWith("/workspace/preflight")) return warm ? Response.json({ schemaVersion: 1, mode: "read_only", status: "needs_verification",
      repository: { kind: "git", head: snapshot.commit, branch: checkBinding.workingBranch, dirty: null }, tools: [], project: { packageManager: "bun", manifests: [], scripts: [], guidance: [], dependencies: "unknown" }, suggestions: [], findings: [], verification: { setup: "not_run", checks: "not_run" } }) : Response.json({ code: "WORKSPACE_NOT_RUNNING" }, { status: 409 })
    if (path.endsWith("/recycle")) { recycled = true; warm = false; return Response.json({ ok: true }) }
    if (path.endsWith("/source")) return new Response(snapshot.canonicalJSON)
    if (path.endsWith("/freshness")) return Response.json({ status: "current", observedCommitOID: snapshot.commit, observedTreeOID: snapshot.tree })
    if (path.includes("/workspace/checks/") && intent) {
      const log = { sha256: digest, bytes: 0, capturedBytes: 0, truncated: false }, now = Date.now()
      const receipt = { schemaVersion: 1, mode: "committed_only", provenance: "local_operator", request: { requestID: intent.requestID, expectedBindingID: intent.expectedBindingID, commitOID: intent.commitOID, argv: intent.argv, imageID: intent.imageID, timeoutMs: intent.timeoutMs }, binding: checkBinding,
        treeOID: snapshot.tree, sourceSHA256: snapshot.snapshotSHA256, platform: "linux/arm64", startedAt: now, finishedAt: now,
        outcome: config.cleanupUnknown ? "cleanup_unknown" : "passed", exitCode: 0, cleanupConfirmed: !config.cleanupUnknown, freshness: { before: "matched", after: "matched" }, worktreeChanges: "unverified", baselineChecks: "not_run", testOrConfigChanges: "not_evaluated", logs: { stdout: log, stderr: log } }
      return Response.json({ workspaceCheck: intent, execution: { schemaVersion: 1, requestID: intent.requestID, status: "completed", queuedAt: now, target: { channel: input.channel, replyTs: input.threadTS }, attempt: { attemptID: "33333333-3333-4333-8333-333333333333", collectorID: "44444444-4444-4444-8444-444444444444", claimRequestID: "55555555-5555-4555-8555-555555555555", claimedAt: now }, receipt,
        completedAt: now, completionSHA256: "c".repeat(64), cleanupReconciledAt: null, logs: { key: "fixture", sha256: digest }, notification: { status: "delivered", attempts: 1, nextAttemptAt: now } } })
    }
    return Response.json({ phase: "idle", modelOverride: input.modelRef })
  }
  return { input: { ...input, fetcher, evidence: async (name: string, value: unknown) => { evidence[name] = value } }, controls, calls, evidence }
}

test("qualification uses only signed model/check controls, validates frozen source and trusted result without completion upload", async () => {
  const f = await fixture(), result = await qualifySlackWorkspaceCanary(f.input)
  expect(result.outcome).toBe("passed"); expect(result.inferenceRequested).toBe(false)
  expect(f.controls).toEqual(["!model fixture/model", "!check " + JSON.stringify(f.input.argv)])
  expect(f.calls.some(value => value.includes("/complete"))).toBe(false)
  expect(f.evidence.queued).toBeDefined(); expect(f.evidence.summary).toBeDefined()
  expect(JSON.stringify(f.evidence)).not.toContain(f.input.apiToken); expect(JSON.stringify(f.evidence)).not.toContain(f.input.signingSecret)
})

test("qualification refuses legacy ownership before event dispatch", async () => {
  const f = await fixture({ legacy: true })
  await expect(qualifySlackWorkspaceCanary(f.input)).rejects.toThrow("ownership")
  expect(f.controls).toEqual([]); expect(f.calls.some(value => value.endsWith("/slack/events"))).toBe(false)
})

test("qualification refuses wrong origin/channel and malformed command before authenticating", async () => {
  for (const patch of [{ origin: "https://production.example.test" }, { channel: "COTHER" }, { modelRef: "fixture/model\nfix it" }]) {
    const f = await fixture()
    await expect(qualifySlackWorkspaceCanary({ ...f.input, ...patch })).rejects.toThrow()
    expect(f.calls).toEqual([])
  }
})

test("qualification retains cleanup unknown evidence without upgrading or repeating checks", async () => {
  const f = await fixture({ cleanupUnknown: true })
  await expect(qualifySlackWorkspaceCanary(f.input)).rejects.toThrow("passing")
  expect(f.evidence.execution).toBeDefined(); expect(f.evidence.summary).toBeUndefined()
  expect(f.controls.filter(text => text.startsWith("!check"))).toHaveLength(1)
})

test("optional reviewed-fixture recycle observes cold runtime and preserved binding HEAD/tree and historical source", async () => {
  const f = await fixture(), result = await qualifySlackWorkspaceCanary({ ...f.input, recycle: true })
  expect(result.coldRestore).toBe("binding_head_tree_and_historical_source_preserved")
  expect(f.controls.filter(value => value.startsWith("!model"))).toHaveLength(2)
  expect(f.controls.filter(value => value.startsWith("!check"))).toHaveLength(1)
  expect(f.evidence["cold-restore"]).toBeDefined()
})
