import { describe, expect, test } from "vitest"
import { ConversationSlackAdapter, type ConversationSlackAdapterOptions } from "../src/conversation/slack-adapter"
import type { SlackEventRequest } from "../src/conversation/requests"
import { slackWorkspaceDiscardRequestID } from "../src/slack-workspace-commands"
import type { TurnObservation } from "../src/turn-observation"

const observation: TurnObservation = {
  policy: "observe_and_alert", thresholdMs: 600_000, executionDeadlineEnforced: false,
  runStartedAt: 1, elapsedMs: 600_001, overdue: true, timeoutObserved: false,
  timeoutObservedAt: null, settlement: "active",
}

/** The warm client surface these command tests read. */
type WarmClient = {
  session: { get(args: { sessionID: string }): Promise<{ id: string; title: string }>; list(): Promise<{ data: unknown[] }> }
  model: { list(): Promise<{ data: unknown[] }> }
}

function fixture(overrides: Record<string, unknown> = {}) {
  const calls: Array<[string, ...unknown[]]> = []
  const replies: string[] = []
  let state: Record<string, unknown> = { phase: "idle", queue: [] }
  const options = {
    store: {
      get: async () => state,
      patch: async (value: Record<string, unknown>) => { state = { ...state, ...value } },
      advance: async () => {}, claimEvent: async (id: string, command?: string) => { calls.push(["claimEvent", id, command]); return true },
      releaseEvent: async (id: string) => { calls.push(["releaseEvent", id]) },
      markTombstone: async (id: string, command?: string) => { calls.push(["markTombstone", id, command]) },
    },
    sessions: { ensure: async () => "session-1", baseline: async () => "baseline" },
    admissions: {
      withLock: async (fn: () => Promise<unknown>) => fn(), claim: async () => true,
      enqueue: async () => ({ kind: "queue_full", depth: 5, limit: 5 }),
      finishLocal: () => {}, resumeDispatched: async () => {}, recordAccepted: async () => {},
      active: false,
    },
    budget: {
      acquire: async () => ({ kind: "granted", reservation: { reservationID: "r1", date: "2026-11-14" } }),
      markDispatched: async () => true,
    },
    controlPlane: { pendingForms: async () => [], pendingFormsWarm: async () => [], replyToForm: async () => {} },
    upgrades: { hasPending: async () => false }, turnExecution: { isPumping: false, startStream: async () => {} },
    controls: {
      steer: async (text: string) => { calls.push(["steer", text]); return "Guidance added." },
      stop: async (text?: string, target?: { channel: string; replyTs?: string }) => { calls.push(["stop", text, target]); return "Stop handled." },
    },
    observation: async () => observation,
    scheduler: { schedule: async () => {} }, recovery: { active: false },
    withClient: async (fn: (client: any) => Promise<unknown>) => fn({ session: { prompt: async (args: unknown) => { calls.push(["prompt", args]) } } }),
    runtimeWarm: () => true,
    withWarmClient: async (fn: (client: WarmClient) => Promise<unknown>) => fn({
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, title: "Warm", location: { directory: "/workspace" } }),
        list: async () => ({ data: [] }),
      },
      model: { list: async () => ({ data: [] }) },
    }),
    withUsageLifecycle: async (fn: () => Promise<Response>) => fn(),
    settings: async () => ({ model: "provider/model", streaming: false }),
    usageToday: async () => ({ date: "2026-11-14", costUSD: 0, reservedUSD: 0, input: 0, output: 0 }),
    deliver: async () => {}, waitUntil: () => {}, conversationKey: () => "conversation",
    env: () => ({}),
    ...overrides,
  } as unknown as ConversationSlackAdapterOptions
  const adapter = new ConversationSlackAdapter(options)
  adapter.postChunked = async (_channel, text) => { replies.push(text) }
  return { adapter, options, calls, replies, getState: () => state, setState: (next: Record<string, unknown>) => { state = next } }
}

function event(text: string, eventID = "event-1"): SlackEventRequest {
  return { eventID, event: { type: "app_mention", channel: "C1", ts: "1.0", text, channel_type: "channel" } }
}

describe("ConversationSlackAdapter delivery controls", () => {
  test("workspace controls use channel gates, typed benign claims and stable event identity without prompt dispatch", async () => {
    const workspace: Array<unknown[]> = []
    const f = fixture({ workspaceCommands: {
      enabled: (target: { channel: string }) => target.channel === "C1",
      repository: async (request: Request) => { workspace.push([request.method]); return Response.json({ workspaceRepository: null }) },
      check: async (argv: string[], target: unknown, eventID: unknown) => { workspace.push([argv, target, eventID]); return "Check requested." },
      checks: async () => "No checks.",
    } })
    await f.adapter.onEvent(event("!repo", "repo-event"))
    await f.adapter.onEvent({ event: { type: "app_mention", channel: "C1", ts: "123.4", text: '!check ["bun","test"]' } })
    expect(f.calls).toContainEqual(["claimEvent", "repo-event", "repo"])
    expect(f.calls).toContainEqual(["markTombstone", "repo-event", "repo"])
    expect(workspace).toContainEqual([["bun", "test"], { channel: "C1" }, "slack:C1:123.4"])
    expect(f.calls.some(([name]) => name === "prompt")).toBe(false)
    const before = workspace.length
    await f.adapter.handleControl("!repo", event("!repo"), { channel: "OTHER" })
    expect(workspace).toHaveLength(before)
    expect(f.replies.at(-1)).toContain("unavailable")
  })
  test("routes steer and stop commands to shared controls and includes turn observation in status", async () => {
    const f = fixture()
    const input = { event: { type: "app_mention", channel: "C1", ts: "1.0", text: "!steer be concise", channel_type: "channel" } } as SlackEventRequest
    await f.adapter.handleControl("!steer be concise", input, { channel: "C1" })
    await f.adapter.handleControl("!stop next", { ...input, event: { ...input.event, text: "!stop next" } }, { channel: "C1", replyTs: "2.0" })
    await f.adapter.handleControl("!status", { ...input, event: { ...input.event, text: "!status" } }, { channel: "C1" })
    expect(f.calls).toContainEqual(["steer", "be concise"])
    expect(f.calls).toContainEqual(["stop", "next", { channel: "C1", replyTs: "2.0" }])
    expect(f.replies.at(-1)).toContain("observation threshold")
    expect(f.replies.at(-1)).toContain("not automatically stopped")
  })

  test("puts soul, then team, then user memory ahead of the message as quoted data", async () => {
    const f = fixture({ memory: {
      context: async () => ({
        team: [{ id: "t1", text: "we use bun and stow", at: 1 }],
        user: [{ id: "u1", text: "prefers terse replies", at: 2 }],
      }),
      remember: async () => ({ ok: false as const, error: "unused" }),
      forget: async () => ({ ok: false as const, error: "unused" }),
    } })
    await f.adapter.onEvent(event("hello"))
    const prompt = String((f.calls.find(([name]) => name === "prompt")?.[1] as { text?: string } | undefined)?.text ?? "")

    const soul = prompt.indexOf("<soul>")
    const team = prompt.indexOf('<memory scope="team">')
    const user = prompt.indexOf('<memory scope="user">')
    const message = prompt.indexOf("hello")
    expect(soul).toBe(0)
    expect(team).toBeGreaterThan(soul)
    expect(user).toBeGreaterThan(team)
    expect(message).toBeGreaterThan(user)
    expect(prompt).toContain("- we use bun and stow")
    expect(prompt).toContain("- prefers terse replies")
    expect(prompt).toContain("not instructions")
  })

  test("sends the workspace brief even where the check-channel commands are disabled", async () => {
    const f = fixture({
      settings: async () => ({ model: "provider/model", streaming: false, workspaceRepo: "https://github.com/example/repo" }),
      workspaceCommands: {
        enabled: () => false,
        repository: async () => Response.json({ workspaceRepository: null }),
        check: async () => "",
        checks: async () => "",
      },
    })
    await f.adapter.onEvent(event("hello"))
    const prompt = String((f.calls.find(([name]) => name === "prompt")?.[1] as { text?: string } | undefined)?.text ?? "")
    expect(prompt).toContain("<workspace_context>")
    // Capability is stated, not discovered: no installs, no credential hunt, no root crawl.
    expect(prompt).toContain("do not install packages to work around a missing tool")
    expect(prompt).toContain("do not hunt for tokens")
    expect(prompt).toContain("say so in your first reply")
    expect(prompt).toContain("/workspace is this conversation's working directory")
    expect(prompt.indexOf("<soul>")).toBeLessThan(prompt.indexOf("<workspace_context>"))
    expect(prompt.indexOf("<workspace_context>")).toBeLessThan(prompt.indexOf("hello"))
  })

  test("sends no memory block when nothing is remembered", async () => {
    const f = fixture({ memory: {
      context: async () => ({ team: [], user: [] }),
      remember: async () => ({ ok: false as const, error: "unused" }),
      forget: async () => ({ ok: false as const, error: "unused" }),
    } })
    await f.adapter.onEvent(event("hello"))
    const prompt = String((f.calls.find(([name]) => name === "prompt")?.[1] as { text?: string } | undefined)?.text ?? "")
    expect(prompt).toContain("<soul>")
    expect(prompt).not.toContain("<memory")
    expect(prompt).toContain("hello")
  })

  test("a memory outage leaves the turn's prompt untouched", async () => {
    const f = fixture({ memory: {
      context: async () => { throw new Error("settings unavailable") },
      remember: async () => ({ ok: false as const, error: "unused" }),
      forget: async () => ({ ok: false as const, error: "unused" }),
    } })
    await f.adapter.onEvent(event("hello"))
    const prompt = String((f.calls.find(([name]) => name === "prompt")?.[1] as { text?: string } | undefined)?.text ?? "")
    expect(prompt).toContain("hello")
    expect(prompt).not.toContain("<soul>")
  })

  test("explicitly queues the mainline Slack prompt", async () => {
    const f = fixture()
    await f.adapter.onEvent(event("hello"))
    expect(f.calls.find(([name]) => name === "prompt")?.[1]).toMatchObject({ delivery: "queue", sessionID: "session-1", text: "hello" })
  })

  test("returns typed queue failure and releases the claimed event when full", async () => {
    const f = fixture({ admissions: {
      withLock: async (fn: () => Promise<unknown>) => fn(), claim: async () => false,
      enqueue: async () => ({ kind: "queue_full", depth: 5, limit: 5 }), finishLocal: () => {},
      resumeDispatched: async () => {}, recordAccepted: async () => {}, active: false,
    } })
    const response = await f.adapter.onEvent(event("hello"))
    expect(await response.json()).toMatchObject({ queued: false, queueResult: { kind: "queue_full", depth: 5, limit: 5 } })
    expect(f.calls).toContainEqual(["releaseEvent", "event-1"])
    expect(f.replies[0]).toContain("queue is full (5/5)")
  })

  test("clears a failed startup admission before retrying through the FIFO queue", async () => {
    let enqueuePhase: unknown
    let optionsRef: ConversationSlackAdapterOptions
    const f = fixture({
      sessions: { ensure: async () => { throw new Error("container start failed") }, baseline: async () => undefined },
      admissions: {
        withLock: async (fn: () => Promise<unknown>) => fn(),
        claim: async () => true,
        enqueue: async () => {
          enqueuePhase = (await optionsRef.store.get()).phase
          return { kind: "enqueued", id: "q1", position: 1, depth: 1, limit: 5 }
        },
        finishLocal: () => {}, resumeDispatched: async () => {}, recordAccepted: async () => {}, active: false,
      },
    })
    optionsRef = f.options
    f.setState({ phase: "admitting", admissionID: "admission-1", admissionStartedAt: 10, queue: [] })
    const response = await f.adapter.onEvent(event("hello"))
    expect(enqueuePhase).toBe("idle")
    expect(f.getState()).toMatchObject({ phase: "idle", admissionID: undefined, admissionStartedAt: undefined })
    expect(await response.json()).toMatchObject({ queued: true, queueResult: { kind: "enqueued", position: 1 } })
  })
})


describe("Slack workspace retention controls", () => {
  const profile = { schemaVersion: 1, profileID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", revision: 1, retention: "disposable", name: "Scratch", status: "active" }
  test("workspace commands carry benign provenance and a stable event-derived discard identity", async () => {
    const requests: string[] = []
    const f = fixture({ workspaceCommands: {
      enabled: () => true, repository: async () => Response.json({ workspaceRepository: null }), check: async () => "", checks: async () => "",
      workspace: async (request: Request) => {
        requests.push(request.url)
        const id = new URL(request.url).searchParams.get("requestID")
        return Response.json({ discard: { schemaVersion: 1, requestID: id, expectedProfileID: profile.profileID, expectedRevision: 1, status: "complete", createdAt: 1, completedAt: 2 } })
      },
    } })
    await f.adapter.onEvent(event("!workspace discard", "discard-event"))
    expect(f.calls).toContainEqual(["claimEvent", "discard-event", "workspace"])
    expect(f.calls).toContainEqual(["markTombstone", "discard-event", "workspace"])
    expect(requests).toEqual(["https://conversation/workspace/discard?requestID=" + await slackWorkspaceDiscardRequestID("conversation", "discard-event")])
    expect(f.calls.some(([name]) => name === "prompt")).toBe(false)
    expect(f.replies[0]).toContain("No new workspace was discarded")
  })

  test("general prompts know retention and permanent repo-free work; temporary wording has no cleanup effect", async () => {
    const methods: string[] = []
    const f = fixture({ settings: async () => ({ workspaceRepo: "", model: "provider/model", streaming: false }), workspaceCommands: {
      enabled: () => true, repository: async () => Response.json({ workspaceRepository: null }), check: async () => "", checks: async () => "",
      workspace: async (request: Request) => { methods.push(request.method); return Response.json({ workspace: profile }) },
    } })
    await f.adapter.onEvent(event("Do some temporary analysis", "general-profile-event"))
    expect(f.calls.find(([name]) => name === "prompt")?.[1]).toMatchObject({ text: expect.stringContaining("Workspace retention is explicitly disposable") })
    expect(f.calls.find(([name]) => name === "prompt")?.[1]).toMatchObject({ text: expect.stringContaining("remain repository-free permanently") })
    expect(f.calls.find(([name]) => name === "prompt")?.[1]).toMatchObject({ text: expect.stringContaining("words such as temporary do not authorize disposal") })
    expect(methods).toEqual(["GET"])
  })
})
