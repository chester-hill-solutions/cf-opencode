import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { runWorkspaceCheck } from "../scripts/workspace-check"
import { parseWorkspaceCheckRequest, type WorkspaceCheckRequest } from "../src/workspace-check"
import { checkBinding, checkRequest, checkSnapshot, fakeCheckDocker } from "./fixtures/workspace-check"

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function targetDirectory() { const dir = await mkdtemp(join(tmpdir(), "aboiteau-check-cli-")); directories.push(dir); return join(dir, "evidence") }
async function invocation(out: string) {
  const request = await checkRequest()
  return ["run", "--url", "https://api.example.test", "--conversation", "task:1", "--commit", request.commitOID, "--image", request.imageID, "--timeout-ms", "1000", "--out", out, "--json", "--", ...request.argv]
}
async function apiFixture(options: { corruptSource?: boolean; stale?: boolean; status?: number } = {}) {
  const snapshot = await checkSnapshot(), paths: string[] = [], methods: string[] = []
  let request: WorkspaceCheckRequest | undefined
  const fetcher = async (input: Request) => {
    expect(input.redirect).toBe("error")
    expect(input.headers.get("authorization")).toBe("Bearer TEST-COLLECTOR-SECRET")
    const path = new URL(input.url).pathname
    paths.push(path); methods.push(input.method)
    if (options.status) return new Response("SECRET RESPONSE", { status: options.status })
    if (path.endsWith("/repository")) return Response.json({ workspaceRepository: checkBinding })
    if (path.endsWith("/checks")) {
      request = parseWorkspaceCheckRequest(await input.json())
      expect(request.commitOID).toBe(snapshot.commit)
      return Response.json({ workspaceCheck: { ...request, schemaVersion: 1, mode: "committed_only", binding: checkBinding, status: "exported", createdAt: 100, source: { treeOID: snapshot.tree, sourceSHA256: snapshot.snapshotSHA256 }, checksNotRun: true, worktreeChanges: "unverified" } }, { status: 201 })
    }
    if (path.endsWith("/source")) return new Response(options.corruptSource ? snapshot.canonicalJSON.replace('"schemaVersion":1', '"schemaVersion":2') : snapshot.canonicalJSON)
    if (path.endsWith("/freshness") && request) return Response.json({ requestID: request.requestID, expectedBindingID: request.expectedBindingID, commitOID: request.commitOID, observedCommitOID: options.stale ? "f".repeat(40) : snapshot.commit, observedTreeOID: snapshot.tree, status: options.stale ? "stale" : "current", mode: "committed_only", worktreeChanges: "unverified", checksNotRun: true })
    throw new Error("Unexpected API operation")
  }
  return { fetcher, paths, methods }
}

test("CLI checks authenticated exact export offline and never sends completion evidence", async () => {
  const out = await targetDirectory(), api = await apiFixture(), docker = fakeCheckDocker()
  const result = await runWorkspaceCheck(await invocation(out), { token: "TEST-COLLECTOR-SECRET", fetcher: api.fetcher, docker: docker.runner })
  expect(result.exitCode).toBe(0)
  const body = JSON.parse(result.stdout)
  expect(body.receipt.provenance).toBe("local_operator")
  expect(body.receipt.mode).toBe("committed_only")
  expect(body.receipt.outcome).toBe("passed")
  expect(body.receipt.baselineChecks).toBe("not_run")
  expect(api.methods).toEqual(["GET", "POST", "GET", "GET", "GET"])
  expect(api.paths.filter(path => path.endsWith("/freshness"))).toHaveLength(2)
  expect(JSON.stringify(docker.calls)).not.toContain("TEST-COLLECTOR-SECRET")
  for (const file of ["request.json", "journal.json", "receipt.json", "snapshot.json"]) expect(await readFile(join(out, file), "utf8")).not.toContain("TEST-COLLECTOR-SECRET")
  const calls = docker.calls.length, requests = api.paths.length
  const repeat = await runWorkspaceCheck(await invocation(out), { token: "TEST-COLLECTOR-SECRET", fetcher: api.fetcher, docker: docker.runner })
  expect(repeat.exitCode).toBe(3)
  expect(JSON.parse(repeat.stdout).existing).toBe(true)
  for (const [flag, value] of [["--commit", "d".repeat(40)], ["--image", "sha256:" + "d".repeat(64)], ["--conversation", "different-task"]]) {
    const changed = (await invocation(out)).map((entry, index, all) => all[index - 1] === flag ? value : entry)
    expect((await runWorkspaceCheck(changed, { token: "TEST-COLLECTOR-SECRET", fetcher: api.fetcher, docker: docker.runner })).exitCode).toBe(3)
  }
  const changedArgv = [...(await invocation(out)).slice(0, -1), "another-file.ts"]
  expect((await runWorkspaceCheck(changedArgv, { token: "TEST-COLLECTOR-SECRET", fetcher: api.fetcher, docker: docker.runner })).exitCode).toBe(3)
  expect(docker.calls).toHaveLength(calls)
  expect(api.paths).toHaveLength(requests)
  const observed = await runWorkspaceCheck(["observe", "--out", out, "--json"], { docker: docker.runner })
  expect(observed.exitCode).toBe(0)
})

test("invalid target/auth/commit/image/argv are refused before network, Docker or filesystem mutation", async () => {
  const api = await apiFixture(), docker = fakeCheckDocker(), out = await targetDirectory(), valid = await invocation(out)
  const change = (flag: string, value: string) => valid.map((entry, index) => valid[index - 1] === flag ? value : entry)
  for (const args of [change("--url", "https://user:SECRET@api.example.test"), change("--url", "http://public.example.test"), change("--conversation", ".."), change("--commit", "HEAD"), change("--image", "checker:latest"), change("--timeout-ms", "120001"), valid.slice(0, valid.indexOf("--")), [...valid.slice(0, valid.indexOf("--")), "--", "bun", "bad\nSECRET"]]) {
    const result = await runWorkspaceCheck(args, { token: "TEST-COLLECTOR-SECRET", fetcher: api.fetcher, docker: docker.runner })
    expect(result.exitCode).toBe(1)
    expect(JSON.stringify(result)).not.toContain("SECRET")
  }
  expect((await runWorkspaceCheck(valid, { token: "", fetcher: api.fetcher, docker: docker.runner })).exitCode).toBe(1)
  expect(api.paths).toHaveLength(0)
  expect(docker.calls).toHaveLength(0)
  expect(await Bun.file(join(out, "request.json")).exists()).toBe(false)
})

test("corrupt authenticated export and stale HEAD never launch tests", async () => {
  for (const settings of [{ corruptSource: true }, { stale: true }]) {
    const api = await apiFixture(settings), docker = fakeCheckDocker(), out = await targetDirectory()
    const result = await runWorkspaceCheck(await invocation(out), { token: "TEST-COLLECTOR-SECRET", fetcher: api.fetcher, docker: docker.runner })
    expect(result.exitCode).toBe(settings.stale ? 2 : 1)
    expect(docker.calls).toHaveLength(0)
    if (settings.stale) expect(JSON.parse(result.stdout).receipt.outcome).toBe("not_run")
  }
})

test("HTTP failures, arbitrary response bodies and uncertain prior output are never accepted as a pass", async () => {
  for (const status of [401, 403, 409, 302, 503]) {
    const api = await apiFixture({ status }), out = await targetDirectory(), docker = fakeCheckDocker()
    const result = await runWorkspaceCheck(await invocation(out), { token: "TEST-COLLECTOR-SECRET", fetcher: api.fetcher, docker: docker.runner })
    expect(result.exitCode).toBe(1)
    expect(JSON.stringify(result)).not.toContain("SECRET")
    const second = await runWorkspaceCheck(await invocation(out), { token: "TEST-COLLECTOR-SECRET", fetcher: api.fetcher, docker: docker.runner })
    expect(second.exitCode).toBe(3)
    expect(JSON.parse(second.stdout).executionRetried).toBe(false)
    expect(api.paths).toHaveLength(1)
    expect(docker.calls).toHaveLength(0)
  }
})
