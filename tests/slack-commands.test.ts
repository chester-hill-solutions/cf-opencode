import { describe, expect, test } from "bun:test"
import { handleSlackCommand, type SlackCommandServices } from "../src/slack-commands"
import type { Form } from "../src/slack-forms"
import type { ModelSummary, SessionSummary } from "../src/slack-command-format"

const model: ModelSummary = { providerID: "opencode", id: "deepseek-v4.1-flash", type: "chat", enabled: true }
const session = (id: string, title = "Workspace session"): SessionSummary & { location: { directory: string } } => ({
  id, title, location: { directory: "/workspace" }, time: { updated: 10 },
})
const form: Form = {
  id: "form_1", title: "Choose a mode", fields: [
    { key: "mode", title: "Mode", type: "string", required: true, options: [
      { value: "fast", label: "Fast" }, { value: "careful", label: "Careful" },
    ] },
  ],
}

function fake(overrides: Partial<SlackCommandServices> = {}) {
  const replies: string[] = []
  const calls: Array<[string, ...unknown[]]> = []
  const service: SlackCommandServices = {
    getState: async () => ({ sessionID: "ses_current", phase: "running" }),
    runtime: () => ({ warm: true }),
    getDefaultModel: async () => "opencode/deepseek-v4.1-flash",
    getModels: async () => [model],
    getSession: async (id) => session(id),
    listSessions: async () => [session("ses_current"), session("ses_other")],
    switchModel: async (ref) => { calls.push(["switchModel", ref]) },
    selectSession: async (id) => { calls.push(["selectSession", id]) },
    newSession: async () => { calls.push(["newSession"]) },
    steer: async (text) => { calls.push(["steer", text]); return "🧭 Guidance added." },
    stop: async (...args) => { calls.push(["stop", ...args]); return "⏹️ Interrupted." },
    leave: async () => "👋 Stopped following this conversation.",
    listForms: async () => [form],
    answerForm: async (sessionID, formID, answer) => { calls.push(["answerForm", sessionID, formID, answer]) },
    cancelForm: async (sessionID, formID) => { calls.push(["cancelForm", sessionID, formID]) },
    usageText: async () => "Usage information",
    reply: async (text) => { replies.push(text) },
    setupUrl: "https://example.test/setup?token=never-in-chat",
    ...overrides,
  }
  return { service, replies, calls }
}

describe("handleSlackCommand", () => {
  test("returns false only for ordinary text", async () => {
    const { service } = fake()
    expect(await handleSlackCommand("hello there", service)).toBe(false)
  })

  test("handles help and !help. without querying usage", async () => {
    let usageCalls = 0
    const { service, replies } = fake({ usageText: async () => { usageCalls++; return "quota" } })
    expect(await handleSlackCommand("!help", service)).toBe(true)
    expect(await handleSlackCommand("!help.", service)).toBe(true)
    expect(replies[0]).toContain("!model")
    expect(replies[0]).toContain("follow-up replies")
    expect(replies[0]).toContain("!leave")
    expect(replies[0]).toContain("queue while a turn is active")
    expect(replies[0]).toContain("!steer <text>")
    expect(replies[0]).toContain("clear queued follow-ups")
    expect(replies[0]).toContain("!stop <text>")
    expect(replies[0]).toContain("Workspace first")
    expect(replies[0]).toContain("repository is optional")
    expect(replies[0]).toContain("nested agent checkouts are not eligible")
    expect(usageCalls).toBe(0)
  })

  test("unknown bang command is consumed and gets help", async () => {
    const { service, replies } = fake()
    expect(await handleSlackCommand("!provider-secret do this", service)).toBe(true)
    expect(replies[0]).toContain("!help")
  })

  test("setup/connect only posts the setup URL and never its token", async () => {
    const { service, replies } = fake()
    await handleSlackCommand("!connect", service)
    expect(replies[0]).toContain("https://example.test/setup")
    expect(replies[0]).not.toContain("token=")
    await handleSlackCommand("!setup", service)
    expect(replies[1]).not.toContain("token=")
  })

  test("model listing works without a session and does not depend on usage", async () => {
    const { service, replies } = fake({ getState: async () => ({}), usageText: async () => { throw new Error("quota") } })
    expect(await handleSlackCommand("!model", service)).toBe(true)
    expect(replies[0]).toContain("opencode/deepseek-v4.1-flash")
    expect(replies[0]).toContain("Current model")
  })

  test("model can be selected before the first prompt", async () => {
    const { service, replies, calls } = fake({ getState: async () => ({}) })
    await handleSlackCommand("!model opencode/deepseek-v4.1-flash#high", service)
    expect(calls).toContainEqual(["switchModel", "opencode/deepseek-v4.1-flash#high"])
    expect(replies[0]).toContain("now uses")
  })

  test("model ids may contain nested slashes and are matched against the live catalogue", async () => {
    const nested: ModelSummary = { providerID: "openrouter", id: "anthropic/claude-x", type: "chat", enabled: true }
    const { service, calls, replies } = fake({ getModels: async () => [nested] })
    await handleSlackCommand("!model openrouter/anthropic/claude-x", service)
    expect(calls).toContainEqual(["switchModel", "openrouter/anthropic/claude-x"])
    expect(replies[0]).toContain("openrouter/anthropic/claude-x")
  })

  test("invalid, unavailable, deprecated, and non-chat model refs never switch", async () => {
    const { service, replies, calls } = fake({ getModels: async () => [
      model,
      { providerID: "p", id: "old", type: "chat", status: "deprecated" },
      { providerID: "p", id: "embed", type: "embedding" },
    ] })
    await handleSlackCommand("!model p/old", service)
    await handleSlackCommand("!model p/embed", service)
    await handleSlackCommand("!model no-slash", service)
    expect(calls.filter(([name]) => name === "switchModel")).toHaveLength(0)
    expect(replies).toHaveLength(3)
  })

  test("empty or unavailable model catalogue fails closed", async () => {
    const empty = fake({ getModels: async () => [] })
    await handleSlackCommand("!model opencode/deepseek-v4.1-flash", empty.service)
    expect(empty.calls).toHaveLength(0)
    expect(empty.replies[0]).toContain("No enabled chat models")
    expect(empty.replies[0]).toContain("!setup")
    const unavailable = fake({ getModels: async () => { throw new Error("offline") } })
    await handleSlackCommand("!model", unavailable.service)
    expect(unavailable.replies[0]).toContain("catalogue is unavailable")
    expect(unavailable.replies[0]).toContain("!setup")
  })

  test("sessions show only sorted current-directory non-child rows and number ten", async () => {
    const rows: Array<SessionSummary & { parentID?: string; location?: { directory?: string } }> =
      Array.from({ length: 11 }, (_, i) => ({ ...session(`ses_${String(i).padStart(2, "0")}`, `title ${i}`), time: { updated: i } }))
    rows.splice(1, 0, { ...session("ses_child"), parentID: "ses_parent" })
    rows.splice(2, 0, { ...session("ses_wrong"), location: { directory: "/other" } })
    const { service, replies } = fake({ listSessions: async () => rows, getState: async () => ({}) })
    await handleSlackCommand("!sessions", service)
    expect(replies[0]).toContain("1. *title 10*")
    expect(replies[0]).toContain("10. *title 1*")
    expect(replies[0]).not.toContain("ses_child")
    expect(replies[0]).not.toContain("ses_wrong")
    expect(replies[0]).toContain("…and 1 more")
  })

  test("pasted older session ids are verified and wrong-directory ids cannot be selected", async () => {
    const { service, replies, calls } = fake({
      listSessions: async () => [session("ses_recent")],
      getSession: async (id) => id === "ses_old" ? session(id) : { ...session(id), location: { directory: "/elsewhere" } },
    })
    await handleSlackCommand("!session ses_old", service)
    await handleSlackCommand("!session ses_recent", service)
    expect(calls).toContainEqual(["selectSession", "ses_old"])
    expect(calls).not.toContainEqual(["selectSession", "ses_recent"])
    expect(replies[1]).toContain("No session matches")
  })

  test("answer parses typed option values and cancel uses the first pending form", async () => {
    const { service, replies, calls } = fake()
    await handleSlackCommand("!answer 2", service)
    expect(calls[0]).toEqual(["answerForm", "ses_current", "form_1", { mode: "careful" }])
    expect(replies[0]).toContain("Answered")
    await handleSlackCommand("!cancel", service)
    expect(calls[1]).toEqual(["cancelForm", "ses_current", "form_1"])
  })

  test("status reports phase, pending questions, queue, and errors", async () => {
    const { service, replies } = fake({ getState: async () => ({
      sessionID: "ses_current", phase: "queued", queue: [{ id: "q<1>`", text: "private *input* <x>" }],
      lastTurnError: "turn failed", settlementError: "checkpoint failed",
    }) })
    await handleSlackCommand("!status", service)
    expect(replies[0]).toContain("Phase: queued")
    expect(replies[0]).toContain("1 message queued")
    expect(replies[0]).toContain("private ＊input＊ &lt;x&gt;")
    expect(replies[0]).toContain("q&lt;1&gt;ˋ")
    expect(replies[0]).toContain("Pending question")
    expect(replies[0]).toContain("Last turn error")
    expect(replies[0]).toContain("Settlement error")
    expect(replies[0]).not.toContain("private input")
  })

  test("status distinguishes a general workspace from an immutable registered root without dispatching work", async () => {
    const general = fake({ getState: async () => ({ phase: "idle" }) })
    await handleSlackCommand("!status", general.service)
    expect(general.replies[0]).toContain("Workspace: general; a repository is optional")
    expect(general.calls).toEqual([])
    const registered = fake({ getState: async () => ({ phase: "idle", workspaceRepository: {
      schemaVersion: 1, bindingID: "11111111-1111-4111-8111-111111111111", status: "pending", baseCommit: null,
      repository: "https://github.com/owner/repo", baseBranch: "main", workingBranch: "task/work",
    } }) })
    await handleSlackCommand("!status", registered.service)
    expect(registered.replies[0]).toContain("Registered root (pending): https://github.com/owner/repo")
    expect(registered.calls).toEqual([])
  })

  test("status before a session still reports phase, model, queue, and errors", async () => {
    const { service, replies } = fake({ getState: async () => ({
      phase: "admitting", modelOverride: "openrouter/anthropic/claude-x", queue: [{ text: "pending" }],
      lastTurnError: "startup failed", settlementError: "usage settlement pending",
    }) })
    await handleSlackCommand("!status", service)
    expect(replies[0]).toContain("No session mapped here yet.")
    expect(replies[0]).toContain("Phase: admitting")
    expect(replies[0]).toContain("Model: `openrouter/anthropic/claude-x`")
    expect(replies[0]).toContain("1 message queued")
    expect(replies[0]).toContain("Last turn error")
    expect(replies[0]).toContain("Settlement error")
  })

  test("steer requires text and delegates the trimmed guidance", async () => {
    const { service, replies, calls } = fake()
    await handleSlackCommand("!steer", service)
    expect(replies[0]).toContain("!steer <text>")
    expect(calls).toHaveLength(0)
    await handleSlackCommand("!steer   keep the answer concise  ", service)
    expect(calls).toContainEqual(["steer", "keep the answer concise"])
    expect(replies[1]).toContain("Guidance added")
  })

  test("stop clears queued follow-ups by default and delegates explicit follow-up text", async () => {
    const { service, calls } = fake()
    await handleSlackCommand("!stop", service)
    await handleSlackCommand("!stop   continue with the summary  ", service)
    expect(calls).toContainEqual(["stop"])
    expect(calls).toContainEqual(["stop", "continue with the summary"])
  })

  test("status explains an overdue observation without claiming automatic stop", async () => {
    const { service, replies } = fake({ getState: async () => ({
      sessionID: "ses_current",
      phase: "running",
      turnObservation: {
        policy: "observe_and_alert", thresholdMs: 900_000, executionDeadlineEnforced: false,
        runStartedAt: 100, elapsedMs: 900_000, overdue: true,
        timeoutObserved: false, timeoutObservedAt: null, settlement: "active",
      },
    }) })
    await handleSlackCommand("!status", service)
    expect(replies[0]).toContain("15-minute observation threshold")
    expect(replies[0]).toContain("not automatically stopped")
    expect(replies[0]).not.toContain("runtime stopped")
  })

  test("new, stop, leave, usage, and callback errors are consumed", async () => {
    const { service, replies, calls } = fake()
    for (const command of ["!new", "!stop", "!leave", "!usage"]) expect(await handleSlackCommand(command, service)).toBe(true)
    expect(calls).toContainEqual(["newSession"])
    expect(calls).toContainEqual(["stop"])
    expect(replies).toContain("Usage information")
    const quota = fake({ usageText: async () => { throw new Error("daily quota exceeded") } })
    await handleSlackCommand("!usage", quota.service)
    expect(quota.replies[0]).toContain("!setup")
    const broken = fake({ newSession: async () => { throw new Error("unavailable") } })
    expect(await handleSlackCommand("!new", broken.service)).toBe(true)
    expect(broken.replies[0]).toContain("Couldn't run")
  })
})

test("workspace help makes permanent repository-free work and explicit retention first-class", async () => {
  const f = fake()
  await handleSlackCommand("!help", f.service)
  expect(f.replies[0]).toContain("remain repository-free permanently")
  expect(f.replies[0]).toContain("no git initialization, commit or remote")
  expect(f.replies[0]).toContain("persistent is the default")
  expect(f.replies[0]).toContain("!workspace disposable [name]")
  expect(f.replies[0]).toContain("finish/idle never auto-discards")
  expect(f.calls).toEqual([])
})

test("workspace status and normal status read retention passively without starting model/session work", async () => {
  const requests: string[] = []
  const f = fake({ getState: async () => ({}), workspace: {
    repository: async () => Response.json({ workspaceRepository: null }), check: async () => "", checks: async () => "",
    workspace: async request => { requests.push(request.method + " " + new URL(request.url).pathname); return Response.json({ workspace: { schemaVersion: 1, profileID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", revision: 2, retention: "disposable", name: "Scratch <notes>", status: "active" } }) },
  } })
  expect(await handleSlackCommand("!workspace", f.service)).toBe(true)
  expect(f.replies[0]).toContain("disposable")
  expect(f.replies[0]).toContain("Scratch &lt;notes&gt;")
  expect(f.replies[0]).toContain("checkpoint")
  await handleSlackCommand("!status", f.service)
  expect(f.replies[1]).toContain("Retention: disposable")
  expect(requests).toEqual(["GET /workspace/profile", "GET /workspace/profile"])
  expect(f.calls).toEqual([])
})

test("ordinary descriptions of temporary work never become retention changes or discard commands", async () => {
  const f = fake()
  expect(await handleSlackCommand("temporary disposable analysis", f.service)).toBe(false)
  expect(f.calls).toEqual([])
  expect(f.replies).toEqual([])
})

describe("harness-first commands with no execution", () => {
  // Every runtime-backed reader throws: a command that reaches for one fails
  // loudly here, which is how "never start a runtime to answer" is asserted.
  const cold = (overrides: Partial<SlackCommandServices> = {}) => fake({
    runtime: () => ({ warm: false }),
    getModels: async () => { throw new Error("cold: model catalogue") },
    getSession: async () => { throw new Error("cold: session") },
    listSessions: async () => { throw new Error("cold: sessions") },
    listForms: async () => { throw new Error("cold: forms") },
    ...overrides,
  })

  test("!status answers from durable state and reports the runtime as cold", async () => {
    const f = cold({
      getState: async () => ({
        sessionID: "ses_current", phase: "idle", modelOverride: "p/chat-b",
        queue: [{ id: "q1", text: "queued follow-up" }],
      }),
    })
    expect(await handleSlackCommand("!status", f.service)).toBe(true)
    expect(f.replies[0]).toContain("Runtime: cold (harness mode)")
    expect(f.replies[0]).toContain("Session `ses_current`")
    expect(f.replies[0]).toContain("Phase: idle")
    expect(f.replies[0]).toContain("Model: `p/chat-b`")
    expect(f.replies[0]).toContain("1 message queued")
    expect(f.replies[0]).toContain("not shown while it is cold")
    expect(f.replies).toHaveLength(1)
  })

  test("harness-only commands answer in one reply each", async () => {
    const f = cold({
      usageText: async () => "Usage information",
      workspace: {
        repository: async () => Response.json({ workspaceRepository: null }),
        check: async () => "Check not queued: the workspace is not warm.",
        checks: async () => "No checks requested here.",
      },
    })
    for (const text of ["!help", "!usage", "!workspace", "!repo", "!checks"]) {
      expect(await handleSlackCommand(text, f.service)).toBe(true)
    }
    expect(f.replies).toHaveLength(5)
    expect(f.calls).toEqual([])
    expect(f.replies.join("\n")).toContain("!status")
  })

  test("session-dependent commands say they need an execution instead of starting one", async () => {
    const f = cold()
    for (const text of ["!sessions", "!session 1", "!model", "!answer", "!cancel", "!steer keep going", "!new"]) {
      expect(await handleSlackCommand(text, f.service)).toBe(true)
    }
    expect(f.replies).toHaveLength(7)
    for (const reply of f.replies) expect(reply).toContain("needs the code runtime")
    expect(f.calls).toEqual([])
  })

  test("!model still reports the saved model while the catalogue is unavailable", async () => {
    const f = cold({ getState: async () => ({ modelOverride: "p/chat-a" }) })
    await handleSlackCommand("!model", f.service)
    expect(f.replies[0]).toContain("Current model: `p/chat-a`")
    expect(f.replies[0]).toContain("needs the code runtime")
  })

  test("!new without a mapped session needs no runtime", async () => {
    const f = cold({ getState: async () => ({}) })
    expect(await handleSlackCommand("!new", f.service)).toBe(true)
    expect(f.replies[0]).toContain("fresh session")
    expect(f.calls).toContainEqual(["newSession"])
  })
})
