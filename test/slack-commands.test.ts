import { beforeEach, describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"
import { usageLogResponse } from "./helpers/usage-log"
import type { ConversationState } from "../src/state"
import type { Form } from "../src/slack-forms"

type Call = { method: string; path: string; body?: unknown }

function fakeContainer(calls: Call[], usageExecution?: "succeeded" | "failed" | "interrupted" | "running") {
  return (port: number) => ({
    async fetch(input: Request | string | URL): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input)
      const url = new URL(request.url)
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })
      if (port === 4001) {
        if (url.pathname === "/status") return json({ initialized: true })
        if (url.pathname === "/start") return json(accountingPolicyStart)
        if (url.pathname === "/configure") return json({ ok: true })
        return json({ error: "not found" }, 404)
      }
      let body: unknown
      if (request.body) {
        try { body = await request.clone().json() } catch { body = undefined }
      }
      calls.push({ method: request.method, path: url.pathname, ...(body === undefined ? {} : { body }) })
      if (url.pathname === "/api/config") return json(accountingPolicyConfig)
      if (url.pathname === "/api/model") return json({ data: [
        { providerID: "p", id: "chat-a", name: "Chat A", type: "chat", enabled: true },
        { providerID: "p", id: "chat-b", name: "Chat B", type: "chat", enabled: true },
        { providerID: "p", id: "image", type: "image", enabled: true },
      ] })
      if (url.pathname === "/api/session") {
        if (request.method === "POST") return json({ data: { id: "ses_new" } })
        return json({ data: [
          { id: "ses_1", title: "Existing", location: { directory: "/workspace" }, time: { updated: Date.now() } },
          { id: "ses_other", title: "Other workspace", location: { directory: "/elsewhere" } },
        ] })
      }
      if (url.pathname === "/api/session/ses_1") return json({ data: { id: "ses_1", title: "Existing", location: { directory: "/workspace" }, model: { providerID: "p", id: "chat-a" } } })
      if (url.pathname.endsWith("/context")) return json({ data: url.pathname.includes("ses_1") ? [{ id: "old", type: "assistant", content: [{ type: "text", text: "history" }] }] : [] })
      const logMatch = url.pathname.match(/^\/api\/experimental\/session\/([^/]+)\/log$/)
      if (logMatch?.[1]) return usageLogResponse(request, logMatch[1], [], usageExecution ? { execution: usageExecution } : {})
      if (url.pathname === "/api/session/ses_1/form") return json({ data: [{ id: "form1" }] })
      if (url.pathname === "/api/session/ses_1/form/form1") return json({ data: { id: "form1", sessionID: "ses_1", title: "Confirm", fields: [{ key: "confirm", type: "boolean", required: true }], state: { status: "pending" } } })
      if (url.pathname.endsWith("/form/form1/reply")) return new Response(null, { status: 204 })
      if (url.pathname === "/api/session/ses_1/permission") return json({ data: [] })
      if (url.pathname === "/api/event") return new Response(": connected\n\n", { headers: { "content-type": "text/event-stream" } })
      if (url.pathname.endsWith("/interrupt")) return json({ data: {} })
      if (url.pathname.endsWith("/model")) return new Response(null, { status: 204 })
      return json({ data: {} })
    },
  })
}

async function seed(stub: ReturnType<typeof env.CONVERSATION.getByName>, state: Record<string, unknown>) {
  await runInDurableObject(stub, async (_instance, runtime) => {
    await runtime.storage.deleteAll()
    await runtime.storage.put("state", { seen: [], pending: {}, ...state })
  })
}

async function send(stub: ReturnType<typeof env.CONVERSATION.getByName>, text: string, options: {
  type?: string; channelType?: string; threadTs?: string; eventID?: string; replyTs?: string
} = {}) {
  return runInDurableObject(stub, async (instance) => {
    const posts: Array<{ method: string; body: Record<string, unknown> }> = []
    ;(instance as unknown as { slackAdapter: { slack: unknown } }).slackAdapter.slack = async (method: string, body: Record<string, unknown>) => {
      posts.push({ method, body }); return { ok: true }
    }
    const response = await instance.fetch(new Request("https://conversation/slack", {
      method: "POST",
      body: JSON.stringify({
        ...(options.eventID ? { eventID: options.eventID } : {}),
        ...(options.replyTs ? { replyTs: options.replyTs } : {}),
        event: { type: options.type ?? "message", channel: "C_TEST", channel_type: options.channelType ?? "im", ts: `ts-${text}`, ...(options.threadTs ? { thread_ts: options.threadTs } : {}), text },
      }),
    }))
    return { response, posts }
  })
}

describe("Slack commands in the Conversation DO", () => {
  it("consumes help and unknown bang commands while busy with a retained hold, without prompt admission", async () => {
    const stub = env.CONVERSATION.getByName("slack-command-bypass-test")
    await seed(stub, { phase: "running", sessionID: "ses_1", budgetReservation: { reservationID: "held", dispatched: true } })
    const calls: Call[] = []
    const result = await runInDurableObject(stub, async (instance) => {
      instance.transport = fakeContainer(calls)
      const posts: string[] = []
      ;(instance as unknown as { slackAdapter: { slack: unknown } }).slackAdapter.slack = async (_method: string, body: Record<string, unknown>) => { posts.push(String(body.text)); return { ok: true } }
      for (const text of ["!help", "!nonesuch"]) await instance.fetch(new Request("https://conversation/slack", { method: "POST", body: JSON.stringify({ event: { type: "message", channel: "C", channel_type: "im", ts: text, text } }) }))
      return posts
    })
    expect(result.join("\n")).toContain("!help")
    expect(result.join("\n")).toContain("don't know")
    expect(calls).toHaveLength(0)
    expect(calls.some((call) => call.path.endsWith("/prompt"))).toBe(false)
  })

  it("ignores ordinary channel posts, routes engaged thread commands to that thread, and detaches on leave", async () => {
    const stub = env.CONVERSATION.getByName("slack-command-routing-test")
    await seed(stub, { slackEngaged: false })
    const ignored = await send(stub, "!help", { type: "message", channelType: "channel" })
    expect(ignored.posts).toHaveLength(0)
    await seed(stub, { slackEngaged: true })
    const command = await send(stub, "!help", { type: "message", channelType: "channel", threadTs: "root.1", replyTs: "root.1" })
    expect(command.posts[0]?.body).toMatchObject({ channel: "C_TEST", thread_ts: "root.1" })
    const leave = await send(stub, "!leave", { type: "app_mention", channelType: "channel", replyTs: "root.2" })
    expect(leave.posts[0]?.body.thread_ts).toBe("root.2")
    const state = await runInDurableObject(stub, async (_instance, runtime) => runtime.storage.get("state"))
    expect(state).toMatchObject({ slackEngaged: false })
  })

  it("validates model choices, stores a per-conversation override, and never prompts for commands", async () => {
    const stub = env.CONVERSATION.getByName("slack-command-model-test")
    await seed(stub, { sessionID: "ses_1", slack: { channel: "C_TEST" } })
    const calls: Call[] = []
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      instance.transport = fakeContainer(calls)
      const posts: string[] = []
      ;(instance as unknown as { slackAdapter: { slack: unknown } }).slackAdapter.slack = async (_method: string, body: Record<string, unknown>) => { posts.push(String(body.text)); return { ok: true } }
      const make = (eventID: string, text: string) => instance.fetch(new Request("https://conversation/slack", { method: "POST", body: JSON.stringify({ eventID, event: { type: "message", channel: "C_TEST", channel_type: "im", ts: eventID, text } }) }))
      await make("invalid-model", "!model p/chat")
      await make("valid-model", "!model p/chat-b")
      await make("valid-model", "!model p/chat-b")
      return { posts, state: await runtime.storage.get("state") }
    })
    expect(result.posts.join("\n")).toContain("Did you mean")
    expect(result.state).toMatchObject({ modelOverride: "p/chat-b" })
    expect(calls.filter((call) => call.path === "/api/session/ses_1/model")).toHaveLength(1)
    expect(calls.some((call) => call.path.endsWith("/prompt"))).toBe(false)
  })

  it("switches to a verified session or clears mapping without deleting history/checkpoint/source data", async () => {
    const stub = env.CONVERSATION.getByName("slack-command-session-test")
    await seed(stub, { sessionID: "ses_old", phase: "idle", checkpointKey: "archive-key", slack: { channel: "C_TEST" } })
    const calls: Call[] = []
    await runInDurableObject(stub, async (_instance, runtime) => {
      await runtime.storage.put("usage-source:test", { sourceID: "source-kept", costUSD: 0.25 })
    })
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      instance.transport = fakeContainer(calls)
      const posts: string[] = []
      ;(instance as unknown as { slackAdapter: { slack: unknown } }).slackAdapter.slack = async (_method: string, body: Record<string, unknown>) => { posts.push(String(body.text)); return { ok: true } }
      const sendCommand = (eventID: string, text: string) => instance.fetch(new Request("https://conversation/slack", { method: "POST", body: JSON.stringify({ eventID, event: { type: "message", channel: "C_TEST", channel_type: "im", ts: eventID, text } }) }))
      await sendCommand("switch-session", "!sessions 1")
      const switched = await runtime.storage.get<ConversationState>("state")
      if (!switched) throw new Error("conversation state missing after session switch")
      await sendCommand("new-session", "!new")
      const fresh = await runtime.storage.get<ConversationState>("state")
      if (!fresh) throw new Error("conversation state missing after !new")
      return { switched, fresh, source: await runtime.storage.get("usage-source:test"), posts }
    })
    expect(result.switched.sessionID, result.posts.join("\n")).toBe("ses_1")
    expect(result.switched.checkpointKey).toBe("archive-key")
    expect(result.fresh.sessionID).toBeUndefined()
    expect(result.fresh.checkpointKey).toBe("archive-key")
    expect(result.source).toEqual({ sourceID: "source-kept", costUSD: 0.25 })
  })

  it("refuses model/session changes with a retained hold and interrupts without releasing it", async () => {
    const stub = env.CONVERSATION.getByName("slack-command-hold-test")
    await seed(stub, { sessionID: "ses_1", phase: "running", budgetReservation: { reservationID: "keep-me", dispatched: true }, slack: { channel: "C_TEST" } })
    const calls: Call[] = []
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      instance.transport = fakeContainer(calls)
      const posts: string[] = []
      ;(instance as unknown as { slackAdapter: { slack: unknown } }).slackAdapter.slack = async (_method: string, body: Record<string, unknown>) => { posts.push(String(body.text)); return { ok: true } }
      for (const [id, text] of [["blocked-model", "!model p/chat-b"], ["blocked-session", "!sessions 1"], ["stop", "!stop"]]) {
        await instance.fetch(new Request("https://conversation/slack", { method: "POST", body: JSON.stringify({ eventID: id, event: { type: "message", channel: "C_TEST", channel_type: "im", ts: id, text } }) }))
      }
      const state = await runtime.storage.get<ConversationState>("state")
      if (!state) throw new Error("conversation state missing after command")
      return { posts, state }
    })
    expect(result.posts.join("\n")).toContain("unfinished work")
    expect(result.posts.join("\n")).toContain("Stop requested")
    expect(calls.some((call) => call.path.endsWith("/interrupt"))).toBe(true)
    expect(result.state.budgetReservation).toEqual({ reservationID: "keep-me", dispatched: true })
    expect(calls.some((call) => call.method === "POST" && call.path.endsWith("/model"))).toBe(false)
  })

  it("refuses !new when the durable log has an unmatched execution start", async () => {
    const stub = env.CONVERSATION.getByName("slack-command-log-fence-test")
    await seed(stub, { sessionID: "ses_1", phase: "idle", checkpointKey: "archive-key", slack: { channel: "C_TEST" } })
    const calls: Call[] = []
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      instance.transport = fakeContainer(calls, "running")
      const posts: string[] = []
      ;(instance as unknown as { slackAdapter: { slack: unknown } }).slackAdapter.slack = async (_method: string, body: Record<string, unknown>) => { posts.push(String(body.text)); return { ok: true } }
      await instance.fetch(new Request("https://conversation/slack", { method: "POST", body: JSON.stringify({ event: { type: "message", channel: "C_TEST", channel_type: "im", ts: "new-fenced", text: "!new" } }) }))
      const state = await runtime.storage.get<ConversationState>("state")
      if (!state) throw new Error("conversation state missing after fenced !new")
      return { state, posts }
    })
    expect(result.posts.join("\n")).toContain("provider execution is not terminal")
    expect(result.state.sessionID).toBe("ses_1")
    expect(result.state.checkpointKey).toBe("archive-key")
    expect(result.state.budgetReservation).toBeUndefined()
    expect(calls.some((call) => call.path.endsWith("/prompt"))).toBe(false)
  })

  it("tombstones a command before a Slack reply failure so its retry cannot clear a newer mapping", async () => {
    const stub = env.CONVERSATION.getByName("slack-command-reply-retry-test")
    await seed(stub, { sessionID: "ses_1", phase: "idle" })
    const calls: Call[] = []
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      instance.transport = fakeContainer(calls)
      let replyAttempts = 0
      ;(instance as unknown as { slackAdapter: { slack: unknown } }).slackAdapter.slack = async () => {
        replyAttempts++
        throw new Error("Slack reply unavailable")
      }
      const input = { eventID: "command-reply-failed", event: { type: "message", channel: "C_TEST", channel_type: "im", ts: "cmd1", text: "!new" } }
      await instance.fetch(new Request("https://conversation/slack", { method: "POST", body: JSON.stringify(input) })).catch(() => {})
      // Simulate a later, independent successful selection after the failed reply.
      // Preserve the DO tombstone rows so replaying the original delivery is a no-op.
      await runtime.storage.put("state", { seen: ["command-reply-failed"], pending: {}, sessionID: "ses_new", phase: "idle" })
      await instance.fetch(new Request("https://conversation/slack", { method: "POST", body: JSON.stringify(input) }))
      const state = await runtime.storage.get<ConversationState>("state")
      if (!state) throw new Error("conversation state missing after duplicate command")
      return { replyAttempts, state }
    })
    // The command reply and its error notice each fail once; retrying the same
    // Slack delivery must not cause a third attempt or clear ses_new.
    expect(result.replyAttempts).toBe(2)
    expect(result.state.sessionID).toBe("ses_new")
  })

  it("applies a pre-session model override when a later ordinary DM message starts the session", async () => {
    const stub = env.CONVERSATION.getByName("slack-command-first-prompt-test")
    await seed(stub, {})
    const calls: Call[] = []
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      instance.transport = fakeContainer(calls)
      ;(instance as unknown as { slackAdapter: { slack: unknown } }).slackAdapter.slack = async () => ({ ok: true })
      const post = (id: string, text: string) => instance.fetch(new Request("https://conversation/slack", { method: "POST", body: JSON.stringify({ eventID: id, event: { type: "message", channel: "D_TEST", channel_type: "im", ts: id, text } }) }))
      await post("pre-model", "!model p/chat-b")
      await post("first-prompt", "hello")
      return { state: await runtime.storage.get("state"), calls }
    })
    expect(result.state).toMatchObject({ modelOverride: "p/chat-b", sessionID: "ses_new" })
    expect(result.calls.some((call) => call.path === "/api/session/ses_new/model")).toBe(true)
    expect(result.calls.some((call) => call.path.endsWith("/prompt"))).toBe(true)
  })

  it("uses the global model for an existing session unless a conversation override is set", async () => {
    const settings = env.SETTINGS.getByName("global")
    await runInDurableObject(settings, async (_instance, runtime) => runtime.storage.deleteAll())
    const configured = await settings.fetch("https://settings/put", {
      method: "POST", body: JSON.stringify({ model: "p/chat-b" }),
    })
    expect(configured.ok).toBe(true)

    const calls: Call[] = []
    for (const [name, override, expected] of [
      ["uses-global", undefined, "chat-b"],
      ["override-wins", "p/chat-a", "chat-a"],
    ] as const) {
      const stub = env.CONVERSATION.getByName(`slack-existing-model-${name}`)
      await seed(stub, { sessionID: "ses_1", ...(override ? { modelOverride: override } : {}) })
      await runInDurableObject(stub, async (instance) => {
        instance.transport = fakeContainer(calls)
        ;(instance as unknown as { slackAdapter: { slack: unknown } }).slackAdapter.slack = async () => ({ ok: true })
        await instance.fetch(new Request("https://conversation/slack", {
          method: "POST",
          body: JSON.stringify({ event: { type: "message", channel: "D_TEST", channel_type: "im", ts: name, text: "continue" } }),
        }))
      })
      const switchCall = calls.filter((call) => call.method === "POST" && call.path === "/api/session/ses_1/model").at(-1)
      expect(switchCall).toBeDefined()
      expect(JSON.stringify(switchCall?.body)).toContain(expected)
    }
    expect(calls.filter((call) => call.method === "POST" && call.path === "/api/session/ses_1/model")).toHaveLength(2)
    expect(calls.filter((call) => call.path.endsWith("/prompt"))).toHaveLength(2)
  })

  it("refuses stale form ids and answers only a pending form with the expected schema", async () => {
    const stub = env.CONVERSATION.getByName("slack-command-form-test")
    await seed(stub, { sessionID: "ses_1", slack: { channel: "C_TEST" } })
    const calls: Call[] = []
    const result = await runInDurableObject(stub, async (instance) => {
      instance.transport = fakeContainer(calls)
      const stale = await instance.fetch(new Request("https://conversation/form", { method: "POST", body: JSON.stringify({ channel: "C_TEST", sessionID: "ses_old", formID: "form1", field: "confirm", value: true }) }))
      const malformed = await instance.fetch(new Request("https://conversation/form", { method: "POST", body: JSON.stringify({ channel: "C_TEST", sessionID: "ses_1", formID: "form1", field: "other", value: true }) }))
      const wrongChannel = await instance.fetch(new Request("https://conversation/form", { method: "POST", body: JSON.stringify({ channel: "C_OTHER", sessionID: "ses_1", formID: "form1", field: "confirm", value: true }) }))
      const valid = await instance.fetch(new Request("https://conversation/form", { method: "POST", body: JSON.stringify({ channel: "C_TEST", sessionID: "ses_1", formID: "form1", field: "confirm", value: true }) }))
      return { stale: stale.status, malformed: malformed.status, wrongChannel: wrongChannel.status, valid: valid.status, validBody: await valid.text(), calls }
    })
    expect(result.stale).toBe(409)
    expect(result.malformed).toBe(400)
    expect(result.wrongChannel).toBe(409)
    expect(result.valid, result.validBody).toBe(200)
    expect(result.calls.filter((call) => call.path.endsWith("/form/form1/reply"))).toHaveLength(1)
  })

  it("delivers a pending question card with choice and cancel buttons into the mapped thread", async () => {
    const stub = env.CONVERSATION.getByName("slack-command-form-card-test")
    await seed(stub, { sessionID: "ses_1", slack: { channel: "C_TEST", replyTs: "thread.root" } })
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const posts: Array<{ method: string; body: Record<string, unknown> }> = []
      ;(instance as unknown as { slackAdapter: { slack: unknown } }).slackAdapter.slack = async (method: string, body: Record<string, unknown>) => {
        posts.push({ method, body }); return { ok: true }
      }
      const internal = instance as unknown as {
        env: { SLACK_BOT_TOKEN?: string }
        turnExecution: { pollQuestions(sessionID: string, forms: Form[]): Promise<void> }
      }
      internal.env.SLACK_BOT_TOKEN = "xoxb-test-token"
      await internal.turnExecution.pollQuestions("ses_1", [{
        id: "form-choice", sessionID: "ses_1", title: "Choose a plan", fields: [{
          key: "plan", type: "string", required: true, options: [
            { value: "basic", label: "Basic" }, { value: "plus", label: "Plus" },
          ],
        }],
      }])
      const state = await runtime.storage.get<ConversationState>("state")
      if (!state) throw new Error("conversation state missing after question delivery")
      return { posts, state }
    })
    expect(result.posts).toHaveLength(1)
    expect(result.posts[0]?.method).toBe("chat.postMessage")
    expect(result.posts[0]?.body).toMatchObject({ channel: "C_TEST", thread_ts: "thread.root" })
    const blocks = result.posts[0]?.body.blocks as Array<{ type: string; elements?: Array<{ action_id?: string }> }>
    expect(blocks.filter((block) => block.type === "actions")).toHaveLength(3)
    expect(blocks.flatMap((block) => block.elements ?? []).map((element) => element.action_id)).toEqual([
      "form_answer", "form_answer", "form_cancel",
    ])
    expect(result.state.announcedForms).toContain("form-choice")
  })
})
