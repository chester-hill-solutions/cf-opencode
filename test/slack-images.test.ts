import { beforeEach, describe, expect, it, vi } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"
import type { ConversationState } from "../src/state"
import worker from "../src/index"
import type { Env } from "../src/env"

type ApiCall = { method: string; path: string; body?: unknown }

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

const models = [
  { id: "vision", modelID: "vision", providerID: "p", name: "Vision", type: "chat", enabled: true, variants: [], capabilities: { tools: true, input: ["text", "image"], output: ["text"] }, time: { released: 0 }, cost: [], status: "active", limit: { context: 1000, output: 1000 } },
  { id: "text", modelID: "text", providerID: "p", name: "Text", type: "chat", enabled: true, variants: [], capabilities: { tools: true, input: ["text"], output: ["text"] }, time: { released: 0 }, cost: [], status: "active", limit: { context: 1000, output: 1000 } },
]

function fakeContainer(calls: ApiCall[], options: {
  models?: typeof models
  sessionModel?: { providerID: string; id: string }
  omitSessionModel?: boolean
  failSessionRead?: boolean
} = {}) {
  let selectedModel: { providerID: string; id: string } | undefined = options.sessionModel ?? { providerID: "p", id: "vision" }
  return (port: number) => ({
    async fetch(input: Request | string | URL): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input)
      const url = new URL(request.url)
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
        status, headers: { "content-type": "application/json" },
      })
      if (port === 4001) {
        if (url.pathname === "/status") return json({ initialized: true })
        if (url.pathname === "/configure") return json({ ok: true })
        if (url.pathname === "/start") return json(accountingPolicyStart)
        return json({ error: "not found" }, 404)
      }

      let body: unknown
      if (request.body) {
        try { body = await request.clone().json() } catch { body = undefined }
      }
      calls.push({ method: request.method, path: url.pathname, ...(body === undefined ? {} : { body }) })
      if (url.pathname === "/api/config") return json(accountingPolicyConfig)
      if (url.pathname === "/api/model") return json({ data: options.models ?? models })
      if (url.pathname === "/api/session" && request.method === "POST") return json({ data: { id: "ses_image" } })
      if (url.pathname === "/api/session/ses_image") {
        if (options.failSessionRead) return json({ error: "session unavailable" }, 503)
        return json({ data: { id: "ses_image", ...(options.omitSessionModel ? {} : { model: selectedModel }) } })
      }
      if (url.pathname === "/api/session/ses_image/model") {
        const input = body as { model?: { providerID?: string; id?: string } } | undefined
        if (input?.model && typeof input.model.providerID === "string" && typeof input.model.id === "string") {
          selectedModel = { providerID: input.model.providerID, id: input.model.id }
        }
        return new Response(null, { status: 204 })
      }
      if (url.pathname === "/api/session/ses_image/context") return json({ data: [] })
      if (url.pathname === "/api/session/ses_image/prompt") return json({ data: {} })
      if (url.pathname === "/api/session/ses_image/permission") return json({ data: [] })
      if (url.pathname === "/api/experimental/session/ses_image/log") {
        return new Response(`data: ${JSON.stringify({ type: "log.synced", aggregateID: "ses_image", seq: 0 })}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      }
      if (url.pathname === "/api/event") return new Response(": connected\n\n", { headers: { "content-type": "text/event-stream" } })
      return json({ data: {} })
    },
  })
}

async function seed(stub: ReturnType<typeof env.CONVERSATION.getByName>, state: Partial<ConversationState> = {}) {
  await runInDurableObject(stub, async (_instance, runtime) => {
    await runtime.storage.deleteAll()
    await runtime.storage.put("state", { seen: [], pending: {}, modelOverride: "p/vision", ...state })
  })
}

async function sendImage(stub: ReturnType<typeof env.CONVERSATION.getByName>, options: {
  eventID?: string
  text?: string
  type?: string
  channelType?: string
  threadTs?: string
  subtype?: string
  files?: unknown[]
  models?: typeof models
  sessionModel?: { providerID: string; id: string }
  omitSessionModel?: boolean
  failSessionRead?: boolean
  downloadBytes?: Uint8Array
  failStartup?: boolean
  omitSlackToken?: boolean
}) {
  const calls: ApiCall[] = []
  const posts: string[] = []
  const fetches: Array<{ url: string; authorization: string | null }> = []
  const response = await runInDurableObject(stub, async (instance, runtime) => {
    instance.transport = fakeContainer(calls, {
      models: options.models,
      sessionModel: options.sessionModel,
      omitSessionModel: options.omitSessionModel,
      failSessionRead: options.failSessionRead,
    })
    if (options.failStartup) {
      ;(instance as unknown as { ensureReady: () => Promise<never> }).ensureReady = async () => {
        throw new Error("container capacity reached")
      }
    }
    if (!options.omitSlackToken) {
      ;(instance as unknown as { env: { SLACK_BOT_TOKEN?: string } }).env.SLACK_BOT_TOKEN = "xoxb-test-image-token"
    } else {
      delete (instance as unknown as { env: { SLACK_BOT_TOKEN?: string } }).env.SLACK_BOT_TOKEN
    }
    ;(instance as unknown as { slack: unknown }).slack = async (_method: string, body: Record<string, unknown>) => {
      posts.push(String(body.text ?? ""))
      return { ok: true }
    }
    vi.stubGlobal("fetch", async (input: string | Request | URL, init?: RequestInit) => {
      fetches.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") })
      return new Response(options.downloadBytes ?? png, { status: 200, headers: { "content-type": "image/png" } })
    })
    const result = await instance.fetch(new Request("https://conversation/slack", {
      method: "POST",
      body: JSON.stringify({
        ...(options.eventID ? { eventID: options.eventID } : {}),
        ...(options.threadTs ? { replyTs: options.threadTs } : {}),
        event: {
          type: options.type ?? "message",
          subtype: options.subtype ?? "file_share",
          channel: options.channelType === "channel" ? "C_IMAGE" : "D_IMAGE",
          channel_type: options.channelType ?? "im",
          ts: options.eventID ?? `image-${options.text ?? "only"}`,
          ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
          ...(options.text !== undefined ? { text: options.text } : {}),
          files: options.files ?? [{ id: "F_IMAGE", name: "photo.png", mimetype: "image/png", size: png.length, url_private_download: "https://files.slack.com/f/image" }],
        },
      }),
    }))
    const state = await runtime.storage.get<ConversationState>("state")
    return { status: result.status, body: await result.json(), state }
  })
  vi.unstubAllGlobals()
  return { ...response, calls, posts, fetches }
}

describe("Slack image routing", () => {
  beforeEach(async () => {
    vi.unstubAllGlobals()
    await runInDurableObject(env.SETTINGS.getByName("global"), async (_instance, runtime) => runtime.storage.deleteAll())
  })

  async function setDefaultModel(model: string) {
    const response = await env.SETTINGS.getByName("global").fetch("https://settings/put", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...(await (await env.SETTINGS.getByName("global").fetch("https://settings/get")).json() as object), model }),
    })
    expect(response.ok).toBe(true)
  }

  it("sends an accepted caption and one validated file exactly once, including Slack dedupe", async () => {
    const stub = env.CONVERSATION.getByName("slack-image-caption"); await seed(stub)
    const result = await sendImage(stub, { eventID: "image-caption", text: "What is in this picture?" })
    const retried = await sendImage(stub, { eventID: "image-caption", text: "What is in this picture?" })
    const prompt = result.calls.find((call) => call.path.endsWith("/prompt"))?.body as { text?: string; files?: Array<{ uri: string; name?: string }> } | undefined
    expect(result.status).toBe(200)
    expect(prompt?.text).toContain("What is in this picture?")
    expect(prompt?.files).toHaveLength(1)
    expect(prompt?.files?.[0]?.uri.startsWith("data:image/png;base64,")).toBe(true)
    expect(result.fetches).toEqual([{ url: "https://files.slack.com/f/image", authorization: "Bearer xoxb-test-image-token" }])
    expect(retried.calls.filter((call) => call.path.endsWith("/prompt"))).toHaveLength(0)
  })

  it("uses a default prompt for image-only messages and accepts file_share DMs", async () => {
    const stub = env.CONVERSATION.getByName("slack-image-only"); await seed(stub)
    const result = await sendImage(stub, { eventID: "image-only" })
    const prompt = result.calls.find((call) => call.path.endsWith("/prompt"))?.body as { text?: string } | undefined
    expect(prompt?.text).toContain("Describe the attached image.")
    expect(result.calls.filter((call) => call.path.endsWith("/prompt"))).toHaveLength(1)
  })

  it("refuses nonvision and unknown selected models before downloading or reserving", async () => {
    for (const [key, override, available] of [
      ["nonvision", "p/text", models],
      ["unknown", "p/missing", models],
    ] as const) {
      const stub = env.CONVERSATION.getByName(`slack-image-model-${key}`)
      await seed(stub, { modelOverride: override })
      const result = await sendImage(stub, { eventID: key, models: available })
      expect(result.calls.filter((call) => call.path.endsWith("/prompt"))).toHaveLength(0)
      expect(result.fetches).toHaveLength(0)
      expect(result.state?.budgetReservation).toBeUndefined()
      expect(result.state?.queued).toBeUndefined()
      expect(result.posts.join(" ")).toContain(key === "nonvision" ? "can't read images" : "couldn't confirm")
      if (key === "nonvision") expect(result.posts.join(" ")).toContain("p/vision")
    }
  })

  it("applies the selected override to a restored session and refuses startup capacity", async () => {
    const sessionStub = env.CONVERSATION.getByName("slack-image-session-model")
    await seed(sessionStub, { sessionID: "ses_image", modelOverride: "p/vision" })
    const sessionModel = await sendImage(sessionStub, {
      eventID: "session-nonvision",
      models,
      // The stored vision override is applied before image compatibility is checked.
      sessionModel: { providerID: "p", id: "text" },
    })
    expect(sessionModel.fetches, JSON.stringify({ calls: sessionModel.calls, posts: sessionModel.posts })).toHaveLength(1)
    expect(sessionModel.calls.filter((call) => call.path.endsWith("/prompt"))).toHaveLength(1)

    const capacityStub = env.CONVERSATION.getByName("slack-image-capacity")
    await seed(capacityStub)
    const capacity = await sendImage(capacityStub, { eventID: "capacity", failStartup: true })
    expect(capacity.fetches).toHaveLength(0)
    expect(capacity.calls.filter((call) => call.path.endsWith("/prompt"))).toHaveLength(0)
    expect(capacity.state?.budgetReservation).toBeUndefined()
    expect(capacity.state?.queued).toBeUndefined()
    expect(capacity.posts.join(" ")).toContain("couldn't start the session")
  })

  it("checks the model after applying the current override or default, before downloading", async () => {
    for (const [key, state, defaultModel] of [
      ["override", { sessionID: "ses_image", modelOverride: "p/text" }, "p/vision"],
      ["default", { sessionID: "ses_image", modelOverride: undefined }, "p/text"],
    ] as const) {
      const stub = env.CONVERSATION.getByName(`slack-image-current-${key}`)
      await seed(stub, state)
      await setDefaultModel(defaultModel)
      const result = await sendImage(stub, { eventID: `current-${key}`, sessionModel: { providerID: "p", id: "vision" } })
      expect(result.fetches).toHaveLength(0)
      expect(result.calls.filter((call) => call.path.endsWith("/prompt"))).toHaveLength(0)
      expect(result.state?.budgetReservation).toBeUndefined()
      const switched = result.calls.find((call) => call.path.endsWith("/model"))?.body as { model?: { id?: string } } | undefined
      expect(switched?.model?.id).toBe(key === "override" ? "text" : "text")
    }
  })

  it("uses a vision override on a restored nonvision session and the default for a fresh session", async () => {
    const restored = env.CONVERSATION.getByName("slack-image-restored-override")
    await seed(restored, { sessionID: "ses_image", modelOverride: "p/vision" })
    const switched = await sendImage(restored, { eventID: "restored-vision", sessionModel: { providerID: "p", id: "text" } })
    expect(switched.fetches).toHaveLength(1)
    expect(switched.calls.filter((call) => call.path.endsWith("/prompt"))).toHaveLength(1)
    expect((switched.calls.find((call) => call.path.endsWith("/prompt"))?.body as { files?: unknown[] }).files).toHaveLength(1)

    await setDefaultModel("p/vision")
    const fresh = env.CONVERSATION.getByName("slack-image-fresh-default")
    await seed(fresh, { modelOverride: undefined })
    const defaulted = await sendImage(fresh, { eventID: "fresh-default" })
    expect(defaulted.fetches).toHaveLength(1)
    expect(defaulted.calls.filter((call) => call.path.endsWith("/prompt"))).toHaveLength(1)
  })

  it("refuses image admission when the established session model is missing or unreadable", async () => {
    for (const [key, extra] of [
      ["missing", { omitSessionModel: true }],
      ["unreadable", { failSessionRead: true }],
    ] as const) {
      const stub = env.CONVERSATION.getByName(`slack-image-model-unknown-${key}`)
      await seed(stub, { sessionID: "ses_image", modelOverride: "p/vision" })
      const result = await sendImage(stub, { eventID: `model-unknown-${key}`, ...extra })
      expect(result.fetches).toHaveLength(0)
      expect(result.calls.filter((call) => call.path.endsWith("/prompt"))).toHaveLength(0)
      expect(result.state?.budgetReservation).toBeUndefined()
      expect(result.posts.join(" ")).toContain("couldn't confirm")
    }
  })

  it("ignores unsafe channel routing and non-file_share subtypes without downloading", async () => {
    const unengaged = env.CONVERSATION.getByName("slack-image-unengaged")
    await seed(unengaged, { slackEngaged: false })
    const ignored = await sendImage(unengaged, { eventID: "unengaged", channelType: "channel", threadTs: "root" })
    expect(ignored.calls).toHaveLength(0)
    expect(ignored.fetches).toHaveLength(0)
    expect(ignored.posts).toHaveLength(0)

    const subtype = env.CONVERSATION.getByName("slack-image-other-subtype")
    await seed(subtype)
    const rejected = await sendImage(subtype, { eventID: "other-subtype", subtype: "message_changed" })
    expect(rejected.calls).toHaveLength(0)
    expect(rejected.fetches).toHaveLength(0)
  })

  it("accepts an image follow-up only in an already-engaged thread", async () => {
    const stub = env.CONVERSATION.getByName("slack-image-engaged-thread")
    await seed(stub, { slackEngaged: true })
    const accepted = await sendImage(stub, {
      eventID: "engaged-thread-image", channelType: "channel", threadTs: "root.1",
    })
    expect(accepted.calls.filter((call) => call.path.endsWith("/prompt"))).toHaveLength(1)
    expect(accepted.fetches).toHaveLength(1)
  })

  it("refuses a busy conversation without downloading or queueing an image caption", async () => {
    const stub = env.CONVERSATION.getByName("slack-image-busy")
    await seed(stub, {
      phase: "running",
      budgetReservation: { reservationID: "keep-existing", dispatched: true },
    })
    const result = await sendImage(stub, { eventID: "busy-image", text: "please describe" })
    expect(result.calls).toHaveLength(0)
    expect(result.fetches).toHaveLength(0)
    expect(result.state?.queued).toBeUndefined()
    expect(result.state?.budgetReservation).toEqual({ reservationID: "keep-existing", dispatched: true })
    expect(result.posts.join(" ")).toContain("didn't send or queue this image")
  })

  it("refuses spoofed image bytes without a prompt, reservation, or queued caption", async () => {
    const stub = env.CONVERSATION.getByName("slack-image-spoofed-mime"); await seed(stub)
    const result = await sendImage(stub, { eventID: "spoofed", text: "caption", downloadBytes: new Uint8Array([0xff, 0xd8, 0xff, 1, 2]) })
    expect(result.calls.filter((call) => call.path.endsWith("/prompt"))).toHaveLength(0)
    expect(result.state?.budgetReservation).toBeUndefined()
    expect(result.state?.queued).toBeUndefined()
    expect(result.posts.join(" ")).toContain("did not match")
  })

  it("refuses missing Slack file credentials before reservation or prompt", async () => {
    const stub = env.CONVERSATION.getByName("slack-image-no-token"); await seed(stub)
    const result = await sendImage(stub, { eventID: "no-token", omitSlackToken: true })
    expect(result.fetches).toHaveLength(0)
    expect(result.calls.filter((call) => call.path.endsWith("/prompt"))).toHaveLength(0)
    expect(result.state?.budgetReservation).toBeUndefined()
    expect(result.state?.queued).toBeUndefined()
    expect(result.posts.join(" ")).toContain("Slack file access is not configured")
  })

  it("forwards signed Slack file_share events with files intact", async () => {
    const received: Array<{ key: string; body: Record<string, unknown> }> = []
    const pending: Promise<unknown>[] = []
    const testEnv = {
      SLACK_SIGNING_SECRET: "test-secret",
      CONVERSATION: { getByName: (key: string) => ({
        fetch: async (input: string | URL | Request, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init)
          received.push({ key, body: await request.clone().json() as Record<string, unknown> })
          return new Response("ok")
        },
      }) },
      SETTINGS: { getByName: () => ({ fetch: async () => new Response("{}") }) },
    } as unknown as Env
    const context = {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      passThroughOnException: () => {},
    } as unknown as ExecutionContext
    const event = {
      type: "message", subtype: "file_share", channel: "D_ROUTE", channel_type: "im", ts: "route.1",
      files: [{ id: "F_ROUTE", mimetype: "image/png", size: png.length, url_private_download: "https://files.slack.com/f/route" }],
    }
    const body = JSON.stringify({ type: "event_callback", team_id: "T_ROUTE", event_id: "route-file", event })
    const timestamp = String(Math.floor(Date.now() / 1000))
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("test-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`))
    const signature = `v0=${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`
    const response = await worker.fetch(new Request("https://test/slack/events", {
      method: "POST", body,
      headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
    }), testEnv, context)
    await Promise.all(pending)
    expect(response.status).toBe(200)
    expect(received).toHaveLength(1)
    expect(received[0]?.key).toBe("D_ROUTE:dm")
    expect(received[0]?.body).toMatchObject({
      eventID: "route-file",
      event: { subtype: "file_share", files: [{ id: "F_ROUTE", url_private_download: "https://files.slack.com/f/route" }] },
    })
  })
})
