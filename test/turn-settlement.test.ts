import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"

/**
 * Turn settlement: a new user message must not be considered finished just
 * because an earlier assistant message completed. The baseline is the last
 * assistant id from before the prompt.
 */

interface Message {
  id: string
  type: "user" | "assistant"
  content?: Array<{ type: string; text: string }>
  time?: { created?: number; completed?: number }
  finish?: string
}

function fakeContainer(options: {
  beforePrompt: Message[]
  afterPrompt: () => Message[]
  checkpoints?: { count: number }
}) {
  let prompted = false
  return (port: number) => ({
    async fetch(input: Request | string | URL): Promise<Response> {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

      if (port === 4001) {
        if (url.pathname === "/status") return json({ initialized: true })
        if (url.pathname === "/configure" || url.pathname === "/start") return json({ ok: true })
        if (url.pathname === "/checkpoint") {
          if (options.checkpoints) options.checkpoints.count++
          return new Response(null, { status: 204 })
        }
        return json({ error: "not found" }, 404)
      }

      if (url.pathname === "/api/session") return json({ data: { id: "ses_1" } })
      if (url.pathname === "/api/session/ses_1/model") return new Response(null, { status: 204 })
      if (url.pathname === "/api/session/ses_1/prompt") {
        prompted = true
        return json({ data: {} })
      }
      if (url.pathname === "/api/session/ses_1/context") {
        return json({ data: prompted ? options.afterPrompt() : options.beforePrompt })
      }
      if (url.pathname === "/api/session/ses_1/permission") return json({ data: [] })
      if (url.pathname === "/api/event") return new Response("", { status: 200 })
      return json({ error: "not found" }, 404)
    },
  })
}

async function state(instance: { fetch(request: Request): Promise<Response> }) {
  const response = await instance.fetch(new Request("https://conversation/state"))
  return (await response.json()) as { phase?: string; lastReply?: string; pending?: Record<string, string> }
}

const user = (id: string, text: string): Message => ({
  id,
  type: "user",
  content: [{ type: "text", text }],
})

const assistant = (id: string, text: string, finish = "stop"): Message => ({
  id,
  type: "assistant",
  content: [{ type: "text", text }],
  time: { created: 1, completed: 2 },
  finish,
})

describe("turn settlement", () => {
  it("keeps an unanswered turn running until its own assistant completes", async () => {
    const stub = env.CONVERSATION.getByName("C1:unanswered")
    await runInDurableObject(stub, async (instance) => {
      const old = assistant("a_old", "first answer")
      const messages: Message[] = [user("u1", "one"), old]
      instance.transport = fakeContainer({
        beforePrompt: messages,
        afterPrompt: () => messages,
      })

      const sent = await instance.fetch(
        new Request("https://conversation/message", { method: "POST", body: JSON.stringify({ text: "two" }) }),
      )
      await sent.text()
      expect(sent.status).toBe(200)

      // The new user message is in history, but the model has not answered it.
      messages.push(user("u2", "two"))
      await instance.alarm()
      expect(await state(instance)).toMatchObject({ phase: "running" })
      expect((await state(instance)).lastReply).toBeUndefined()

      // The model now answers this turn.
      messages.push(assistant("a_new", "second answer"))
      await instance.alarm()
      expect(await state(instance)).toMatchObject({ phase: "idle", lastReply: "second answer" })
    })
  })

  it("settles once, even if a late alarm arrives", async () => {
    const stub = env.CONVERSATION.getByName("C1:settle-once")
    await runInDurableObject(stub, async (instance) => {
      const checkpoints = { count: 0 }
      const messages: Message[] = [user("u1", "hello")]
      const answers: Message[] = [...messages, assistant("a1", "done")]
      instance.transport = fakeContainer({
        beforePrompt: messages,
        afterPrompt: () => answers,
        checkpoints,
      })

      const sent = await instance.fetch(
        new Request("https://conversation/message", { method: "POST", body: JSON.stringify({ text: "hello" }) }),
      )
      await sent.text()
      await instance.alarm()
      expect(await state(instance)).toMatchObject({ phase: "idle", lastReply: "done" })
      expect(checkpoints.count).toBe(1)

      // An alarm armed by the warm stream must not settle (or checkpoint) again.
      await instance.alarm()
      expect(checkpoints.count).toBe(1)
    })
  })
})
