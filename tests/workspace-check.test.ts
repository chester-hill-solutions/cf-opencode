import { expect, test } from "bun:test"
import { parseWorkspaceCheckIntent, parseWorkspaceCheckLocalReceipt, parseWorkspaceCheckRequest, sameWorkspaceCheckRequest, workspaceCheckRequestSHA256 } from "../src/workspace-check"
import { checkBinding, checkRequest } from "./fixtures/workspace-check"

test("check requests strictly bind bounded argv, full object ID, image and idempotency identity", async () => {
  const request = await checkRequest()
  expect(parseWorkspaceCheckRequest(request)).toEqual(request)
  const mutations = [{ ...request, commitOID: "main" }, { ...request, commitOID: "-" + "a".repeat(39) }, { ...request, imageID: "checker:latest" }, { ...request, timeoutMs: 120001 }, { ...request, timeoutMs: 0 }, { ...request, timeoutMs: 1.5 }, { ...request, argv: [] }, { ...request, argv: ["--eval", "x"] }, { ...request, argv: ["bun", "SECRET\n"] }, { ...request, argv: ["bun", ...Array(65).fill("a")] }, { ...request, argv: Array(6).fill("x".repeat(2048)) }, { ...request, token: "SECRET" }]
  for (const input of mutations) expect(() => parseWorkspaceCheckRequest(input)).toThrow("invalid or unsupported")
  // Explicit shell commands remain explicit argv; there is no implicit shell.
  expect(parseWorkspaceCheckRequest({ ...request, argv: ["/bin/sh", "-c", "exit 0"] }).argv).toEqual(["/bin/sh", "-c", "exit 0"])
  expect(sameWorkspaceCheckRequest(request, { ...request, argv: ["bun", "other.ts"] })).toBe(false)
  expect(await workspaceCheckRequestSHA256(request)).toBe(await workspaceCheckRequestSHA256({ ...request }))
  expect(await workspaceCheckRequestSHA256(request)).not.toBe(await workspaceCheckRequestSHA256({ ...request, timeoutMs: 2 }))
})

test("server intents cannot claim execution or misbind export identity", async () => {
  const request = await checkRequest()
  const intent = { ...request, schemaVersion: 1, mode: "committed_only", binding: checkBinding, status: "requested", createdAt: 10, source: null, checksNotRun: true, worktreeChanges: "unverified" }
  expect(parseWorkspaceCheckIntent(intent).status).toBe("requested")
  expect(sameWorkspaceCheckRequest(request, parseWorkspaceCheckIntent(intent))).toBe(true)
  expect(await workspaceCheckRequestSHA256(parseWorkspaceCheckIntent(intent))).toBe(await workspaceCheckRequestSHA256(request))
  for (const input of [{ ...intent, status: "passed" }, { ...intent, checksNotRun: false }, { ...intent, source: { treeOID: "c".repeat(40), sourceSHA256: "d".repeat(64) } }, { ...intent, status: "exported" }, { ...intent, expectedBindingID: "33333333-3333-4333-8333-333333333333" }]) expect(() => parseWorkspaceCheckIntent(input)).toThrow()
})

test("local receipt validator never upgrades incomplete cleanup or relabels provenance", async () => {
  const request = await checkRequest()
  const log = { sha256: "a".repeat(64), bytes: 0, capturedBytes: 0, truncated: false }
  const receipt = { schemaVersion: 1, mode: "committed_only", provenance: "local_operator", request, binding: checkBinding, treeOID: "b".repeat(40), sourceSHA256: "c".repeat(64), platform: "linux/amd64", startedAt: 10, finishedAt: 20, outcome: "passed", exitCode: 0, cleanupConfirmed: true, freshness: { before: "matched", after: "matched" }, worktreeChanges: "unverified", baselineChecks: "not_run", testOrConfigChanges: "not_evaluated", logs: { stdout: log, stderr: log } }
  expect(parseWorkspaceCheckLocalReceipt(receipt).outcome).toBe("passed")
  for (const input of [{ ...receipt, provenance: "server" }, { ...receipt, exitCode: 1 }, { ...receipt, cleanupConfirmed: false }, { ...receipt, baselineChecks: "passed" }, { ...receipt, testOrConfigChanges: "none" }, { ...receipt, finishedAt: 9 }, { ...receipt, logs: { stdout: { ...log, bytes: 1 }, stderr: log } }]) expect(() => parseWorkspaceCheckLocalReceipt(input)).toThrow()
})
