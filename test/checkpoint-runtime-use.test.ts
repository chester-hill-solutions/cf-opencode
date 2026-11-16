import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { ConversationCheckpoints } from "../src/conversation/checkpoints"
import { RuntimeUseGate } from "../src/conversation/runtime-gate"
import { ConversationStore } from "../src/state"
import type { ContainerPort } from "../src/opencode"

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe("checkpoint runtime borrowing", () => {
  it("waits for exclusive runtime use before taking the checkpoint publication tail", async () => {
    const stub = env.CONVERSATION.getByName("C1:checkpoint-runtime-use-order")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      const id = runtime.id.toString()
      const gate = new RuntimeUseGate()
      const allowOwnedCapture = deferred()
      const ownedCaptureComplete = deferred<boolean>()
      let controlCalls = 0
      const control: ContainerPort = {
        fetch: async () => {
          controlCalls++
          return new Response(null, { status: 204 })
        },
      }
      const checkpoints = new ConversationCheckpoints({
        conversationID: id,
        workspaceID: "default",
        store: new ConversationStore(runtime.storage),
        storage: runtime.storage,
        bucket: env.CHECKPOINTS,
        archiveEnv: { ALLOW_PLAINTEXT_ARCHIVES: "1" },
        getControl: async () => control,
        withRuntimeUse: (task) => gate.use(task),
        retry: { schedule: async () => {}, cancel: async () => {} },
        count: async () => {},
        deliverError: async () => {},
      })

      const exclusive = gate.exclusive(async () => {
        await allowOwnedCapture.promise
        const captured = await checkpoints.captureOwned()
        ownedCaptureComplete.resolve(captured)
      })
      const queuedCapture = checkpoints.capture()
      // Let capture() enter its borrowing callback and queue behind the writer.
      await Promise.resolve()
      const callsBeforeWriterRuns = controlCalls
      allowOwnedCapture.resolve()
      const capturedUnderExclusive = await Promise.race([
        ownedCaptureComplete.promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("owned capture deadlocked")), 1_000)),
      ])
      await Promise.all([exclusive, queuedCapture])
      return { callsBeforeWriterRuns, capturedUnderExclusive, controlCalls }
    })

    expect(result.callsBeforeWriterRuns).toBe(0)
    expect(result.capturedUnderExclusive).toBe(true)
    expect(result.controlCalls).toBe(2)
  })
})
