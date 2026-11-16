import { describe, expect, it } from "vitest"
import { env, runInDurableObject, SELF } from "cloudflare:test"
import { ConversationControlPlane } from "../src/conversation/control-plane"
import { ConversationStore } from "../src/state"
import { projectQuestions } from "../src/questions"
import type { Form } from "../src/slack-forms"
import type { makeClient } from "../src/opencode"

type Client = ReturnType<typeof makeClient>

const form = {
  id: "form-1",
  sessionID: "ses_q",
  title: "Which branch?",
  // The runtime adds the pending state the control plane filters on.
  state: { status: "pending" },
  fields: [{
    key: "branch",
    type: "string",
    options: [{ value: "main", label: "main" }, { value: "next", label: "next" }],
  }],
} as unknown as Form

const freeTextForm: Form = {
  id: "form-2",
  sessionID: "ses_q",
  title: "Anything else?",
  state: { status: "pending" },
  fields: [{ key: "notes", type: "string" }],
} as unknown as Form

const permission = { id: "perm-1", action: "bash", resources: ["rm -rf build"] }

function fakeClient(input: {
  forms?: Form[]
  permissions?: { id: string; action: string; resources: string[] }[]
  fail?: boolean
  calls?: { count: number }
} = {}) {
  return {
    session: {
      form: {
        list: async () => {
          input.calls && input.calls.count++
          if (input.fail) throw new Error("runtime unavailable")
          return (input.forms ?? []).map((candidate) => ({ id: candidate.id }))
        },
        get: async ({ formID }: { formID: string }) => {
          if (input.fail) throw new Error("runtime unavailable")
          const found = (input.forms ?? []).find((candidate) => candidate.id === formID)
          if (!found) throw new Error("missing form")
          return found
        },
      },
    },
    permission: {
      list: async () => {
        if (input.fail) throw new Error("runtime unavailable")
        return input.permissions ?? []
      },
    },
  } as unknown as Client
}

function controlPlane(runtime: DurableObjectState, client: Client) {
  return new ConversationControlPlane({
    storage: runtime.storage,
    store: new ConversationStore(runtime.storage),
    withClient: async <T>(fn: (value: Client) => Promise<T>): Promise<T> => fn(client),
    withWarmClient: async <T>(fn: (value: Client) => Promise<T>): Promise<T> => fn(client),
    withAdmissionLock: async <T>(task: () => Promise<T>) => task(),
    hasPendingRuntimeUpgrade: async () => false,
    scheduleObservation: async () => {},
  })
}

describe("question projection", () => {
  it("describes forms and permissions the same way", () => {
    expect(projectQuestions({
      forms: [form],
      permissions: [permission],
      turnID: "turn_1",
    })).toEqual([
      { id: "form-1", kind: "question", prompt: "Which branch?", options: ["main", "next"], turnID: "turn_1" },
      { id: "perm-1", kind: "permission", prompt: "bash: rm -rf build", options: ["once", "always", "reject"], turnID: "turn_1" },
    ])
  })

  it("names fields for a free-text question and keeps the first duplicate", () => {
    const questions = projectQuestions({ forms: [freeTextForm, freeTextForm] })
    expect(questions).toEqual([
      { id: "form-2", kind: "question", prompt: "Anything else?", options: ["notes"] },
    ])
  })
})

describe("GET /questions", () => {
  it("answers from the live runtime while a turn can be blocked", async () => {
    const stub = env.CONVERSATION.getByName("questions:live")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      await runtime.storage.put("state", {
        phase: "running",
        sessionID: "ses_q",
        turnID: "turn_1",
        pending: { "perm-1": "ses_q", "perm-other": "ses_other" },
      })
      const control = controlPlane(runtime, fakeClient({ forms: [form], permissions: [permission] }))
      const response = await control.onQuestions()
      return { status: response.status, body: await response.json() }
    })

    expect(result.status).toBe(200)
    expect(result.body).toEqual({
      questions: [
        { id: "form-1", kind: "question", prompt: "Which branch?", options: ["main", "next"], turnID: "turn_1" },
        { id: "perm-1", kind: "permission", prompt: "bash: rm -rf build", options: ["once", "always", "reject"], turnID: "turn_1" },
      ],
    })
  })

  it("does not touch the runtime when no turn can be blocked", async () => {
    const stub = env.CONVERSATION.getByName("questions:idle")
    const calls = { count: 0 }
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      await runtime.storage.put("state", { phase: "idle", sessionID: "ses_q", pending: {} })
      const control = controlPlane(runtime, fakeClient({ forms: [form], calls }))
      const response = await control.onQuestions()
      return { status: response.status, body: await response.json() }
    })

    expect(result).toEqual({ status: 200, body: { questions: [] } })
    expect(calls.count).toBe(0)
  })

  it("reports unreadable runtime state as 503, never an empty list", async () => {
    const stub = env.CONVERSATION.getByName("questions:down")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      await runtime.storage.put("state", { phase: "running", sessionID: "ses_q", pending: {} })
      const control = controlPlane(runtime, fakeClient({ fail: true }))
      const response = await control.onQuestions()
      return { status: response.status, body: await response.json() }
    })

    expect(result.status).toBe(503)
    expect(result.body).toEqual({ error: "questions_unavailable" })
  })

  it("serves the public route without a session", async () => {
    const response = await SELF.fetch("https://harness.test/api/conversations/questions:none/questions", {
      headers: { authorization: "Bearer test-token" },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ questions: [] })
  })
})

describe("POST /questions/:id", () => {
  function answeringPlane(runtime: DurableObjectState, client: Client) {
    return new ConversationControlPlane({
      storage: runtime.storage,
      store: new ConversationStore(runtime.storage),
      withClient: async <T>(fn: (value: Client) => Promise<T>): Promise<T> => fn(client),
      withWarmClient: async <T>(fn: (value: Client) => Promise<T>): Promise<T> => fn(client),
      withAdmissionLock: async <T>(task: () => Promise<T>) => task(),
      hasPendingRuntimeUpgrade: async () => false,
      scheduleObservation: async () => {},
    })
  }

  function clientWith(calls: { replies: number; forms: number }, formResult: () => Promise<Form | never>): Client {
    return {
      permission: {
        reply: async () => { calls.replies++ },
        list: async () => [],
      },
      session: {
        form: {
          list: async () => [],
          get: formResult,
          reply: async () => { calls.forms++ },
          cancel: async () => {},
        },
      },
    } as unknown as Client
  }

  it("answers a permission once and reports the second answer as not pending", async () => {
    const stub = env.CONVERSATION.getByName("questions:answer-permission")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      const calls = { replies: 0, forms: 0 }
      await runtime.storage.put("state", {
        phase: "running", sessionID: "ses_q", turnID: "turn_1",
        pending: { "perm-1": "ses_q", "perm-other": "ses_other" },
      })
      const control = answeringPlane(runtime, clientWith(calls, async () => { throw new Error("not a form") }))
      const first = await control.answerQuestion("perm-1", { decision: "once" })
      const second = await control.answerQuestion("perm-1", { decision: "once" })
      const foreign = await control.answerQuestion("perm-other", { decision: "once" })
      const invalid = await control.answerQuestion("perm-1", {})
      return {
        first: first.status,
        second: { status: second.status, body: await second.json() },
        foreign: { status: foreign.status, body: await foreign.json() },
        invalid: invalid.status,
        replies: calls.replies,
      }
    })

    expect(result.first).toBe(204)
    expect(result.second).toEqual({ status: 409, body: { error: "not_pending" } })
    expect(result.foreign).toEqual({ status: 409, body: { error: "foreign_turn" } })
    expect(result.invalid).toBe(400)
    // The foreign request never reached the runtime.
    expect(result.replies).toBe(1)
  })

  it("answers a form question and reports a resolved form as not pending", async () => {
    const stub = env.CONVERSATION.getByName("questions:answer-form")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      const calls = { replies: 0, forms: 0 }
      await runtime.storage.put("state", { phase: "running", sessionID: "ses_q", turnID: "turn_1", pending: {} })
      let pending = true
      const client = clientWith(calls, async () => {
        if (!pending) throw new Error("This question is no longer waiting for an answer.")
        return form
      })
      const control = answeringPlane(runtime, client)
      const first = await control.answerQuestion("form-1", { answer: { branch: "main" } })
      pending = false
      const second = await control.answerQuestion("form-1", { answer: { branch: "main" } })
      return {
        first: first.status,
        second: { status: second.status, body: await second.json() },
        forms: calls.forms,
      }
    })

    expect(result.first).toBe(204)
    expect(result.second).toEqual({ status: 409, body: { error: "not_pending" } })
    expect(result.forms).toBe(1)
  })

  it("requires a token on the public answer route", async () => {
    const response = await SELF.fetch("https://harness.test/api/conversations/questions:none/questions/perm-1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "once" }),
    })
    expect(response.status).toBe(401)
  })

  it("reports a conversation with no session as stale", async () => {
    const response = await SELF.fetch("https://harness.test/api/conversations/questions:stale/questions/perm-1", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ decision: "once" }),
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "stale" })
  })
})
