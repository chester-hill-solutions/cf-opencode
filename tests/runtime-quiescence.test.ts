import { describe, expect, test } from "bun:test"
import type { FormDetail, FormInfo, PermissionRequestListOutput, SessionInfo, SessionMessageInfo } from "@opencode/client"
import {
  proveRuntimeQuiescence,
  RuntimeQuiescenceError,
  type RuntimeQuiescenceClient,
} from "../src/runtime-quiescence"
import { hashOperatorQuiescence } from "../src/operator-reconciliation"

type ClientOptions = {
  wait?: () => Promise<void>
  session?: unknown
  context?: unknown
  inbox?: unknown
  permissions?: unknown
  forms?: unknown
  formDetails?: Record<string, unknown>
  fail?: string
  afterWait?: () => void
}

function fakeClient(options: ClientOptions = {}) {
  const calls: string[] = []
  const requireWait = () => {
    if (options.afterWait && !waitFinished) throw new Error("native work not drained")
  }
  let waitFinished = false
  const client = {
    experimental: { session: { wait: async (_input: unknown, requestOptions?: { signal?: AbortSignal }) => {
      calls.push("wait")
      if (!requestOptions?.signal) throw new Error("missing timeout signal")
      if (options.fail === "wait") throw new Error("wait failed")
      await options.wait?.()
      options.afterWait?.()
      waitFinished = true
    } } },
    session: {
      get: async () => { calls.push("session.get"); requireWait(); if (options.fail === "session") throw new Error("session failed"); return options.session ?? { id: "ses_1", location: { directory: "/workspace" } } },
      context: async () => { calls.push("context"); requireWait(); if (options.fail === "context") throw new Error("context failed"); return options.context ?? [{ id: "msg1", type: "assistant", time: { created: 1 }, content: [{ type: "text", text: "hello" }] }] },
      inbox: { list: async () => { calls.push("inbox"); requireWait(); if (options.fail === "inbox") throw new Error("inbox failed"); return options.inbox ?? [] } },
      form: {
        list: async () => { calls.push("forms.list"); requireWait(); if (options.fail === "forms") throw new Error("forms failed"); return options.forms ?? [] },
        get: async ({ formID }: { formID: string }) => { calls.push(`forms.get:${formID}`); requireWait(); if (options.fail === "form.get") throw new Error("form failed"); return options.formDetails?.[formID] ?? { id: formID, sessionID: "ses_1", state: { status: "answered" } } },
      },
    },
    permission: { request: { list: async () => {
      calls.push("permissions")
      requireWait()
      if (options.fail === "permissions") throw new Error("permissions failed")
      return options.permissions ?? { data: [] }
    } } },
  } as unknown as RuntimeQuiescenceClient
  return { client, calls }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe("proveRuntimeQuiescence", () => {
  test("waits for native cleanup before reading session and proves an empty session", async () => {
    const gate = deferred<void>()
    let waitStarted!: () => void
    const started = new Promise<void>((resolve) => { waitStarted = resolve })
    const { client, calls } = fakeClient({
      wait: async () => { waitStarted(); await gate.promise },
      afterWait: () => {},
      forms: [{ id: "f1", sessionID: "ses_1" }],
      formDetails: { f1: { id: "f1", sessionID: "ses_1", state: { status: "answered" } } },
    })
    const resultPromise = proveRuntimeQuiescence({ client, sessionID: "ses_1", getRuntimeGeneration: async () => "gen-7" })
    await started
    expect(calls).toEqual(["wait"])
    gate.resolve()
    const result = await resultPromise
    expect(calls).toEqual(["wait", "session.get", "context", "inbox", "permissions", "forms.list", "forms.get:f1"])
    expect(result.proof).toMatchObject({
      sessionID: "ses_1", runtimeGeneration: "gen-7", waited: true,
      inboxEmpty: true, permissionsEmpty: true, formsEmpty: true,
    })
    expect(result.proof.contextDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(result.digest).toBe(await hashOperatorQuiescence(result.proof))
    expect(result.session.id).toBe("ses_1")
    expect(result.context).toHaveLength(1)
  })

  test("rejects a runtime generation change across the proof", async () => {
    const { client } = fakeClient()
    let read = 0
    await expect(proveRuntimeQuiescence({
      client,
      sessionID: "ses_1",
      getRuntimeGeneration: async () => (++read === 1 ? "gen-a" : "gen-b"),
    })).rejects.toThrow("runtime generation changed")
  })

  test("fails closed on nonempty inbox, session permission, and pending form", async () => {
    const cases: ClientOptions[] = [
      { inbox: [{ id: "inbox1", sessionID: "ses_1", type: "user" }] },
      { permissions: { data: [{ id: "perm1", sessionID: "ses_1", action: "shell", resources: [] }] } },
      { forms: [{ id: "form1", sessionID: "ses_1" }], formDetails: { form1: { id: "form1", sessionID: "ses_1", state: { status: "pending" } } } },
    ]
    const expected = ["inbox is not empty", "pending permission", "pending form"]
    for (let i = 0; i < cases.length; i++) {
      const { client } = fakeClient(cases[i])
      await expect(proveRuntimeQuiescence({ client, sessionID: "ses_1", getRuntimeGeneration: async () => "gen" }))
        .rejects.toThrow(expected[i])
    }
  })

  test("rejects unreadable or mismatched session and unreadable native evidence", async () => {
    const cases: Array<[ClientOptions, string]> = [
      [{ session: { id: "ses_other", location: { directory: "/workspace" } } }, "did not match"],
      [{ fail: "context" }, "native quiescence evidence"],
      [{ fail: "inbox" }, "native quiescence evidence"],
      [{ fail: "permissions" }, "native quiescence evidence"],
      [{ fail: "forms" }, "native quiescence evidence"],
      [{ fail: "form.get", forms: [{ id: "f1", sessionID: "ses_1" }] }, "native quiescence evidence"],
    ]
    for (const [options, message] of cases) {
      const { client } = fakeClient(options)
      await expect(proveRuntimeQuiescence({ client, sessionID: "ses_1", getRuntimeGeneration: async () => "gen" }))
        .rejects.toThrow(message)
    }
  })

  test("times out a hung native wait and honors caller cancellation", async () => {
    const { client } = fakeClient({ wait: () => new Promise<void>(() => {}) })
    await expect(proveRuntimeQuiescence({
      client, sessionID: "ses_1", timeoutMs: 5, getRuntimeGeneration: async () => "gen",
    })).rejects.toBeInstanceOf(RuntimeQuiescenceError)

    const controller = new AbortController()
    controller.abort()
    await expect(proveRuntimeQuiescence({
      client, sessionID: "ses_1", signal: controller.signal, getRuntimeGeneration: async () => "gen",
    })).rejects.toThrow("cancelled")
  })

  test("requires a nonempty generation and matching proof session", async () => {
    const { client } = fakeClient()
    await expect(proveRuntimeQuiescence({ client, sessionID: "ses_1", getRuntimeGeneration: async () => " " }))
      .rejects.toThrow("generation is unavailable")
    await expect(proveRuntimeQuiescence({ client, sessionID: " ", getRuntimeGeneration: async () => "gen" }))
      .rejects.toThrow("session id is required")
  })
})
