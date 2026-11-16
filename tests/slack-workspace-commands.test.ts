import { expect, test } from "bun:test"
import { handleSlackWorkspaceCommand, slackWorkspaceDiscardRequestID } from "../src/slack-workspace-commands"
import { handleSlackCommand, type SlackCommandServices } from "../src/slack-commands"

const binding = { schemaVersion: 1, bindingID: "11111111-1111-4111-8111-111111111111", status: "pending", baseCommit: null, repository: "https://github.com/owner/repo", baseBranch: "main", workingBranch: "aboiteau/task" }
function fixture() {
  const calls: Array<{ method: string; body?: unknown }> = [], argv: string[][] = []
  let status = 200, current: unknown = binding
  return {
    calls, argv, setStatus(value: number) { status = value }, setBinding(value: unknown) { current = value },
    service: {
      repository: async (request: Request) => {
        calls.push({ method: request.method, ...(request.method === "PUT" ? { body: await request.json() } : {}) })
        return Response.json({ workspaceRepository: current }, { status })
      },
      check: async (command: string[]) => { argv.push(command); return "Check queued; execution has not completed." },
      checks: async () => "No checks requested.",
    },
  }
}

test("repo delegates canonical selection to the existing route, accepts Slack autolinks, and stays intent-only", async () => {
  const f = fixture()
  const text = await handleSlackWorkspaceCommand("repo", "<https://GitHub.com/Owner/Repo.git|My repository> main aboiteau/task", f.service)
  expect(f.calls).toEqual([{ method: "PUT", body: { repository: binding.repository, baseBranch: "main", workingBranch: "aboiteau/task" } }])
  expect(text).toContain("first normal message")
  expect(text).toContain("started no runtime or provider")
  await handleSlackWorkspaceCommand("repo", "", f.service)
  await handleSlackWorkspaceCommand("repo", "status", f.service)
  expect(f.calls.slice(1)).toEqual([{ method: "GET" }, { method: "GET" }])
  expect(f.argv).toHaveLength(0)
})

test("invalid repo input never reaches selection and conflicts preserve existing work without forcing a new thread", async () => {
  const f = fixture()
  for (const args of ["https://user:SECRET@github.com/o/r main task", "https://github.com/o/r --upload-pack=evil task", "https://github.com/o/r main main", "<https://github.com/o/r|label> main task extra", "https://github.com/o/r.git.git main task", "https://github.com/o/r main refs/heads/task"]) {
    expect(await handleSlackWorkspaceCommand("repo", args, f.service)).not.toContain("SECRET")
  }
  expect(f.calls).toHaveLength(0)
  f.setStatus(409)
  const response = await handleSlackWorkspaceCommand("repo", "https://github.com/owner/repo main aboiteau/task", f.service)
  expect(response).toContain("preserving its files and history")
  expect(response).toContain("new subfolder")
  expect(response).toContain("copy only chosen files")
  expect(response).toContain("preserve originals")
  expect(response).toContain("ask before overwriting conflicts")
  expect(response).toContain("exclude workspace/runtime metadata")
  expect(response).toContain("ordinary agent tools")
  expect(response).toContain("eligible for `!check`")
  expect(response).not.toContain("new Slack thread")
  expect(f.calls).toHaveLength(1)
  expect(f.argv).toEqual([])
})

test("check default and explicit JSON argv are bounded, literal and Slack-decoded exactly once", async () => {
  const f = fixture()
  await handleSlackWorkspaceCommand("check", "", f.service)
  await handleSlackWorkspaceCommand("check", '["bun","test","literal;$(command)","a &amp;amp; b","&lt;x&gt;"]', f.service)
  expect(f.argv).toEqual([["bun", "--no-env-file", "--no-install", "test"], ["bun", "test", "literal;$(command)", "a &amp; b", "<x>"]])
  expect(await handleSlackWorkspaceCommand("checks", "", f.service)).toBe("No checks requested.")
  expect(await handleSlackWorkspaceCommand("checks", '["bun"]', f.service)).toContain("Use `!checks`")
  for (const input of ["bun test", '"bun test"', '{}', '[]', '["bun",3]', '["bun","bad\\narg"]', '["bun","\\ud800"]', JSON.stringify(["bun", ...Array(64).fill("x")])]) {
    expect(await handleSlackWorkspaceCommand("check", input, f.service)).toContain("No check was requested")
  }
  expect(f.argv).toHaveLength(2)
})

test("workspace control failures do not leak service diagnostics and are never prompts", async () => {
  const replies: string[] = []
  const service = {
    workspace: { ...fixture().service, repository: async () => { throw new Error("SECRET-SERVICE-ERROR") } },
    reply: async (text: string) => { replies.push(text) },
  } satisfies Partial<SlackCommandServices>
  // Only workspace/reply services are invoked for these leading commands.
  const complete: SlackCommandServices = {
    getState: async () => ({}), getDefaultModel: async () => "", getModels: async () => [], getSession: async () => { throw new Error("unexpected") }, listSessions: async () => [],
    switchModel: async () => {}, selectSession: async () => {}, newSession: async () => {}, steer: async () => "", stop: async () => "", leave: async () => "", listForms: async () => [], answerForm: async () => {}, cancelForm: async () => {}, usageText: async () => "", setupUrl: "", ...service,
  }
  expect(await handleSlackCommand("!repo", complete)).toBe(true)
  expect(replies[0]).not.toContain("SECRET")
  expect(replies[0]).toContain("inspect retained state")
})


test("an unbound repo status offers a general workspace without creating a binding or dispatching work", async () => {
  const f = fixture(); f.setBinding(null)
  const response = await handleSlackWorkspaceCommand("repo", "status", f.service)
  expect(response).toContain("general workspace is ready")
  expect(response).toContain("repository is optional")
  expect(response).toContain("create or edit files here")
  expect(response).toContain("ordinary agent tools")
  expect(response).toContain("eligible for `!check`")
  expect(f.calls).toEqual([{ method: "GET" }]); expect(f.argv).toEqual([])
})

test("conflicting registered roots remain unchanged and require explicit ordinary-tool instructions", async () => {
  const f = fixture(); f.setStatus(409)
  const response = await handleSlackWorkspaceCommand("repo", "https://github.com/other/project main task/other", f.service)
  expect(response).toContain("does not change the registered root repository")
  expect(response).toContain("explicitly ask me")
  expect(response).toContain("no checkout, copy, or model request")
  expect(f.calls).toHaveLength(1); expect(f.argv).toEqual([])
})


function retentionFixture() {
  let profile = { schemaVersion: 1, profileID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", revision: 1, retention: "persistent", name: null as string | null, status: "active" }
  const records = new Map<string, unknown>(), calls: Array<{ method: string; path: string; query: string; body?: Record<string, unknown> }> = []
  let unavailable = false
  const requestID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  const service = { ...fixture().service, discardRequestID: async () => requestID, workspace: async (request: Request) => {
    const url = new URL(request.url), body = request.method === "GET" ? undefined : await request.json() as Record<string, unknown>
    calls.push({ method: request.method, path: url.pathname, query: url.search, ...(body ? { body } : {}) })
    if (unavailable) return Response.json({ error: "SECRET-DIAGNOSTIC" }, { status: 503 })
    if (url.pathname === "/workspace/profile" && request.method === "GET") return Response.json({ workspace: profile })
    if (url.pathname === "/workspace/profile" && request.method === "PUT") {
      if (body?.expectedProfileID !== profile.profileID || body.expectedRevision !== profile.revision) return new Response(null, { status: 409 })
      profile = { ...profile, revision: profile.revision + 1, retention: String(body.retention), ...(body.name === undefined ? {} : { name: String(body.name) }) }
      return Response.json({ workspace: profile })
    }
    if (url.pathname === "/workspace/discard" && request.method === "GET") return Response.json({ discard: records.get(url.searchParams.get("requestID") ?? "") ?? null })
    if (url.pathname === "/workspace/discard" && request.method === "POST") {
      if (!records.has(String(body?.requestID))) records.set(String(body?.requestID), { schemaVersion: 1, requestID: body?.requestID, expectedProfileID: body?.expectedProfileID, expectedRevision: body?.expectedRevision, status: "prepared", createdAt: 1, completedAt: null })
      if (profile.profileID !== body?.expectedProfileID || profile.revision !== body?.expectedRevision || profile.retention !== "disposable") return new Response(null, { status: 409 })
      const discard = { schemaVersion: 1, requestID: body?.requestID, expectedProfileID: body?.expectedProfileID, expectedRevision: body?.expectedRevision, status: "complete", createdAt: 1, completedAt: 2 }
      records.set(String(body?.requestID), discard)
      profile = { ...profile, profileID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", revision: 1, retention: "persistent", name: null }
      return Response.json({ discard, workspace: profile })
    }
    throw new Error("Unexpected workspace operation")
  } }
  return { service, calls, records, requestID, profile: () => profile, unavailable() { unavailable = true } }
}

test("workspace retention status is passive and first-class repository-free work is permanent", async () => {
  const f = retentionFixture()
  const text = await handleSlackWorkspaceCommand("workspace", "status", f.service)
  expect(text).toContain("persistent (the default)")
  expect(text).toContain("remain repository-free permanently")
  expect(text).toContain("no git initialization, commit or remote")
  expect(f.calls.map(call => [call.method, call.path])).toEqual([["GET", "/workspace/profile"]])
})

test("explicit disposable selection and named promotion update the same profile, preserving files/session", async () => {
  const f = retentionFixture(), original = f.profile().profileID
  const disposable = await handleSlackWorkspaceCommand("workspace", "disposable One-off analysis", f.service)
  expect(disposable).toContain("Recovery checkpoints remain in use until explicit")
  expect(disposable).toContain("going idle does not discard")
  expect(f.profile()).toMatchObject({ profileID: original, retention: "disposable", name: "One-off analysis" })
  const persistent = await handleSlackWorkspaceCommand("workspace", "persistent Research notes", f.service)
  expect(persistent).toContain("Existing files and session state were preserved")
  expect(f.profile()).toMatchObject({ profileID: original, retention: "persistent", name: "Research notes" })
  expect(f.calls.filter(call => call.method === "PUT").map(call => call.body)).toEqual([
    { expectedProfileID: original, expectedRevision: 1, retention: "disposable", name: "One-off analysis" },
    { expectedProfileID: original, expectedRevision: 2, retention: "persistent", name: "Research notes" },
  ])
  expect(f.calls.some(call => call.path === "/workspace/discard")).toBe(false)
})

test("discard is explicit and persistent work cannot be discarded implicitly", async () => {
  const f = retentionFixture()
  expect(await handleSlackWorkspaceCommand("workspace", "discard", f.service)).toContain("explicitly mark it disposable first")
  expect(f.calls.map(call => call.method)).toEqual(["GET", "GET", "POST"])
  for (const args of ["temporary", "discard now", "delete", "persistent " + "x".repeat(81), "disposable bad\nname"]) {
    const before = f.calls.length
    await handleSlackWorkspaceCommand("workspace", args, f.service)
    expect(f.calls).toHaveLength(before)
  }
})

test("old completed discard is looked up before current profile and never targets successor work", async () => {
  const f = retentionFixture()
  await handleSlackWorkspaceCommand("workspace", "disposable scratch", f.service)
  const first = await handleSlackWorkspaceCommand("workspace", "discard", f.service)
  expect(first).toContain("Disposable workspace discarded")
  const successor = { ...f.profile() }, before = f.calls.length
  const replay = await handleSlackWorkspaceCommand("workspace", "discard", f.service)
  expect(replay).toContain("Previously completed discard")
  expect(replay).toContain("No new workspace was discarded")
  expect(f.profile()).toEqual(successor)
  expect(f.calls.slice(before).map(call => [call.method, call.path])).toEqual([["GET", "/workspace/discard"]])
})

test("pending same-event discard retries only its frozen tuple without consulting current profile", async () => {
  const f = retentionFixture()
  await handleSlackWorkspaceCommand("workspace", "disposable scratch", f.service)
  const profile = f.profile()
  f.records.set(f.requestID, { schemaVersion: 1, requestID: f.requestID, expectedProfileID: profile.profileID, expectedRevision: profile.revision, status: "pending", createdAt: 1, completedAt: null })
  const before = f.calls.length
  await handleSlackWorkspaceCommand("workspace", "discard", f.service)
  expect(f.calls.slice(before).map(call => [call.method, call.path])).toEqual([["GET", "/workspace/discard"], ["POST", "/workspace/discard"]])
  expect(f.calls.at(-1)?.body).toEqual({ requestID: f.requestID, expectedProfileID: profile.profileID, expectedRevision: profile.revision })
})

test("discard event IDs are deterministic, conversation-scoped UUIDs and unavailable state never triggers cleanup", async () => {
  const a = await slackWorkspaceDiscardRequestID("C1:100.1", "Ev1")
  expect(a).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
  expect(await slackWorkspaceDiscardRequestID("C1:100.1", "Ev1")).toBe(a)
  expect(await slackWorkspaceDiscardRequestID("C1:100.1", "Ev2")).not.toBe(a)
  expect(await slackWorkspaceDiscardRequestID("C2:100.1", "Ev1")).not.toBe(a)
  const f = retentionFixture(); f.unavailable()
  const text = await handleSlackWorkspaceCommand("workspace", "discard", f.service)
  expect(text).toContain("could not be verified")
  expect(text).not.toContain("SECRET")
  expect(f.calls.map(call => call.method)).toEqual(["GET"])
})

test("a new discard retry aliases the pending frozen tuple and its replay never reads successor state", async () => {
  const requestID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", canonicalID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
  const expectedProfileID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", calls: string[] = []
  const pending = { schemaVersion: 1, requestID: canonicalID, expectedProfileID, expectedRevision: 3, status: "pending", createdAt: 1, completedAt: null }
  let completed = false
  const service = { ...fixture().service, discardRequestID: async () => requestID, workspace: async (request: Request) => {
    const url = new URL(request.url); calls.push(request.method + " " + url.pathname + url.search)
    if (request.method === "POST") {
      expect(await request.json()).toEqual({ requestID, expectedProfileID, expectedRevision: 3 })
      completed = true
      return Response.json({ discard: { ...pending, requestID, status: "complete", completedAt: 2 } })
    }
    if (url.search) return Response.json({ discard: completed ? { ...pending, requestID, status: "complete", completedAt: 2 } : null })
    if (url.pathname === "/workspace/discard") return Response.json({ discard: pending })
    return Response.json({ workspace: { schemaVersion: 1, profileID: expectedProfileID, revision: 4, retention: "disposable", name: "Scratch", status: "discarding" } })
  } }
  expect(await handleSlackWorkspaceCommand("workspace", "discard", service)).toContain("Disposable workspace discarded")
  expect(calls).toEqual(["GET /workspace/discard?requestID=" + requestID, "GET /workspace/profile", "GET /workspace/discard", "POST /workspace/discard"])
  calls.length = 0
  expect(await handleSlackWorkspaceCommand("workspace", "discard", service)).toContain("Previously completed discard")
  expect(calls).toEqual(["GET /workspace/discard?requestID=" + requestID])
})


test("a previously refused discard keeps its prepared tuple and cannot refreeze successor disposable work", async () => {
  const f = retentionFixture(), original = { ...f.profile() }
  expect(await handleSlackWorkspaceCommand("workspace", "discard", f.service)).toContain("persistent")
  expect(f.records.get(f.requestID)).toMatchObject({ status: "prepared", expectedProfileID: original.profileID, expectedRevision: original.revision })
  Object.assign(f.profile(), { profileID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", revision: 7, retention: "disposable", name: "New work" })
  const successor = { ...f.profile() }, before = f.calls.length
  expect(await handleSlackWorkspaceCommand("workspace", "discard", f.service)).toContain("not confirmed")
  expect(f.calls.slice(before).map(call => [call.method, call.path])).toEqual([["GET", "/workspace/discard"], ["POST", "/workspace/discard"]])
  expect(f.calls.at(-1)?.body).toEqual({ requestID: f.requestID, expectedProfileID: original.profileID, expectedRevision: original.revision })
  expect(f.profile()).toEqual(successor)
})
