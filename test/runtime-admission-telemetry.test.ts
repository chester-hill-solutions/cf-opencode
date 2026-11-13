import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { ConversationAdmissions } from "../src/conversation/admissions"
import { ConversationRuntime } from "../src/conversation/runtime"
import { ConversationStore } from "../src/state"
import type { ConversationTelemetryEnvelope } from "../src/conversation/telemetry"

describe("runtime and admission lifecycle telemetry", () => {
  it("emits native start and confirmed stop events with stable fields", async () => {
    const stub = env.CONVERSATION.getByName("C1:runtime-telemetry-start-stop")
    const events = await runInDurableObject(stub, async (_instance, runtime) => {
      const emitted: ConversationTelemetryEnvelope[] = []
      const counts: string[] = []
      const container = {
        running: false,
        start() { this.running = true },
        async destroy() { this.running = false },
        async setInactivityTimeout() {},
      }
      const owner = new ConversationRuntime({
        conversationID: runtime.id.toString(),
        telemetry: (event) => emitted.push(event),
        network: { transport: () => undefined, containerURL: () => undefined },
        binding: { get: () => container as never },
        startup: { start: async () => true, prepareImage: async () => {}, options: () => ({}) as never },
        snapshots: { snapshotHandle: async () => undefined, clearSnapshot: async () => true },
        authorization: { controlToken: async () => "" },
        observations: { snapshotStale: () => {}, count: (name) => counts.push(name) },
      })
      owner.recordGeneration("generation-1")
      await owner.startBoundContainer(container as never)
      const stopped = await owner.stop()
      return { emitted, counts, stopped }
    })

    expect(events.stopped).toBe(true)
    expect(events.emitted).toHaveLength(2)
    expect(events.emitted[0]).toMatchObject({
      event: "container.started",
      component: "runtime",
      conversationID: expect.any(String),
      runtimeGeneration: "generation-1",
      result: "succeeded",
      reasonCode: "image",
    })
    expect(events.emitted[0]?.durationMs).toEqual(expect.any(Number))
    expect(events.emitted[1]).toMatchObject({
      event: "container.stopped",
      component: "runtime",
      runtimeGeneration: "generation-1",
      result: "stopped",
    })
    expect(events.counts).toEqual(["container.started", "container.stopped"])
  })

  it("emits admission and turn events only at their persisted boundaries", async () => {
    const stub = env.CONVERSATION.getByName("C1:admission-telemetry-boundaries")
    const events = await runInDurableObject(stub, async (_instance, runtime) => {
      const emitted: ConversationTelemetryEnvelope[] = []
      const sequence: string[] = []
      const store = new ConversationStore(runtime.storage)
      const admissions = new ConversationAdmissions({
        conversationID: runtime.id.toString(),
        telemetry: (event) => { emitted.push(event); sequence.push(`event:${event.event}`) },
        storage: runtime.storage,
        store,
        budgetReservations: {} as never,
        session: { ensure: async () => "ses-telemetry", baseline: async () => undefined },
        recovery: { active: () => false, pumping: () => false, pendingUpgrade: async () => false },
        jobs: {
          schedule: async (kind) => { sequence.push(`job:${kind}`) },
        },
        prompt: async () => {},
        settings: async () => ({ streaming: false }),
        delivery: { event: async () => {}, postChunked: async () => {}, count: async () => {} },
        startStream: async () => {},
        waitUntil: () => {},
      })

      const claimed = await admissions.claim()
      await store.patch({
        sessionID: "ses-telemetry",
        budgetReservation: { reservationID: "reservation-telemetry", dispatched: true },
      })
      await admissions.recordAccepted(undefined, "acknowledged")
      await admissions.recordAccepted(undefined, "ambiguous")
      return { claimed, emitted, sequence, state: await store.get() }
    })

    expect(events.claimed).toBe(true)
    expect(events.emitted.map((event) => event.event)).toEqual([
      "admission.started",
      "turn.started",
      "admission.settled",
      "turn.started",
      "admission.settled",
    ])
    expect(events.emitted[1]).toMatchObject({
      conversationID: expect.any(String),
      sessionID: "ses-telemetry",
      turnID: "reservation-telemetry",
      result: "started",
    })
    expect(events.emitted[2]).toMatchObject({ result: "settled", reasonCode: "dispatch_acknowledged" })
    expect(events.emitted[4]).toMatchObject({ result: "settled", reasonCode: "dispatch_ambiguous" })
    expect(events.sequence.indexOf("job:turn:observe")).toBeLessThan(events.sequence.indexOf("event:turn.started"))
    expect(events.state.phase).toBe("running")
  })

  it("does not report a failed native destroy as stopped", async () => {
    const stub = env.CONVERSATION.getByName("C1:runtime-telemetry-stop-failed")
    const events = await runInDurableObject(stub, async (_instance, runtime) => {
      const emitted: ConversationTelemetryEnvelope[] = []
      const owner = new ConversationRuntime({
        telemetry: (event) => emitted.push(event),
        network: { transport: () => undefined, containerURL: () => undefined },
        binding: { get: () => ({ running: true, async destroy() { throw new Error("private failure") } }) as never },
        startup: { start: async () => true, prepareImage: async () => {}, options: () => ({}) as never },
        snapshots: { snapshotHandle: async () => undefined, clearSnapshot: async () => true },
        authorization: { controlToken: async () => "" },
        observations: { snapshotStale: () => {}, count: () => {} },
      })
      const stopped = await owner.stop()
      return { emitted, stopped }
    })

    expect(events.stopped).toBe(false)
    expect(events.emitted.map((event) => event.event)).toEqual(["container.stop.failed"])
    expect(events.emitted[0]).toMatchObject({ result: "failed", reasonCode: "destroy_failed" })
  })
})
