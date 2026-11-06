import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"

/**
 * Checkpoint interlock: archiving pauses OpenCode. The DO must stop reusing its
 * cached port afterwards, and must not restart it for a no-op checkpoint.
 */

function fakeContainer(options: { killOnCheckpoint: boolean }) {
  let down = false
  let prompted = false
  const counters = { starts: 0, promptOK: 0, promptFail: 0, checkpoints: 0 }
  const transport = (port: number) => ({
    async fetch(input: Request | string | URL): Promise<Response> {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

      if (port === 4001) {
        if (url.pathname === "/status") return json({ initialized: true })
        if (url.pathname === "/configure") return json({ ok: true })
        if (url.pathname === "/start") {
          counters.starts++
          down = false
          return json({ ok: true })
        }
        if (url.pathname === "/checkpoint") {
          counters.checkpoints++
          if (!options.killOnCheckpoint) return new Response(null, { status: 204 })
          down = true
          return new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: {
              "x-workspace-fingerprint": "fp1",
              "content-type": "application/gzip",
              "content-length": "3",
            },
          })
        }
        return json({ error: "not found" }, 404)
      }

      if (url.pathname === "/api/session") return json({ data: { id: "ses_1" } })
      if (url.pathname === "/api/session/ses_1/model") return new Response(null, { status: 204 })
      if (url.pathname === "/api/session/ses_1/prompt") {
        if (down) {
          counters.promptFail++
          return json({ error: "opencode not running" }, 500)
        }
        counters.promptOK++
        prompted = true
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
                  time: { created: 1, completed: 2 },
                  finish: "stop",
                  content: [{ type: "text", text: "done" }],
                },
              ]
            : [],
        })
      }
      if (url.pathname === "/api/session/ses_1/permission") return json({ data: [] })
      if (url.pathname === "/api/event") return new Response("", { status: 200 })
      return json({ error: "not found" }, 404)
    },
  })
  return { transport, counters }
}

async function send(instance: { fetch(request: Request): Promise<Response> }, text: string) {
  const response = await instance.fetch(
    new Request("https://conversation/message", { method: "POST", body: JSON.stringify({ text }) }),
  )
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function state(instance: { fetch(request: Request): Promise<Response> }) {
  const response = await instance.fetch(new Request("https://conversation/state"))
  return (await response.json()) as { queued?: unknown; phase?: string }
}

describe("checkpoint and the opencode port", () => {
  it("restarts opencode after an archived checkpoint without queueing the next turn", async () => {
    const stub = env.CONVERSATION.getByName("C1:checkpoint-archived")
    await runInDurableObject(stub, async (instance) => {
      const fake = fakeContainer({ killOnCheckpoint: true })
      instance.transport = fake.transport

      const first = await send(instance, "hello")
      expect(first.status).toBe(200)
      await instance.alarm()
      expect(fake.counters.checkpoints).toBe(1)

      const second = await send(instance, "again")
      expect(second.status).toBe(200)
      expect(second.body).not.toHaveProperty("queued")
      expect(fake.counters.promptFail).toBe(0)
      expect(fake.counters.promptOK).toBe(2)
      // First container start, then a restart after the archive.
      expect(fake.counters.starts).toBe(2)
      expect((await state(instance)).queued).toBeUndefined()
    })
  })

  it("keeps the warm port when the checkpoint is a no-op", async () => {
    const stub = env.CONVERSATION.getByName("C1:checkpoint-skipped")
    await runInDurableObject(stub, async (instance) => {
      const fake = fakeContainer({ killOnCheckpoint: false })
      instance.transport = fake.transport

      const first = await send(instance, "hello")
      expect(first.status).toBe(200)
      await instance.alarm()
      expect(fake.counters.checkpoints).toBe(1)

      const second = await send(instance, "again")
      expect(second.status).toBe(200)
      expect(fake.counters.promptFail).toBe(0)
      expect(fake.counters.promptOK).toBe(2)
      expect(fake.counters.starts).toBe(1)
    })
  })
})
