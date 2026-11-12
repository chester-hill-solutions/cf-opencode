import { beforeEach, describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"
import { usageLogResponse } from "./helpers/usage-log"
import { driveConversationJobs } from "./helpers/conversation-jobs"

/**
 * A failed turn must be visible in the thread. Error events used to go to SSE
 * only, so Slack users saw a hanging conversation.
 */

function fakeContainer(promptFailure = false, counters = { prompts: 0 }) {
  let prompted = false
  return (port: number) => ({
    async fetch(input: Request | string | URL): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input)
      const url = new URL(request.url)
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        })

      if (port === 4001) {
        if (url.pathname === "/status") return json({ initialized: true })
        if (url.pathname === "/configure") return json({ ok: true })

        if (url.pathname === "/start") return json(accountingPolicyStart)
        if (url.pathname === "/checkpoint") {
          const part = url.searchParams.get("part")
          if (part === "state") {
            return new Response(new Uint8Array([4]), {
              headers: {
                "content-type": "application/gzip",
                "content-length": "1",
                "x-state-fingerprint": "state-fp",
              },
            })
          }
          return new Response(new Uint8Array([1, 2, 3]), {
            headers: {
              "content-type": "application/gzip",
              "content-length": "3",
              "x-workspace-fingerprint": "workspace-fp",
              "x-aboiteau-checkpoint": "split",
            },
          })
        }
        return json({ error: "not found" }, 404)
      }

      if (url.pathname === "/api/config") return json(accountingPolicyConfig)

      if (url.pathname === "/api/session") return json({ data: { id: "ses_1" } })
      if (url.pathname === "/api/session/ses_1") return json({ data: { id: "ses_1" } })
      if (url.pathname === "/api/session/ses_1/model") return new Response(null, { status: 204 })
      if (url.pathname === "/api/session/ses_1/prompt") {
        prompted = true
        counters.prompts++
        if (promptFailure) throw new Error("connection reset after dispatch")
        return json({ data: {} })
      }
      if (url.pathname === "/api/session/ses_1/context") {
        return json({
          data: prompted
            ? [
                { id: "u1", type: "user", content: [{ type: "text", text: "hello" }] },
                {
                  id: "a1",
                  type: "assistant",
                  time: { created: Date.now(), completed: Date.now() },
                  finish: "error",
                  error: { message: "provider unavailable" },
                  content: [],
                },
              ]
            : [],
        })
      }
      if (url.pathname === "/api/session/ses_1/permission") return json({ data: [] })
      if (url.pathname === "/api/event") {
        return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } })
      }
      return json({ error: "not found" }, 404)
    },
  })
}

async function clearBudgetState(): Promise<void> {
  const stub = env.SETTINGS.getByName("global")
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.deleteAll()
  })
  await stub.fetch("https://settings/put", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dailyBudgetUSD: 0, streaming: false }),
  })
}

describe("Slack failure delivery", () => {
  beforeEach(clearBudgetState)

  it("posts a turn error to the Slack thread", async () => {
    const stub = env.CONVERSATION.getByName("C1:slack-error")
    const result = await runInDurableObject(stub, async (instance, state) => {
      instance.transport = fakeContainer()
      const posts: Array<{ method: string; body: Record<string, unknown> }> = []
      ;(instance as unknown as { slackAdapter: { slack: unknown } }).slackAdapter.slack = async (
        method: string,
        body: Record<string, unknown>,
      ) => {
        posts.push({ method, body })
        return { ok: true }
      }

      const response = await instance.fetch(
        new Request("https://conversation/slack", {
          method: "POST",
          body: JSON.stringify({
            eventID: "evt_error",
            replyTs: "1",
            event: { type: "app_mention", channel: "C1", ts: "1", text: "<@UBOT> hello" },
          }),
        }),
      )
      await response.text()
      await driveConversationJobs(instance, state.storage, ["turn:observe"])
      return posts
    })

    expect(result.some((post) => post.method === "chat.postMessage")).toBe(true)
    expect(
      result.some((post) => String(post.body.text ?? "").includes("provider unavailable")),
    ).toBe(true)
  })

  it("retains a possibly dispatched Slack prompt instead of queueing it again", async () => {
    const stub = env.CONVERSATION.getByName("C1:slack-prompt-loss")
    const result = await runInDurableObject(stub, async (instance) => {
      const counters = { prompts: 0 }
      instance.transport = fakeContainer(true, counters)
      const posts: string[] = []
      ;(instance as unknown as { slackAdapter: { slack: unknown } }).slackAdapter.slack = async (
        _method: string,
        body: Record<string, unknown>,
      ) => {
        posts.push(String(body.text ?? ""))
        return { ok: true }
      }
      const response = await instance.fetch(
        new Request("https://conversation/slack", {
          method: "POST",
          body: JSON.stringify({
            eventID: "evt_slack_prompt_loss",
            replyTs: "1",
            event: { type: "app_mention", channel: "C1", ts: "2", text: "<@UBOT> hello" },
          }),
        }),
      )
      const state = await (await instance.fetch(new Request("https://conversation/state"))).json() as {
        phase?: string
        queued?: unknown
        budgetReservation?: { dispatched?: boolean }
      }
      return { status: response.status, state, prompts: counters.prompts, posts }
    })
    const usage = await (await env.SETTINGS.getByName("global").fetch("https://settings/usage/today"))
      .json() as { reservedUSD?: number }

    expect(result.status).toBe(200)
    expect(result.prompts).toBe(1)
    expect(result.state.phase).toBe("running")
    expect(result.state.queued).toBeUndefined()
    expect(result.state.budgetReservation).toMatchObject({ dispatched: true })
    expect(result.posts.some((text) => text.includes("outcome is unknown"))).toBe(true)
    expect(usage.reservedUSD).toBe(0.1)
  })

  it("fails closed on a reservation conflict and tells the Slack user", async () => {
    const stub = env.CONVERSATION.getByName("C1:slack-budget-conflict")
    const conversationID = await runInDurableObject(stub, async (_instance, state) => state.id.toString())
    await runInDurableObject(env.SETTINGS.getByName("global"), async (_instance, state) => {
      await state.storage.put(`usage:2020-01-01:reserve:${conversationID}`, {
        costUSD: 0.1,
        reserved: true,
      })
    })

    const result = await runInDurableObject(stub, async (instance) => {
      const counters = { prompts: 0 }
      instance.transport = fakeContainer(false, counters)
      const posts: string[] = []
      ;(instance as unknown as { slackAdapter: { slack: unknown } }).slackAdapter.slack = async (
        _method: string,
        body: Record<string, unknown>,
      ) => {
        posts.push(String(body.text ?? ""))
        return { ok: true }
      }
      const response = await instance.fetch(
        new Request("https://conversation/slack", {
          method: "POST",
          body: JSON.stringify({
            eventID: "evt_slack_budget_conflict",
            replyTs: "1",
            event: { type: "app_mention", channel: "C1", ts: "3", text: "<@UBOT> hello" },
          }),
        }),
      )
      return { status: response.status, prompts: counters.prompts, posts }
    })

    expect(result.status).toBe(200)
    expect(result.prompts).toBe(0)
    expect(result.posts.some((text) => text.includes("legacy reservation") && text.includes("No prompt was sent"))).toBe(true)
  })

  it("keeps the pre-dispatch timestamp when a provider error predates prompt response", async () => {
    const stub = env.CONVERSATION.getByName("C1:immediate-provider-error")
    let idleAt = 0
    let promptCount = 0
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      instance.transport = (port) => ({
        async fetch(input) {
          const request = input instanceof Request ? input : new Request(input)
          const url = new URL(request.url)
          const json = (body: unknown) => Response.json(body)
          if (port === 4001) {
            if (url.pathname === "/status") return json({ initialized: true })
            if (url.pathname === "/configure") return json({ ok: true })
            if (url.pathname === "/start") return json(accountingPolicyStart)
            return json({ error: "not found" })
          }
          if (url.pathname === "/api/config") return json(accountingPolicyConfig)
          if (url.pathname === "/api/session") return json({ data: { id: "ses_1" } })
          if (url.pathname === "/api/session/ses_1/model") return new Response(null, { status: 204 })
          if (url.pathname === "/api/session/ses_1/prompt") {
            promptCount++
            idleAt = Date.now()
            // Model the provider returning an idle failure before the HTTP
            // request resolves to the harness.
            await new Promise((resolve) => setTimeout(resolve, 25))
            return json({ data: {} })
          }
          if (url.pathname === "/api/session/ses_1/context") {
            return json({ data: idleAt ? [
              { id: "idle-now", type: "idle", time: { created: idleAt }, error: { message: "provider rejected request" } },
            ] : [] })
          }
          if (url.pathname === "/api/session/ses_1/permission") return json({ data: [] })
          if (url.pathname === "/api/session/ses_1/form") return json({ data: [] })
          if (url.pathname === "/api/experimental/session/ses_1/log") {
            return usageLogResponse(request, "ses_1", [])
          }
          return json({ error: "not found" })
        },
      })
      const response = await instance.fetch(new Request("https://conversation/message", {
        method: "POST", body: JSON.stringify({ text: "hello" }),
      }))
      await response.text()
      await driveConversationJobs(instance, runtime.storage, ["turn:observe"])
      const state = await (await instance.fetch(new Request("https://conversation/state"))).json() as {
        phase?: string
        runStartedAt?: number
        budgetReservation?: { dispatched?: boolean }
        lastTurnError?: string
      }
      return { state, status: response.status }
    })
    const usage = await (await env.SETTINGS.getByName("global").fetch("https://settings/usage/today")).json() as {
      reservedUSD?: number
      costUSD?: number
    }

    expect(result.status).toBe(200)
    expect(promptCount).toBe(1)
    expect(result.state.runStartedAt).toBeLessThanOrEqual(idleAt)
    expect(result.state.phase).toBe("settling")
    expect(result.state.budgetReservation).toMatchObject({ dispatched: true })
    expect(result.state.lastTurnError).toContain("provider rejected request")
    expect(usage).toMatchObject({ costUSD: 0, reservedUSD: 0.1 })
  })
})
