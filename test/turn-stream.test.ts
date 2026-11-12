import { describe, expect, it } from "vitest"
import { env, runInDurableObject } from "cloudflare:test"
import { ConversationStore } from "../src/state"
import { ConversationTurnExecution } from "../src/conversation/turn-execution"
import { ConversationRuntime } from "../src/conversation/runtime"
import type { ConversationUsage } from "../src/conversation/usage"
import type { ConversationCheckpoints } from "../src/conversation/checkpoints"
import type { ConversationControlPlane } from "../src/conversation/control-plane"

describe("turn native stream ownership", () => {
  it("fences the stream synchronously before destroying the native container", async () => {
    const stub = env.CONVERSATION.getByName("C1:turn-stream-stop-order")
    const order = await runInDurableObject(stub, async () => {
      const steps: string[] = []
      const container = {
        running: true,
        async destroy() { steps.push("destroy"); this.running = false },
      }
      const runtime = new ConversationRuntime({
        network: { transport: () => undefined, containerURL: () => undefined },
        binding: { get: () => container as never },
        startup: { start: async () => true, prepareImage: async () => {}, options: () => ({}) as never },
        snapshots: { snapshotHandle: async () => undefined, clearSnapshot: async () => true },
        authorization: { controlToken: async () => "" },
        lifecycle: { beforeStop: () => { steps.push("cancel-stream") } },
        observations: { snapshotStale: () => {}, count: () => {} },
      })
      const stopped = await runtime.stop()
      return { stopped, steps }
    })
    expect(order).toEqual({ stopped: true, steps: ["cancel-stream", "destroy"] })
  })

  it("cancels an abort-ignoring reader without settlement work and permits a later stream", async () => {
    const stub = env.CONVERSATION.getByName("C1:turn-stream-stop")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      const store = new ConversationStore(runtime.storage)
      await runtime.storage.put("state", {
        phase: "running",
        sessionID: "ses_turn_stream",
        budgetReservation: { reservationID: "reservation-turn-stream", dispatched: true },
        seen: [],
        pending: {},
      })
      let resolveFirstFetched!: () => void
      const firstFetched = new Promise<void>((resolve) => { resolveFirstFetched = resolve })
      let fetches = 0
      let readerCancelled = 0
      let refreshes = 0
      let releases = 0
      const scheduled: string[] = []
      const execution = new ConversationTurnExecution({
        conversationID: runtime.id.toString(),
        storage: runtime.storage,
        store,
        usage: {
          refresh: async () => { refreshes++ },
          recordContext: async () => {},
        } as unknown as ConversationUsage,
        checkpoints: { capture: async () => true } as unknown as ConversationCheckpoints,
        controlPlane: { pendingForms: async () => [] } as unknown as ConversationControlPlane,
        runtime: {
          ensureReady: async () => ({
            async fetch() {
              fetches++
              if (fetches === 1) {
                resolveFirstFetched()
                // Deliberately ignores AbortSignal; reader cancellation must stop it.
                return new Response(new ReadableStream<Uint8Array>({
                  cancel() { readerCancelled++ },
                }), { headers: { "content-type": "text/event-stream" } })
              }
              const ended = new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
              return new Response(ended, { headers: { "content-type": "text/event-stream" } })
            },
          }),
          withClient: async () => { throw new Error("unexpected client call") },
        },
        guards: { recovering: () => false, hasPendingUpgrade: async () => false },
        delivery: {
          event: async () => {},
          toSlack: async () => {},
          slack: async () => ({}),
          count: async () => {},
          slackBotToken: () => undefined,
        },
        conversationKey: () => undefined,
        jobs: { schedule: async (kind) => { scheduled.push(kind) } },
        settings: async () => ({ streaming: true } as never),
        releaseBudgetReservation: async () => { releases++; return true },
        waitUntil: () => {},
      })

      const firstStream = execution.startStream("ses_turn_stream")
      await firstFetched
      await new Promise((resolve) => setTimeout(resolve, 0))
      const stopped = await execution.stopStream()
      await firstStream
      const afterStop = {
        streaming: execution.isStreaming,
        cancelled: readerCancelled,
        scheduled: [...scheduled],
        refreshes,
        releases,
      }

      await execution.startStream("ses_turn_stream")
      return { fetches, stopped, afterStop, scheduled }
    })

    expect(result.stopped).toBe(true)
    expect(result.afterStop).toEqual({
      streaming: false,
      cancelled: 1,
      scheduled: [],
      refreshes: 0,
      releases: 0,
    })
    expect(result.fetches).toBe(2)
    expect(result.scheduled).toEqual(["turn:observe"])
  })

  it("claims the poll before awaiting the pending-upgrade guard", async () => {
    const stub = env.CONVERSATION.getByName("C1:turn-pump-singleflight")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      const store = new ConversationStore(runtime.storage)
      await runtime.storage.put("state", {
        phase: "running", sessionID: "ses_pump_singleflight", seen: [], pending: {},
      })
      let releaseGuard!: (pending: boolean) => void
      let enteredGuard!: () => void
      const guardEntered = new Promise<void>((resolve) => { enteredGuard = resolve })
      const pendingUpgrade = new Promise<boolean>((resolve) => { releaseGuard = resolve })
      const execution = new ConversationTurnExecution({
        conversationID: runtime.id.toString(),
        storage: runtime.storage,
        store,
        usage: { refresh: async () => {}, recordContext: async () => {} } as unknown as ConversationUsage,
        checkpoints: { capture: async () => true } as unknown as ConversationCheckpoints,
        controlPlane: { pendingForms: async () => [] } as unknown as ConversationControlPlane,
        runtime: {
          ensureReady: async () => ({ fetch: async () => new Response(null) }),
          withClient: async () => { throw new Error("guarded poll must not read OpenCode") },
        },
        guards: { recovering: () => false, hasPendingUpgrade: async () => {
          enteredGuard()
          return await pendingUpgrade
        } },
        delivery: { event: async () => {}, toSlack: async () => {}, slack: async () => ({}), count: async () => {}, slackBotToken: () => undefined },
        conversationKey: () => undefined,
        jobs: { schedule: async () => {} },
        settings: async () => ({ streaming: false } as never),
        releaseBudgetReservation: async () => true,
        waitUntil: () => {},
      })

      const first = execution.pumpOnce()
      await guardEntered
      const pumping = execution.isPumping
      const second = await execution.pumpOnce()
      releaseGuard(true)
      const firstResult = await first
      return { pumping, firstResult, second }
    })
    expect(result).toEqual({ pumping: true, firstResult: false, second: false })
  })

  it("cancels a response body that arrives after the stream owner was fenced", async () => {
    const stub = env.CONVERSATION.getByName("C1:turn-stream-late-response")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      const store = new ConversationStore(runtime.storage)
      let resolveResponse!: (response: Response) => void
      let markFetchStarted!: () => void
      let markBodyCancelled!: () => void
      const responseReady = new Promise<Response>((resolve) => { resolveResponse = resolve })
      const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve })
      const bodyCancelled = new Promise<void>((resolve) => { markBodyCancelled = resolve })
      const scheduled: string[] = []
      const execution = new ConversationTurnExecution({
        conversationID: runtime.id.toString(),
        storage: runtime.storage,
        store,
        usage: { refresh: async () => {}, recordContext: async () => {} } as unknown as ConversationUsage,
        checkpoints: { capture: async () => true } as unknown as ConversationCheckpoints,
        controlPlane: { pendingForms: async () => [] } as unknown as ConversationControlPlane,
        runtime: {
          ensureReady: async () => ({ fetch: async () => { markFetchStarted(); return await responseReady } }),
          withClient: async () => { throw new Error("unexpected client call") },
        },
        guards: { recovering: () => false, hasPendingUpgrade: async () => false },
        delivery: { event: async () => {}, toSlack: async () => {}, slack: async () => ({}), count: async () => {}, slackBotToken: () => undefined },
        conversationKey: () => undefined,
        jobs: { schedule: async (kind) => { scheduled.push(kind) } },
        settings: async () => ({ streaming: true } as never),
        releaseBudgetReservation: async () => true,
        waitUntil: () => {},
      })

      const starting = execution.startStream("ses_late_response")
      await fetchStarted
      execution.cancelStream()
      resolveResponse(new Response(new ReadableStream<Uint8Array>({
        cancel() { markBodyCancelled() },
      }), { headers: { "content-type": "text/event-stream" } }))
      await starting
      await bodyCancelled
      return { state: execution.currentStreamState, streaming: execution.isStreaming, scheduled }
    })
    expect(result).toEqual({ state: "idle", streaming: false, scheduled: [] })
  })

  it("stores the assistant event once while posting the terminal reply to Slack", async () => {
    const stub = env.CONVERSATION.getByName("C1:turn-slack-terminal-once")
    const result = await runInDurableObject(stub, async (_instance, runtime) => {
      const store = new ConversationStore(runtime.storage)
      const now = Date.now()
      const messages = [
        { id: "u_turn", type: "user", content: [{ type: "text", text: "hello" }] },
        { id: "a_turn", type: "assistant", content: [{ type: "text", text: "reply" }],
          time: { created: now, completed: now + 1 }, finish: "stop" },
      ]
      await runtime.storage.put("state", {
        phase: "running", sessionID: "ses_turn_slack_once", seen: [], pending: {},
        slack: { channel: "C1" },
      })
      const storedEvents: unknown[] = []
      let slackReplies = 0
      const execution = new ConversationTurnExecution({
        conversationID: runtime.id.toString(),
        storage: runtime.storage,
        store,
        usage: { refresh: async () => {}, recordContext: async () => {} } as unknown as ConversationUsage,
        checkpoints: { capture: async () => true } as unknown as ConversationCheckpoints,
        controlPlane: { pendingForms: async () => [] } as unknown as ConversationControlPlane,
        runtime: {
          ensureReady: async () => ({ fetch: async () => new Response(null) }),
          withClient: async (fn) => await fn({
            session: { context: async () => messages },
            permission: { list: async () => [] },
          } as never),
        },
        guards: { recovering: () => false, hasPendingUpgrade: async () => false },
        delivery: {
          event: async (event) => {
            storedEvents.push(event)
            await store.appendEvent(event)
          },
          toSlack: async (event) => { if (event.type === "assistant") slackReplies++ },
          slack: async () => ({}), count: async () => {}, slackBotToken: () => "token",
        },
        conversationKey: () => undefined,
        jobs: { schedule: async () => {} },
        settings: async () => ({ streaming: false } as never),
        releaseBudgetReservation: async () => true,
        waitUntil: () => {},
      })
      await execution.pumpOnce()
      const history = await runtime.storage.get<Array<{ event: { type: string } }>>("events")
      return {
        assistantEvents: history?.filter((item) => item.event.type === "assistant").length,
        slackReplies,
      }
    })
    expect(result).toEqual({ assistantEvents: 1, slackReplies: 1 })
  })
})
