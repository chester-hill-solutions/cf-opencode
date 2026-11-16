import { expect, test } from "bun:test"
import { runWorkspaceRepository } from "../scripts/workspace-repository"

const target = ["--url", "https://example.test", "--conversation", "channel:thread"]
const selection = { repository: "https://github.com/owner/repo", baseBranch: "main", workingBranch: "aboiteau/task-123" }
const pending = { ...selection, schemaVersion: 1, bindingID: "11111111-1111-4111-8111-111111111111", status: "pending", baseCommit: null }
const select = ["select", ...target, "--repository", "https://github.com/OWNER/Repo.git", "--base-branch", "main", "--working-branch", "aboiteau/task-123"]

test("get uses only the passive authenticated binding endpoint and validates the envelope", async () => {
  const requests: Request[] = []
  const result = await runWorkspaceRepository(["get", ...target, "--json"], {
    token: "fixture-token", fetcher: async request => { requests.push(request); return Response.json({ workspaceRepository: null, ignored: "not retained" }) },
  })
  expect(result).toEqual({ exitCode: 0, stdout: '{\n  "workspaceRepository": null\n}', stderr: "" })
  expect(requests).toHaveLength(1)
  expect(requests[0].url).toBe("https://example.test/api/conversations/channel%3Athread/workspace/repository")
  expect(requests[0].method).toBe("GET")
  expect(requests[0].body).toBeNull()
  expect(requests[0].redirect).toBe("error")
  expect(requests[0].headers.get("authorization")).toBe("Bearer fixture-token")
  expect(JSON.stringify(result)).not.toContain("fixture-token")
})

test("select sends canonical intent only and labels pending state without readiness claims", async () => {
  const requests: Request[] = []
  const result = await runWorkspaceRepository(select, { token: "fixture-token", fetcher: async request => {
    requests.push(request)
    expect(await request.json()).toEqual(selection)
    return Response.json({ workspaceRepository: pending }, { status: 201 })
  } })
  expect(requests).toHaveLength(1)
  expect(requests[0].method).toBe("PUT")
  expect(requests[0].headers.get("content-type")).toBe("application/json")
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain("pending")
  expect(result.stdout).toContain("not resolved")
  expect(result.stdout).toContain("no runtime or provider was started")
  expect(result.stdout).not.toContain("ready")
})

test("server materialization proof is retained, including immutable base SHA and binding ID", async () => {
  const bound = { ...pending, status: "bound", baseCommit: "a".repeat(40) }
  const result = await runWorkspaceRepository([...select, "--json"], { token: "fixture-token", fetcher: async () => Response.json({ workspaceRepository: bound }) })
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ workspaceRepository: bound })
  const readable = await runWorkspaceRepository(["get", ...target], { token: "fixture-token", fetcher: async () => Response.json({ workspaceRepository: bound }) })
  expect(readable.stdout).toContain("original base commit: " + bound.baseCommit)
  expect(readable.stdout).toContain("does not establish that setup or checks passed")
})

test("invalid targets, actions, credentials and selections never send a request or echo inputs", async () => {
  let requests = 0
  const options = { token: "fixture-token", fetcher: async () => { requests++; return Response.json({ workspaceRepository: pending }) } }
  for (const origin of ["http://example.test", "https://user:SECRET@example.test", "https://example.test/path", "https://example.test/path/..", "https://example.test/?SECRET", "https://example.test/#SECRET"]) {
    const result = await runWorkspaceRepository(["get", "--url", origin, "--conversation", "test"], options)
    expect(result.exitCode).toBe(1)
    expect(JSON.stringify(result)).not.toContain("SECRET")
  }
  for (const args of [[], [...target], ["delete", ...target], ["get", ...target, "--token", "SECRET"], ["get", ...target, "--repository", selection.repository], ["get", ...target, "--json", "--json"], ["get", "--url", "https://example.test", "--conversation", ".."], ["select", ...target], [...select, "--base-branch", "other"]]) {
    const result = await runWorkspaceRepository(args, options)
    expect(result.exitCode).toBe(1)
    expect(JSON.stringify(result)).not.toContain("SECRET")
  }
  expect((await runWorkspaceRepository(["get", ...target], { ...options, token: "" })).exitCode).toBe(1)
  expect((await runWorkspaceRepository(["get", ...target], { ...options, token: "SECRET\r\nheader" })).exitCode).toBe(1)
  expect(requests).toBe(0)
})

test("HTTP loopback is supported and server authentication/errors remain generic", async () => {
  let cancelled = false
  for (const status of [401, 403, 409, 500, 302]) {
    const result = await runWorkspaceRepository(["get", "--url", "http://127.0.0.1:8787", "--conversation", "test", "--json"], {
      token: "fixture-token", fetcher: async request => {
        expect(request.url).toStartWith("http://127.0.0.1:8787/")
        return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true } }), { status, headers: { location: "https://untrusted.test/SECRET" } })
      },
    })
    expect(result.exitCode).toBe(status === 409 ? 2 : 1)
    expect(result.stdout).toBe("")
    expect(JSON.stringify(result)).not.toContain("SECRET")
    expect(JSON.stringify(result)).not.toContain("fixture-token")
  }
  expect(cancelled).toBe(true)
})

test("invalid or mismatched server success metadata is never printed as a selected binding", async () => {
  for (const value of [null, {}, { workspaceRepository: null }, { workspaceRepository: { ...pending, repository: "https://github.com/owner/other" } }, { workspaceRepository: { ...pending, status: "bound", baseCommit: null } }, { workspaceRepository: { ...pending, bindingID: "invalid", secret: "SECRET" } }]) {
    const result = await runWorkspaceRepository([...select, "--json"], { token: "fixture-token", fetcher: async () => Response.json(value) })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(JSON.stringify(result)).not.toContain("SECRET")
  }
})

test("body size, malformed JSON and stalled fetch/stream responses are bounded", async () => {
  for (const body of ["{broken SECRET", "x".repeat(17000)]) {
    const result = await runWorkspaceRepository(["get", ...target], { token: "fixture-token", fetcher: async () => new Response(body) })
    expect(result.exitCode).toBe(1)
    expect(JSON.stringify(result)).not.toContain("SECRET")
  }
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return new Promise<void>(() => {}) } })
  const stalledBody = await runWorkspaceRepository(["get", ...target], { token: "fixture-token", timeoutMs: 10, fetcher: async () => new Response(stream) })
  expect(stalledBody.exitCode).toBe(1)
  expect(cancelled).toBe(true)
  const stalledFetch = await runWorkspaceRepository(["get", ...target], { token: "fixture-token", timeoutMs: 10, fetcher: async () => new Promise<Response>(() => {}) })
  expect(stalledFetch.exitCode).toBe(1)
})
