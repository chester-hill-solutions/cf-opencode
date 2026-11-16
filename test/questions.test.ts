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
