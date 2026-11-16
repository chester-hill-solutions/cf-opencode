import { beforeEach, describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { ConversationStore } from "../src/state"
import type { Conversation } from "../src/conversation"
import type { ConversationSlackAdapter } from "../src/conversation/slack-adapter"
import type { SlackEventRequest } from "../src/conversation/requests"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"
import { parseWorkspaceProfile } from "../src/workspace-profile"
import type { WorkspaceRepositoryBinding } from "../src/workspace-repository"

const CHANNEL = "C_ARFIN_TEST_FIXTURE"
function slackEvent(text: string, id: string, options: { dm?: boolean; followUp?: boolean } = {}): SlackEventRequest {
  return { eventID: id, replyTs: "100.1", event: { type: options.followUp ? "message" : "app_mention", channel: CHANNEL,
    channel_type: options.dm ? "im" : "channel", ts: id, text, ...(options.followUp ? { thread_ts: "100.1" } : {}) } }
}
function send(instance: Conversation, input: SlackEventRequest) {
  return instance.fetch(new Request("https://conversation/slack", { method: "POST", body: JSON.stringify(input) }))
}
function fixture(instance: Conversation) {
  const replies: string[] = [], calls: string[] = [], prompts: string[] = [], configured: Record<string, unknown>[] = []
  const adapter: ConversationSlackAdapter = Reflect.get(instance, "slackAdapter")
  adapter.postChunked = async (_channel, text) => { replies.push(text) }
  adapter.slack = async () => ({ ok: true, messages: [] })
  Reflect.set(Reflect.get(instance, "env"), "CHECK_SLACK_CHANNEL_ID", CHANNEL)
  let binding: WorkspaceRepositoryBinding | undefined
  instance.transport = port => ({ async fetch(input: Request | string | URL, init?: RequestInit) {
    const request = input instanceof Request ? input : new Request(input, init)
    const path = new URL(request.url).pathname
    calls.push(`${port} ${request.method} ${path}`)
    if (path === "/status") return Response.json({ initialized: true })
    if (path === "/configure") {
      const body = await request.json() as Record<string, unknown>
      configured.push(body); binding = body.workspaceRepository as WorkspaceRepositoryBinding
      return Response.json({ ok: true })
    }
    if (path === "/start") return Response.json({ ...accountingPolicyStart, workspaceRepository: { ...binding, status: "bound", baseCommit: "a".repeat(40) } })
    if (path === "/api/config") return Response.json(accountingPolicyConfig)
    if (path === "/api/session" && request.method === "POST") return Response.json({ data: { id: "ses_bound_slack" } })
    if (path.endsWith("/context")) return Response.json({ data: [] })
    if (path.endsWith("/switch-model")) return new Response(null, { status: 204 })
    if (path.endsWith("/prompt")) {
      const body = await request.json() as { text?: string }
      if (body.text) prompts.push(body.text)
      return Response.json({ data: {} })
    }
    if (path.includes("/api/session/")) return Response.json({ data: {} })
    return Response.json({ error: "unexpected synthetic operation" }, { status: 404 })
  } })
  return { replies, calls, configured, prompts }
}

async function defaultRepository(workspaceRepo: string) {
  // Reflect the canary's empty environment default without using the URL-only settings editor.
  await runInDurableObject(env.SETTINGS.getByName("global"), async (_instance, state) => {
    const settings = await state.storage.get<Record<string, unknown>>("settings")
    await state.storage.put("settings", { ...settings, workspaceRepo })
  })
}

beforeEach(async () => {
  await runInDurableObject(env.SETTINGS.getByName("global"), async (_instance, state) => state.storage.deleteAll())
  await env.SETTINGS.getByName("global").fetch("https://settings/put", { method: "POST", body: JSON.stringify({ streaming: false, dailyBudgetUSD: 0 }) })
})

describe("Slack repository controls reuse the guarded binding core", () => {
  it("admits a fresh general-workspace prompt with truthful context and safe duplicate delivery", async () => {
    await defaultRepository("  ")
    await runInDurableObject(env.CONVERSATION.getByName("slack-general-workspace"), async (instance, state) => {
      const f = fixture(instance), store = new ConversationStore(state.storage)
      const input = slackEvent("Pick up an easier task", "general-work")
      expect(await (await send(instance, input)).json()).not.toMatchObject({ repositoryRequired: true })
      expect(f.calls.length).toBeGreaterThan(0)
      const current = await store.get(), prompt = f.prompts[0] ?? current.queue?.[0]?.text
      expect(prompt).toContain("/workspace is this conversation's general workspace")
      expect(prompt).toContain("existing files or checkouts may still be present")
      expect(prompt).toContain("Do not blindly search other filesystem roots")
      expect(prompt).toContain("separate subdirectory unless the user chose an existing checkout")
      expect(prompt).toContain("Copy only requested work, excluding workspace/runtime metadata")
      expect(prompt).toContain("preserve originals and report conflicts before overwriting")
      expect(prompt).toContain("does not register a conversation repository binding or establish credential access")
      expect(prompt).toContain("Push or publish only when the user instructs it")
      expect(prompt).toContain("Pick up an easier task")
      expect(current.workspaceRepository).toBeUndefined()
      expect(current.slackControlHistory).toBeUndefined()
      const count = f.calls.length, queued = current.queue?.length
      await send(instance, input)
      expect(f.calls).toHaveLength(count)
      expect((await store.get()).queue?.length).toBe(queued)
    })
  })

  it("continues an existing unbound workspace without forcing a new task or laundering its history", async () => {
    await defaultRepository("")
    await runInDurableObject(env.CONVERSATION.getByName("slack-general-existing"), async (instance, state) => {
      const f = fixture(instance), store = new ConversationStore(state.storage)
      await state.storage.put("state", { phase: "idle", seen: ["prior-work"], pending: {}, sessionID: "prior-session", containerStarts: 1 })
      expect(await (await send(instance, slackEvent("Continue working", "general-follow-up"))).json()).not.toMatchObject({ repositoryRequired: true })
      expect(f.calls.length).toBeGreaterThan(0)
      expect(f.replies.every(reply => !reply.includes("Start a new Slack thread"))).toBe(true)
      expect((await store.get()).sessionID).toBe("prior-session")
      expect((await store.get()).slackControlHistory).toBeUndefined()
    })
  })

  it("keeps normal admission for default repositories and channels without the binding feature", async () => {
    for (const mode of ["default", "disabled"] as const) {
      await defaultRepository(mode === "default" ? "https://github.com/example/default" : "")
      await runInDurableObject(env.CONVERSATION.getByName("slack-repo-guard-" + mode), async (instance, state) => {
        const f = fixture(instance)
        if (mode === "disabled") Reflect.set(Reflect.get(instance, "env"), "CHECK_SLACK_CHANNEL_ID", "OTHER_CHANNEL")
        const response = await send(instance, slackEvent("Work in the existing workspace", "normal-" + mode))
        expect(await response.json()).not.toMatchObject({ repositoryRequired: true })
        expect(f.calls.length).toBeGreaterThan(0)
        const current = await new ConversationStore(state.storage).get()
        const prompt = f.prompts[0] ?? current.queue?.[0]?.text ?? ""
        if (mode === "default") expect(prompt).not.toContain("No repository is configured")
        if (mode === "default") expect(prompt).toContain("Workspace retention is explicitly persistent")
        // The brief no longer depends on the check-channel feature gate: every
        // session is told where it works, even where !repo is unavailable.
        else expect(prompt).toContain("/workspace is this conversation's general workspace")
      })
    }
  })

  it("names and promotes a workspace in place before optional fresh repository selection", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("slack-retention-before-repo"), async (instance, state) => {
      const f = fixture(instance), store = new ConversationStore(state.storage)
      const profile = async () => {
        const response = await instance.fetch(new Request("https://conversation/workspace/profile"))
        const value = await response.json() as { workspace: unknown }
        return parseWorkspaceProfile(value.workspace)
      }
      const original = await profile()
      expect(original.retention).toBe("persistent")
      await send(instance, slackEvent("!workspace disposable Scratch", "workspace-scratch"))
      expect(await profile()).toMatchObject({ profileID: original.profileID, retention: "disposable", name: "Scratch" })
      await send(instance, slackEvent("!workspace persistent Research notes", "workspace-keep", { followUp: true }))
      expect(await profile()).toMatchObject({ profileID: original.profileID, retention: "persistent", name: "Research notes" })
      expect((await store.get()).sessionID).toBeUndefined()
      expect(f.calls).toEqual([])
      await send(instance, slackEvent("!repo https://github.com/example/selected main task/retained", "repo-after-profile", { followUp: true }))
      expect((await store.get()).workspaceRepository).toMatchObject({ repository: "https://github.com/example/selected", status: "pending" })
      expect(f.calls).toEqual([])
    })
  })

  it("never reapplies an old workspace event after a failed service read and successor cleanup", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("slack-workspace-intake-replay"), async (instance, state) => {
      const f = fixture(instance), store = new ConversationStore(state.storage)
      const lifecycle: { fetch(request: Request): Promise<Response> } = Reflect.get(instance, "workspaceLifecycle")
      const original = lifecycle.fetch.bind(lifecycle), callbacks: string[] = []
      let fail = true
      lifecycle.fetch = async request => {
        callbacks.push(request.method + " " + new URL(request.url).pathname)
        if (fail && request.method === "GET" && new URL(request.url).pathname === "/workspace/discard") { fail = false; return Response.json({ error: "synthetic unavailable" }, { status: 503 }) }
        return original(request)
      }
      const oldEvent = slackEvent("!workspace discard", "workspace-read-failed")
      await send(instance, oldEvent)
      expect(f.replies.at(-1)).toContain("could not be verified")
      const get = async () => {
        const response = await instance.fetch(new Request("https://conversation/workspace/profile"))
        return parseWorkspaceProfile((await response.json() as { workspace: unknown }).workspace)
      }
      const setDisposable = async (name: string) => {
        const current = await get()
        const response = await instance.fetch(new Request("https://conversation/workspace/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedProfileID: current.profileID, expectedRevision: current.revision, retention: "disposable", name }) }))
        expect(response.status).toBe(200)
        return parseWorkspaceProfile((await response.json() as { workspace: unknown }).workspace)
      }
      const before = await setDisposable("Old workspace")
      const discarded = await instance.fetch(new Request("https://conversation/workspace/discard", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", expectedProfileID: before.profileID, expectedRevision: before.revision }) }))
      expect(discarded.status).toBe(200)
      expect((await store.get()).seen).not.toContain("workspace-read-failed")
      const successor = await setDisposable("New work")
      expect(successor.profileID).not.toBe(before.profileID)
      const count = callbacks.length, replyCount = f.replies.length
      await send(instance, oldEvent)
      expect(callbacks).toHaveLength(count)
      expect(f.replies).toHaveLength(replyCount)
      expect(await get()).toEqual(successor)
    })
  })

  it("permits fresh help, malformed repo correction, selection and duplicate delivery before any runtime or prompt", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("slack-repo-fresh-fixture"), async (instance, state) => {
      const f = fixture(instance), store = new ConversationStore(state.storage)
      await send(instance, slackEvent("!help", "help"))
      await send(instance, slackEvent("!repo https://github.com/o/r --bad task", "bad"))
      expect((await store.get()).workspaceRepository).toBeUndefined()
      await send(instance, slackEvent("!repo <https://github.com/Example/Selected.git|Selected repo> main task/example", "select"))
      const selected = (await store.get()).workspaceRepository
      expect(selected).toMatchObject({ repository: "https://github.com/example/selected", baseBranch: "main", workingBranch: "task/example", status: "pending" })
      expect(f.calls).toEqual([])
      const replies = f.replies.length
      await send(instance, slackEvent("!repo <https://github.com/Example/Selected.git|Selected repo> main task/example", "select"))
      expect(f.replies).toHaveLength(replies)
      expect((await store.get()).workspaceRepository).toEqual(selected)
      await send(instance, slackEvent("!repo https://github.com/other/repo main task/other", "conflict"))
      expect(f.replies.at(-1)).toContain("preserv")
      expect((await store.get()).workspaceRepository).toEqual(selected)
      expect(f.calls).toEqual([])
      expect(await state.storage.getAlarm()).toBeNull()
    })
  })

  it("normal follow-up uses the actual bound repository despite changed global defaults", async () => {
    await runInDurableObject(env.CONVERSATION.getByName("slack-repo-prompt-fixture"), async (instance, state) => {
      const f = fixture(instance), store = new ConversationStore(state.storage)
      await send(instance, slackEvent("!repo https://github.com/example/selected main task/example", "select"))
      expect(f.calls).toEqual([])
      await env.SETTINGS.getByName("global").fetch("https://settings/put", { method: "POST", body: JSON.stringify({ workspaceRepo: "https://github.com/other/default", workspaceBranch: "other" }) })
      await send(instance, slackEvent("Fix the public fixture", "work", { followUp: true }))
      expect(f.configured[0]).toMatchObject({ workspaceRepository: { repository: "https://github.com/example/selected", baseBranch: "main", workingBranch: "task/example" } })
      expect((await store.get()).workspaceRepository).toMatchObject({ status: "bound", baseCommit: "a".repeat(40) })
      expect(f.calls.some(call => call.includes("POST /api/session/"))).toBe(true)
      expect((await store.get()).slackControlHistory).toBeUndefined()
    })
  })

  it("old DM history and numeric tombstones remain unadoptable, including after new-session control", async () => {
    for (const old of ["seen", "tombstone"] as const) {
      await runInDurableObject(env.CONVERSATION.getByName("slack-repo-legacy-" + old), async (instance, state) => {
        const f = fixture(instance), store = new ConversationStore(state.storage)
        if (old === "seen") await state.storage.put("state", { seen: ["accepted-legacy"], pending: {} })
        else await store.markTombstone("legacy-accepted")
        await send(instance, slackEvent("!help", "help", { dm: true }))
        await send(instance, slackEvent("!repo https://github.com/example/selected main task/example", "select", { dm: true }))
        expect((await store.get()).workspaceRepository).toBeUndefined()
        expect(f.replies.at(-1)).toContain("preserv")
        await send(instance, slackEvent("!new", "new", { dm: true }))
        await send(instance, slackEvent("!repo https://github.com/example/selected main task/example", "after-new", { dm: true }))
        expect((await store.get()).workspaceRepository).toBeUndefined()
        expect(f.calls).toEqual([])
      })
    }
  })
})
