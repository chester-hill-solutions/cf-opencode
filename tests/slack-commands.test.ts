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
    getDefaultModel: async () => "opencode/deepseek-v4.1-flash",
    getModels: async () => [model],
    getSession: async (id) => session(id),
    listSessions: async () => [session("ses_current"), session("ses_other")],
    switchModel: async (ref) => { calls.push(["switchModel", ref]) },
    selectSession: async (id) => { calls.push(["selectSession", id]) },
    newSession: async () => { calls.push(["newSession"]) },
    stop: async () => "⏹️ Interrupted.",
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
      sessionID: "ses_current", phase: "queued", queued: { text: "private input" },
      lastTurnError: "turn failed", settlementError: "checkpoint failed",
    }) })
    await handleSlackCommand("!status", service)
    expect(replies[0]).toContain("Phase: queued")
    expect(replies[0]).toContain("Pending question")
    expect(replies[0]).toContain("Last turn error")
    expect(replies[0]).toContain("Settlement error")
    expect(replies[0]).not.toContain("private input")
  })

  test("status before a session still reports phase, model, queue, and errors", async () => {
    const { service, replies } = fake({ getState: async () => ({
      phase: "admitting", modelOverride: "openrouter/anthropic/claude-x", queued: true,
      lastTurnError: "startup failed", settlementError: "usage settlement pending",
    }) })
    await handleSlackCommand("!status", service)
    expect(replies[0]).toContain("No session mapped here yet.")
    expect(replies[0]).toContain("Phase: admitting")
    expect(replies[0]).toContain("Model: `openrouter/anthropic/claude-x`")
    expect(replies[0]).toContain("A message is queued")
    expect(replies[0]).toContain("Last turn error")
    expect(replies[0]).toContain("Settlement error")
  })

  test("new, stop, leave, usage, and callback errors are consumed", async () => {
    const { service, replies, calls } = fake()
    for (const command of ["!new", "!stop", "!leave", "!usage"]) expect(await handleSlackCommand(command, service)).toBe(true)
    expect(calls).toContainEqual(["newSession"])
    expect(replies).toContain("Usage information")
    const quota = fake({ usageText: async () => { throw new Error("daily quota exceeded") } })
    await handleSlackCommand("!usage", quota.service)
    expect(quota.replies[0]).toContain("!setup")
    const broken = fake({ newSession: async () => { throw new Error("unavailable") } })
    expect(await handleSlackCommand("!new", broken.service)).toBe(true)
    expect(broken.replies[0]).toContain("Couldn't run")
  })
})
