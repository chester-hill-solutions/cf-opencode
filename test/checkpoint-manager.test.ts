import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { ConversationCheckpoints } from "../src/conversation/checkpoints"
import { ConversationStore } from "../src/state"
import type { ContainerPort } from "../src/opencode"

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function checkpointResponse(value: string): Response {
  const body = new TextEncoder().encode(value)
  return new Response(body, {
    headers: {
      "content-length": String(body.byteLength),
      "x-workspace-fingerprint": value,
    },
  })
}

function managerOptions(
  runtime: DurableObjectState,
  conversationID: string,
  options: {
    archiveEnv?: { VAULT_MASTER_KEY?: string; ALLOW_PLAINTEXT_ARCHIVES?: string }
    getControl: () => Promise<ContainerPort>
    schedule?: (at: number, reason: string) => Promise<void>
  },
) {
  return {
    conversationID,
    workspaceID: "default",
    store: new ConversationStore(runtime.storage),
    storage: runtime.storage,
    bucket: env.CHECKPOINTS,
    archiveEnv: options.archiveEnv ?? { ALLOW_PLAINTEXT_ARCHIVES: "1" },
    getControl: options.getControl,
    retry: {
      schedule: options.schedule ?? (async () => {}),
      cancel: async () => {},
    },
    count: async () => {},
    deliverError: async () => {},
  }
}

describe("ConversationCheckpoints publication fence", () => {
  it("serializes concurrent archives through publication and pruning", async () => {
    const stub = env.CONVERSATION.getByName("C1:checkpoint-manager-concurrent")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      const id = runtime.id.toString()
      const enteredFirst = deferred()
      const releaseFirst = deferred()
      const entries: Array<{ call: number; publishedAtEntry?: string }> = []
      let calls = 0
      const options = managerOptions(runtime, id, {
        getControl: async () => ({
          fetch: async () => {
            const call = ++calls
            const state = await runtime.storage.get<{ checkpointKey?: string }>("state")
            entries.push({ call, publishedAtEntry: state?.checkpointKey })
            if (call === 1) {
              enteredFirst.resolve()
              await releaseFirst.promise
            }
            return checkpointResponse(`archive-${call}`)
          },
        }),
      })
      const checkpoints = new ConversationCheckpoints(options)
      const first = checkpoints.capture()
      await enteredFirst.promise
      const second = checkpoints.capture()

      // Let the second call contend while the first is held inside its control
      // request. The module must not enter the control port or publish early.
      await new Promise((resolve) => setTimeout(resolve, 5))
      const callsWhileBlocked = calls
      const publishedWhileBlocked = await runtime.storage.get<{ checkpointKey?: string }>("state")
      releaseFirst.resolve()
      const firstSaved = await first
      const secondSaved = await second
      const state = await runtime.storage.get<{ checkpointKey?: string; checkpointFingerprint?: string }>("state")
      const objects = await env.CHECKPOINTS.list({ prefix: `workspaces/${id}/` })
      const latest = await checkpoints.latest()
      return {
        callsWhileBlocked,
        publishedWhileBlocked,
        firstSaved,
        secondSaved,
        state,
        entries,
        objects: objects.objects.map((object) => object.key),
        latestText: latest ? await new Response(latest.workspace.body).text() : undefined,
      }
    })

    expect(result.callsWhileBlocked).toBe(1)
    expect(result.publishedWhileBlocked?.checkpointKey).toBeUndefined()
    expect(result.firstSaved).toBe(true)
    expect(result.secondSaved).toBe(true)
    expect(result.entries).toHaveLength(2)
    expect(result.entries[1]?.publishedAtEntry).toBeTruthy()
    expect(result.state?.checkpointFingerprint).toBe("archive-2")
    expect(result.objects).toHaveLength(2)
    expect(result.latestText).toBe("archive-2")
  })

  it("releases the publication fence only after failure retry bookkeeping completes", async () => {
    const stub = env.CONVERSATION.getByName("C1:checkpoint-manager-failure")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      const id = runtime.id.toString()
      const archiveEnv = { ALLOW_PLAINTEXT_ARCHIVES: "0" }
      const retryEntered = deferred()
      const releaseRetry = deferred()
      let controls = 0
      const checkpoints = new ConversationCheckpoints(managerOptions(runtime, id, {
        archiveEnv,
        getControl: async () => ({
          fetch: async () => {
            controls++
            return checkpointResponse("recovered-archive")
          },
        }),
        schedule: async () => {
          retryEntered.resolve()
          await releaseRetry.promise
        },
      }))

      const first = checkpoints.capture()
      await retryEntered.promise
      const second = checkpoints.capture()
      await new Promise((resolve) => setTimeout(resolve, 5))
      const controlsWhileRetryPending = controls
      const pendingWhileRetryPending = await runtime.storage.get<{ checkpointPending?: boolean }>("state")
      archiveEnv.ALLOW_PLAINTEXT_ARCHIVES = "1"
      releaseRetry.resolve()
      const firstSaved = await first
      const secondSaved = await second
      const state = await runtime.storage.get<{ checkpointPending?: boolean; checkpointKey?: string }>("state")
      return { controlsWhileRetryPending, pendingWhileRetryPending, firstSaved, secondSaved, state, controls }
    })

    expect(result.controlsWhileRetryPending).toBe(0)
    expect(result.pendingWhileRetryPending?.checkpointPending).toBe(true)
    expect(result.firstSaved).toBe(false)
    expect(result.secondSaved).toBe(true)
    expect(result.controls).toBe(1)
    expect(result.state?.checkpointPending).toBeUndefined()
    expect(result.state?.checkpointKey).toContain("/workspace-")
  })
})
