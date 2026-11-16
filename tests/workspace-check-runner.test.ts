import { createHash } from "node:crypto"
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runWorkspaceCheckRunner } from "../scripts/workspace-check-runner"
import { checkBinding, checkRequest, checkSnapshot, dockerResult, fakeCheckDocker } from "./fixtures/workspace-check"
import { parseWorkspaceCheckCollectorClaimRequest, parseWorkspaceCheckCollectorCompletion } from "../src/workspace-check-dispatch"
import type { WorkspaceFetcher } from "../scripts/lib/workspace-api"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const collectorID = "44444444-4444-4444-8444-444444444444", attemptID = "55555555-5555-4555-8555-555555555555"
async function fixture(options: { lostClaim?: boolean; lostCompletion?: boolean; badSource?: boolean; stale?: boolean; unknown?: boolean; failExit?: number; badAck?: boolean; cleanupFails?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "aboiteau-runner-test-")); directories.push(directory)
  const request = await checkRequest(), snapshot = await checkSnapshot(), docker = fakeCheckDocker({ exitCode: options.failExit, cleanupFails: options.cleanupFails })
  const intent = { ...request, schemaVersion: 1, mode: "committed_only", binding: checkBinding, status: "exported", checksNotRun: true, createdAt: 1, source: { treeOID: snapshot.tree, sourceSHA256: snapshot.snapshotSHA256 }, worktreeChanges: "unverified" }
  const calls: { url: string }[] = [], claims: unknown[] = [], completions: unknown[] = []
  let completeCount = 0, claimCount = 0
  const fetcher: WorkspaceFetcher = async req => {
    calls.push({ url: req.url })
    expect(req.headers.get("authorization")).toBe("Bearer synthetic-collector-key")
    expect(req.redirect).toBe("error")
    const path = new URL(req.url).pathname
    if (path.endsWith("/pending")) return Response.json({ pending: [{ conversationKey: "channel:thread", requestID: request.requestID, imageID: request.imageID, queuedAt: 1, status: "queued", attemptID: null, collectorID: null }], nextCursor: null })
    if (path.endsWith("/claim")) {
      const body = parseWorkspaceCheckCollectorClaimRequest(await req.json()); claims.push(body); claimCount++
      expect(JSON.parse(await readFile(join(directory, "active.json"), "utf8")).claimRequestID).toBe(body.claimRequestID)
      if (options.lostClaim && claimCount === 1) throw new Error("simulated lost acknowledgment")
      return Response.json({ claim: { ...body, attemptID, conversationKey: "channel:thread", workspaceCheck: intent } })
    }
    if (path.endsWith("/source")) return Response.json(options.badSource ? { ...JSON.parse(snapshot.canonicalJSON), commit: "c".repeat(40) } : JSON.parse(snapshot.canonicalJSON))
    if (path.endsWith("/freshness")) return Response.json({ requestID: request.requestID, expectedBindingID: request.expectedBindingID, commitOID: request.commitOID, mode: "committed_only", worktreeChanges: "unverified", checksNotRun: true, status: options.stale ? "stale" : options.unknown ? "unknown" : "current", observedCommitOID: request.commitOID, observedTreeOID: snapshot.tree })
    if (path.endsWith("/reconcile")) {
      const body = await req.json() as Record<string, unknown>
      expect(body).toEqual({ collectorID, claimRequestID: parseWorkspaceCheckCollectorClaimRequest(claims[0]).claimRequestID, attemptID, cleanupConfirmed: true })
      const completed = completions.length ? parseWorkspaceCheckCollectorCompletion(completions[0]) : null
      return Response.json({ execution: { schemaVersion: 1, requestID: request.requestID, status: completed ? "completed" : "claimed", queuedAt: 1, cleanupReconciledAt: Date.now(), completedAt: completed ? Date.now() : null, completionSHA256: completed ? createHash("sha256").update(JSON.stringify(completed)).digest("hex") : null, logs: completed ? { key: "checks/test", sha256: "e".repeat(64) } : null, target: null, attempt: { attemptID, collectorID, claimRequestID: body.claimRequestID, claimedAt: 1 }, receipt: completed?.receipt ?? null, notification: { status: "not_requested", attempts: 0, nextAttemptAt: 0 } } })
    }
    if (path.endsWith("/complete")) {
      const completion = parseWorkspaceCheckCollectorCompletion(await req.json()); completions.push(completion); completeCount++
      if (options.lostCompletion && completeCount === 1) throw new Error("simulated lost acknowledgment")
      return Response.json({ execution: { schemaVersion: 1, requestID: request.requestID, status: "completed", queuedAt: 1, cleanupReconciledAt: null, completedAt: Date.now(), completionSHA256: createHash("sha256").update(JSON.stringify(completion)).digest("hex"), logs: { key: "checks/test", sha256: "e".repeat(64) }, target: null, attempt: { attemptID: options.badAck ? collectorID : attemptID, collectorID, claimRequestID: completion.claimRequestID, claimedAt: 1 }, receipt: completion.receipt, notification: { status: "not_requested", attempts: 0, nextAttemptAt: 0 } } })
    }
    throw new Error("Unexpected route")
  }
  return { directory, request, snapshot, docker, calls, claims, completions, options: { url: "https://example.invalid", directory, collectorID, imageID: request.imageID, token: "synthetic-collector-key", fetcher, docker: docker.runner } }
}

test("journal precedes claim; fixed host image and collector authority produce one execution and exact completion", async () => {
  const f = await fixture()
  expect(await runWorkspaceCheckRunner(f.options)).toEqual({ status: "completed", attemptID, outcome: "passed", executionRetried: false })
  expect(f.docker.calls.filter(c => c[0] === "start")).toHaveLength(1)
  expect(f.completions).toHaveLength(1)
  expect(await Bun.file(join(f.directory, "active.json")).exists()).toBe(false)
  const claimID = parseWorkspaceCheckCollectorClaimRequest(f.claims[0]).claimRequestID
  expect(JSON.parse(await readFile(join(f.directory, claimID, "completed.json"), "utf8")).phase).toBe("completed")
  const completion = parseWorkspaceCheckCollectorCompletion(f.completions[0])
  expect(completion.attemptID).toBe(attemptID)
  expect(completion.receipt.sourceSHA256).toBe(f.snapshot.snapshotSHA256)
  for (const args of f.docker.calls.filter(c => c[0] === "create")) for (const forbidden of ["--env", "-e", "--mount", "-v", "--volume"]) expect(args).not.toContain(forbidden)
})

test("lost claim acknowledgement retries same frozen identity, never obtains another attempt", async () => {
  const f = await fixture({ lostClaim: true })
  expect((await runWorkspaceCheckRunner(f.options)).status).toBe("completed")
  expect(f.claims).toHaveLength(2); expect(f.claims[1]).toEqual(f.claims[0])
  expect(f.docker.calls.filter(c => c[0] === "start")).toHaveLength(1)
})

test("lost completion acknowledgement reconciles exact saved body and logs without starting Docker again", async () => {
  const f = await fixture({ lostCompletion: true })
  expect((await runWorkspaceCheckRunner(f.options)).status).toBe("error")
  const starts = f.docker.calls.filter(c => c[0] === "start").length
  expect((await runWorkspaceCheckRunner(f.options)).status).toBe("completed")
  expect(f.completions).toHaveLength(2); expect(f.completions[1]).toEqual(f.completions[0])
  expect(f.docker.calls.filter(c => c[0] === "start")).toHaveLength(starts)
  expect(f.claims).toHaveLength(1)
})

test("interrupted preparation is blocked on restart; no second source fetch or execution", async () => {
  const f = await fixture({ badSource: true })
  expect((await runWorkspaceCheckRunner(f.options)).status).toBe("error")
  const sourceCalls = f.calls.filter(c => new URL(c.url).pathname.endsWith("/source")).length
  expect(await runWorkspaceCheckRunner(f.options)).toEqual({ status: "blocked", attemptID, executionRetried: false })
  expect(f.calls.filter(c => new URL(c.url).pathname.endsWith("/source"))).toHaveLength(sourceCalls)
  expect(f.docker.calls).toHaveLength(0); expect(f.claims).toHaveLength(1)
})

test("stale or unknown freshness uploads honest not-run receipt and executes no Docker commands", async () => {
  for (const options of [{ stale: true }, { unknown: true }]) {
    const f = await fixture(options)
    expect(await runWorkspaceCheckRunner(f.options)).toEqual({ status: "completed", attemptID, outcome: "not_run", executionRetried: false })
    expect(f.docker.calls).toHaveLength(0)
  }
})

test("fake repository success output cannot turn nonzero state into a successful service completion", async () => {
  const f = await fixture({ failExit: 7 })
  expect((await runWorkspaceCheckRunner(f.options)).outcome).toBe("failed")
  expect(parseWorkspaceCheckCollectorCompletion(f.completions[0]).receipt.exitCode).toBe(7)
})

test("host lock, image mismatch, unsafe journal and symlink metadata prevent execution", async () => {
  const f = await fixture()
  await mkdir(join(f.directory, "runner.lock"), { mode: 0o700 })
  expect((await runWorkspaceCheckRunner(f.options)).status).toBe("busy")
  await rm(join(f.directory, "runner.lock"), { recursive: true })
  expect((await runWorkspaceCheckRunner({ ...f.options, imageID: "sha256:" + "c".repeat(64) })).status).toBe("idle")
  await writeFile(join(f.directory, "active.json"), "{}", { mode: 0o600 })
  expect((await runWorkspaceCheckRunner(f.options)).status).toBe("error")
  await rm(join(f.directory, "active.json"))
  const target = join(f.directory, "target"); await writeFile(target, "{}", { mode: 0o600 })
  await symlink(target, join(f.directory, "active.json"))
  expect((await runWorkspaceCheckRunner(f.options)).status).toBe("error")
  expect(f.docker.calls).toHaveLength(0)
})

test("wrong completion acknowledgement is retained, and changed captured logs prevent reconciliation", async () => {
  const f = await fixture({ badAck: true })
  expect((await runWorkspaceCheckRunner(f.options)).status).toBe("error")
  const active = JSON.parse(await readFile(join(f.directory, "active.json"), "utf8"))
  await writeFile(join(f.directory, active.claimRequestID, "evidence", "stdout.log"), "tampered")
  expect((await runWorkspaceCheckRunner(f.options)).status).toBe("error")
  expect(f.completions).toHaveLength(1)
  expect(f.docker.calls.filter(c => c[0] === "start")).toHaveLength(1)
})


test("owned claimed work without a local journal blocks new execution, including later queue pages", async () => {
  const f = await fixture(), pages: string[] = []
  const fetcher: WorkspaceFetcher = async request => {
    const url = new URL(request.url); pages.push(url.search)
    if (!url.search) return Response.json({ pending: [{ conversationKey: "queued", requestID: f.request.requestID, imageID: f.request.imageID, status: "queued" }], nextCursor: "next-page" })
    return Response.json({ pending: [{ conversationKey: "old:claim", requestID: f.request.requestID, imageID: f.request.imageID, status: "claimed", attemptID, collectorID, claimRequestID: "66666666-6666-4666-8666-666666666666" }], nextCursor: null })
  }
  expect((await runWorkspaceCheckRunner({ ...f.options, fetcher })).status).toBe("blocked")
  expect(pages).toEqual(["", "?cursor=next-page"])
  expect(f.docker.calls).toHaveLength(0)
})

test("cleanup unknown retains journal and ownership until explicit container-absence reconciliation", async () => {
  const f = await fixture({ cleanupFails: true })
  expect(await runWorkspaceCheckRunner(f.options)).toEqual({ status: "blocked", attemptID, outcome: "cleanup_unknown", executionRetried: false })
  const previousCalls = f.docker.calls.length
  expect((await runWorkspaceCheckRunner(f.options)).status).toBe("blocked")
  expect(f.docker.calls).toHaveLength(previousCalls)
  // An extant container or unavailable Docker never counts as cleanup.
  expect((await runWorkspaceCheckRunner({ ...f.options, reconcile: true, docker: async () => dockerResult("ownedcontainer\n") })).status).toBe("blocked")
  const commands: string[][] = []
  const absent = await runWorkspaceCheckRunner({ ...f.options, reconcile: true, docker: async args => { commands.push(args); return dockerResult("") } })
  expect(absent.status).toBe("reconciled")
  expect(commands).toEqual([["container", "ls", "--all", "--filter", "label=org.aboiteau.check.request=" + f.request.requestID, "--format", "{{.ID}}"]])
  expect(parseWorkspaceCheckCollectorCompletion(f.completions[0]).receipt.outcome).toBe("cleanup_unknown")
  expect(f.docker.calls.filter(args => args[0] === "start")).toHaveLength(1)
  expect(await Bun.file(join(f.directory, "active.json")).exists()).toBe(false)
})

test("explicit recovery of a lost host journal reuses server claim and only observes absence", async () => {
  const f = await fixture({ badSource: true })
  expect((await runWorkspaceCheckRunner(f.options)).status).toBe("error")
  const body = parseWorkspaceCheckCollectorClaimRequest(f.claims[0])
  await rm(join(f.directory, "active.json"))
  const fetcher: WorkspaceFetcher = async request => new URL(request.url).pathname.endsWith("/pending")
    ? Response.json({ pending: [{ conversationKey: "channel:thread", requestID: f.request.requestID, imageID: f.request.imageID, queuedAt: 1, status: "claimed", attemptID, collectorID, claimRequestID: body.claimRequestID }], nextCursor: null })
    : f.options.fetcher(request)
  const dockerCalls: string[][] = []
  expect((await runWorkspaceCheckRunner({ ...f.options, fetcher, reconcile: true, docker: async args => { dockerCalls.push(args); return dockerResult("") } })).status).toBe("reconciled")
  expect(f.claims).toHaveLength(2); expect(f.claims[1]).toEqual(f.claims[0])
  expect(dockerCalls.map(args => args[0])).toEqual(["container"])
  expect(f.completions).toHaveLength(0)
})

test("unresolved evidence cannot be silently moved to another service origin or collector identity", async () => {
  const f = await fixture({ badSource: true })
  expect((await runWorkspaceCheckRunner(f.options)).status).toBe("error")
  const calls = f.calls.length
  expect((await runWorkspaceCheckRunner({ ...f.options, url: "https://other.invalid" })).status).toBe("error")
  expect((await runWorkspaceCheckRunner({ ...f.options, collectorID: attemptID })).status).toBe("error")
  expect(f.calls).toHaveLength(calls)
  expect(f.docker.calls).toHaveLength(0)
})


test("global owner without actor rows blocks polling and reconciles the same nonce without execution", async () => {
  const f = await fixture(), claimRequestID = "66666666-6666-4666-8666-666666666666", calls: string[] = []
  const fetcher: WorkspaceFetcher = async request => {
    const path = new URL(request.url).pathname; calls.push(path)
    if (path.endsWith("/pending")) return Response.json({ pending: [], nextCursor: null, owner: { conversationKey: "channel:thread", collectorID, claimRequestID, imageID: f.request.imageID, claimedAt: 1 } })
    expect(path).toEndWith("/claim")
    expect(await request.json()).toEqual({ collectorID, claimRequestID, imageID: f.request.imageID })
    return Response.json({ claim: null })
  }
  expect((await runWorkspaceCheckRunner({ ...f.options, fetcher })).status).toBe("blocked")
  expect(calls).toHaveLength(1)
  expect(await runWorkspaceCheckRunner({ ...f.options, fetcher, reconcile: true })).toEqual({ status: "reconciled", executionRetried: false })
  expect(f.docker.calls).toHaveLength(0)
  expect(await Bun.file(join(f.directory, "active.json")).exists()).toBe(false)
})
