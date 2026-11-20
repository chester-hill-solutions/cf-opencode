import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import type { ConversationState } from "../src/state"
import { accountingPolicyConfig, accountingPolicyStart } from "./helpers/accounting-policy"
import { driveConversationJobs } from "./helpers/conversation-jobs"

/**
 * A stored session id is a cache of OpenCode's own database. After a reset or a
 * checkpoint restore without that session, prompts used to fail forever. The
 * harness must verify the session and create a replacement.
 */

function fakeContainer() {
  const prompts = { old: 0, fresh: 0 }
  const transport = (port: number) => ({
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
        if (url.pathname === "/checkpoint") return new Response(null, { status: 204 })
        return json({ error: "not found" }, 404)
      }

      // The old session is gone from this OpenCode database.
      if (url.pathname === "/api/config") return json(accountingPolicyConfig)
      if (url.pathname === "/api/session/ses_old") return json({ error: "not found" }, 404)
      if (url.pathname === "/api/session/ses_old/prompt") {
        prompts.old++
        return json({ error: "not found" }, 404)
      }

      if (url.pathname === "/api/session" && request.method === "POST") {
        return json({ data: { id: "ses_new" } })
      }
      if (url.pathname === "/api/session/ses_new") return json({ data: { id: "ses_new" } })
      if (url.pathname === "/api/session/ses_new/model") return new Response(null, { status: 204 })
      if (url.pathname === "/api/session/ses_new/prompt") {
        prompts.fresh++
        return json({ data: {} })
      }
      if (url.pathname === "/api/session/ses_new/context") return json({ data: [] })
      if (url.pathname === "/api/session/ses_new/permission") return json({ data: [] })
      if (url.pathname === "/api/event") {
        return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } })
      }
      return json({ error: "not found" }, 404)
    },
  })
  return { transport, prompts }
}

describe("session recovery", () => {
  it("replaces a stored session that OpenCode no longer has", async () => {
    const stub = env.CONVERSATION.getByName("C1:session-recovery")
    const result = await runInDurableObject(stub, async (instance, storage) => {
      await storage.storage.put("state", {
        phase: "idle",
        sessionID: "ses_old",
        seen: [],
        pending: { req_old: "ses_old" },
      })
      const fake = fakeContainer()
      instance.transport = fake.transport

      const response = await instance.fetch(
        new Request("https://conversation/message", {
          method: "POST",
          body: JSON.stringify({ text: "hello" }),
        }),
      )
      const body = (await response.json()) as { sessionID?: string }
      const state = (await (
        await instance.fetch(new Request("https://conversation/state"))
      ).json()) as { sessionID?: string; pending?: Record<string, string> }
      return { status: response.status, body, state, prompts: fake.prompts }
    })

    expect(result.status).toBe(200)
    expect(result.body.sessionID).toBe("ses_new")
    expect(result.state.sessionID).toBe("ses_new")
    expect(result.state.pending).toEqual({})
    expect(result.prompts.fresh).toBe(1)
    expect(result.prompts.old).toBe(0)
  })
})

/**
 * A turn dispatched to a session the runtime has since lost can never settle:
 * every observation retries, re-prepares a container and renews its lease. The
 * observation itself must close the turn and stop looking.
 */

function lostSessionContainer(observed: { context: number; permission: number }) {
  return (port: number) => ({
    async fetch(input: Request | string | URL): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input)
      const url = new URL(request.url)
      const json = (body: unknown, status = 200) => Response.json(body, { status })
      if (port === 4001) {
        if (url.pathname === "/status") return json({ initialized: true })
        if (url.pathname === "/start") return json(accountingPolicyStart)
        if (url.pathname === "/configure") return json({ ok: true })
        return json({ error: "not found" }, 404)
      }
      if (url.pathname === "/api/config") return json(accountingPolicyConfig)
      if (url.pathname === "/api/session/ses_lost/context") {
        observed.context += 1
        return json({ data: { message: "Session not found" } }, 404)
      }
      if (url.pathname === "/api/session/ses_lost/permission") {
        observed.permission += 1
        return json({ data: { message: "Session not found" } }, 404)
      }
      return json({ data: {} })
    },
  })
}

async function startLegacyJobs(
  instance: { fetch(request: Request): Promise<Response>; alarm(): Promise<void> },
  storage: DurableObjectStorage,
): Promise<void> {
  await storage.setAlarm(Date.now() - 1)
  await (await instance.fetch(new Request("https://conversation/state"))).text()
  await instance.alarm()
}

describe("a turn whose session the runtime lost", () => {
  it("settles the turn, drops its orphaned prompts and stops observing", async () => {
    const stub = env.CONVERSATION.getByName("C1:session-lost-observe")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      const observed = { context: 0, permission: 0 }
      instance.transport = lostSessionContainer(observed)
      await runtime.storage.put("state", {
        phase: "running",
        runStartedAt: Date.now() - 5_000,
        sessionID: "ses_lost",
        turnID: "turn-lost",
        seen: [],
        pending: { perm_lost: "ses_lost" },
      } satisfies ConversationState)
      await startLegacyJobs(instance, runtime.storage)
      await driveConversationJobs(instance, runtime.storage, ["turn:observe"])
      const state = await runtime.storage.get<ConversationState>("state")
      const job = runtime.storage.sql.exec<{ id: string }>(
        "SELECT id FROM cf_agents_jobs WHERE id = ?",
        "turn:observe",
      ).toArray()[0]
      return { state, job, observed }
    })
    expect(result.observed.context).toBeGreaterThan(0)
    expect(result.state?.phase).toBe("idle")
    expect(result.state?.turnID).toBeUndefined()
    expect(result.state?.pending).toEqual({})
    expect(result.state?.lastTurnError).toContain("no longer knows this session")
    // A settled turn owes no observation: no retry row may survive it.
    expect(result.job).toBeUndefined()
  })

  it("retains a dispatched reservation for an operator instead of re-observing", async () => {
    const stub = env.CONVERSATION.getByName("C1:session-lost-retained")
    const result = await runInDurableObject(stub, async (instance, runtime) => {
      instance.transport = lostSessionContainer({ context: 0, permission: 0 })
      await runtime.storage.put("state", {
        phase: "running",
        runStartedAt: Date.now() - 5_000,
        sessionID: "ses_lost",
        seen: [],
        pending: {},
        budgetReservation: { reservationID: "hold-lost", date: "2026-11-14", dispatched: true },
      } satisfies ConversationState)
      await startLegacyJobs(instance, runtime.storage)
      await driveConversationJobs(instance, runtime.storage, ["turn:observe"])
      const job = runtime.storage.sql.exec<{ id: string }>(
        "SELECT id FROM cf_agents_jobs WHERE id = ?",
        "turn:observe",
      ).toArray()[0]
      return { state: await runtime.storage.get<ConversationState>("state"), job }
    })
    // The spend was dispatched and cannot be measured, so an operator retires it.
    expect(result.state?.budgetReservation?.reservationID).toBe("hold-lost")
    expect(result.state?.settlementError).toContain("reservation retained")
    expect(result.state?.phase).toBe("running")
    expect(result.job).toBeUndefined()
  })
})
