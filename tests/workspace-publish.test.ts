import { afterEach, describe, expect, test } from "bun:test"
import { workspacePublishRoute, type WorkspacePublishDeps } from "../src/conversation/workspace-publish"
import type { ConversationState } from "../src/state"

const repository = "https://github.com/chester-hill-solutions/callcaster"
const baseCommit = "a".repeat(40)
const headCommit = "b".repeat(40)
const requestID = "11111111-1111-4111-8111-111111111111"
const token = `gho_${"a".repeat(36)}`
const binding = {
  schemaVersion: 1 as const,
  bindingID: "22222222-2222-4222-8222-222222222222",
  repository,
  baseBranch: "master",
  workingBranch: "aboiteau/task",
  status: "bound" as const,
  baseCommit,
}

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

function githubPull(number = 5): typeof fetch {
  return (async () => Response.json([{ number, html_url: `https://github.com/o/r/pull/${number}`, draft: true }])) as unknown as typeof fetch
}

function deps(overrides: Partial<WorkspacePublishDeps> = {}) {
  const store = new Map<string, unknown>()
  const calls = { control: 0, fetch: 0 }
  const value: WorkspacePublishDeps = {
    state: async () => ({ phase: "idle", workspaceRepository: binding }) as unknown as ConversationState,
    storage: {
      get: async <T>(key: string) => store.get(key) as T | undefined,
      put: async (key: string, entry: unknown) => { store.set(key, entry) },
    },
    withLock: (task) => task(),
    idle: async () => true,
    warm: () => true,
    useWarm: (task) => task(),
    control: () => ({
      fetch: async () => {
        calls.control++
        return Response.json({ commit: headCommit, pushed: true })
      },
    }),
    token: async () => token,
    now: () => 1_700_000_000_000,
    ...overrides,
  }
  return { value, store, calls }
}

function publish(body: unknown = { requestID }): Request {
  return new Request("https://conversation/workspace/publish", { method: "POST", body: JSON.stringify(body) })
}

describe("workspace publish route", () => {
  test("pushes, opens a draft, and records the receipt", async () => {
    globalThis.fetch = githubPull(5)
    const { value, store } = deps()
    const response = await workspacePublishRoute(publish(), value)
    expect(response.status).toBe(200)
    const body = await response.json() as { publication: { pullRequest: { number: number; url: string; draft: boolean }; commit: string; requestID: string } }
    expect(body.publication.pullRequest).toEqual({ number: 5, url: "https://github.com/o/r/pull/5", draft: true })
    expect(body.publication.commit).toBe(headCommit)
    expect(store.get("workspacePublication")).toMatchObject({ requestID, commit: headCommit })
  })

  test("a retry with the same request ID returns the first receipt and touches nothing", async () => {
    globalThis.fetch = githubPull(5)
    const { value, calls } = deps()
    const first = await (await workspacePublishRoute(publish(), value)).json()
    const second = await (await workspacePublishRoute(publish(), value)).json()
    expect(second).toEqual(first)
    expect(calls.control).toBe(1)
  })

  test("refuses a busy workspace, an unbound one, and a publish with no commits", async () => {
    const busy = await workspacePublishRoute(publish(), deps({ idle: async () => false }).value)
    expect(busy.status).toBe(409)
    expect(await busy.json()).toMatchObject({ code: "WORKSPACE_BUSY" })

    const unbound = await workspacePublishRoute(publish(), deps({
      state: async () => ({ phase: "idle" }) as unknown as ConversationState,
    }).value)
    expect(unbound.status).toBe(409)
    expect(await unbound.json()).toMatchObject({ code: "WORKSPACE_NOT_BOUND" })

    const empty = await workspacePublishRoute(publish(), deps({
      control: () => ({ fetch: async () => Response.json({ commit: baseCommit, pushed: false }) }),
    }).value)
    expect(empty.status).toBe(409)
    expect(await empty.json()).toMatchObject({ code: "WORKSPACE_NOTHING_TO_PUBLISH" })
  })

  test("names a missing GitHub credential instead of publishing anonymously", async () => {
    const response = await workspacePublishRoute(publish(), deps({ token: async () => undefined }).value)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: "GITHUB_CREDENTIAL_UNAVAILABLE" })
  })

  test("reports a container that cannot push and a GitHub that refuses", async () => {
    const unreachable = await workspacePublishRoute(publish(), deps({
      control: () => ({ fetch: async () => { throw new Error("container gone") } }),
    }).value)
    expect(unreachable.status).toBe(503)

    globalThis.fetch = (async () => Response.json({ message: "no" }, 403)) as unknown as typeof fetch
    const refused = await workspacePublishRoute(publish(), deps().value)
    expect(refused.status).toBe(502)
    expect(await refused.json()).toMatchObject({ code: "GITHUB_UNAVAILABLE" })
  })

  test("rejects a malformed request before touching the workspace", async () => {
    const { value, calls } = deps()
    const response = await workspacePublishRoute(publish({ requestID: "nope" }), value)
    expect(response.status).toBe(400)
    expect(calls.control).toBe(0)
  })
})
