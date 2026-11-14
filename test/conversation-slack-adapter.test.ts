import { describe, expect, test } from "vitest"
import { ConversationSlackAdapter, type ConversationSlackAdapterOptions } from "../src/conversation/slack-adapter"
import type { SlackEventRequest } from "../src/conversation/requests"
import type { TurnObservation } from "../src/turn-observation"

const observation: TurnObservation = {
  policy: "observe_and_alert", thresholdMs: 600_000, executionDeadlineEnforced: false,
  runStartedAt: 1, elapsedMs: 600_001, overdue: true, timeoutObserved: false,
  timeoutObservedAt: null, settlement: "active",
}

function fixture(overrides: Record<string, unknown> = {}) {
  const calls: Array<[string, ...unknown[]]> = []
  const replies: string[] = []
  let state: Record<string, unknown> = { phase: "idle", queue: [] }
  const options = {
    store: {
      get: async () => state,
      patch: async (value: Record<string, unknown>) => { state = { ...state, ...value } },
      advance: async () => {}, claimEvent: async () => true,
      releaseEvent: async (id: string) => { calls.push(["releaseEvent", id]) },
      markTombstone: async () => {},
    },
    sessions: { ensure: async () => "session-1", baseline: async () => "baseline" },
    admissions: {
      withLock: async (fn: () => Promise<unknown>) => fn(), claim: async () => true,
      enqueue: async () => ({ kind: "queue_full", depth: 5, limit: 5 }),
      finishLocal: () => {}, resumeDispatched: async () => {}, recordAccepted: async () => {},
      active: false,
    },
    budget: {
      acquire: async () => ({ kind: "granted", reservation: { reservationID: "r1", date: "2026-11-14" } }),
      markDispatched: async () => true,
    },
    controlPlane: { pendingForms: async () => [], replyToForm: async () => {} },
    upgrades: { hasPending: async () => false }, turnExecution: { isPumping: false, startStream: async () => {} },
    controls: {
      steer: async (text: string) => { calls.push(["steer", text]); return "Guidance added." },
      stop: async (text?: string, target?: { channel: string; replyTs?: string }) => { calls.push(["stop", text, target]); return "Stop handled." },
    },
    observation: async () => observation,
    scheduler: { schedule: async () => {} }, recovery: { active: false },
    withClient: async (fn: (client: any) => Promise<unknown>) => fn({ session: { prompt: async (args: unknown) => { calls.push(["prompt", args]) } } }),
    withUsageLifecycle: async (fn: () => Promise<Response>) => fn(),
    settings: async () => ({ model: "provider/model", streaming: false }),
    usageToday: async () => ({ date: "2026-11-14", costUSD: 0, reservedUSD: 0, input: 0, output: 0 }),
    deliver: async () => {}, waitUntil: () => {}, conversationKey: () => "conversation",
    env: () => ({}),
    ...overrides,
  } as unknown as ConversationSlackAdapterOptions
  const adapter = new ConversationSlackAdapter(options)
  adapter.postChunked = async (_channel, text) => { replies.push(text) }
  return { adapter, options, calls, replies, getState: () => state, setState: (next: Record<string, unknown>) => { state = next } }
}

function event(text: string, eventID = "event-1"): SlackEventRequest {
  return { eventID, event: { type: "app_mention", channel: "C1", ts: "1.0", text, channel_type: "channel" } }
}

describe("ConversationSlackAdapter delivery controls", () => {
  test("routes steer and stop commands to shared controls and includes turn observation in status", async () => {
    const f = fixture()
    const input = { event: { type: "app_mention", channel: "C1", ts: "1.0", text: "!steer be concise", channel_type: "channel" } } as SlackEventRequest
    await f.adapter.handleControl("!steer be concise", input, { channel: "C1" })
    await f.adapter.handleControl("!stop next", { ...input, event: { ...input.event, text: "!stop next" } }, { channel: "C1", replyTs: "2.0" })
    await f.adapter.handleControl("!status", { ...input, event: { ...input.event, text: "!status" } }, { channel: "C1" })
    expect(f.calls).toContainEqual(["steer", "be concise"])
    expect(f.calls).toContainEqual(["stop", "next", { channel: "C1", replyTs: "2.0" }])
    expect(f.replies.at(-1)).toContain("observation threshold")
    expect(f.replies.at(-1)).toContain("not automatically stopped")
  })

  test("explicitly queues the mainline Slack prompt", async () => {
    const f = fixture()
    await f.adapter.onEvent(event("hello"))
    expect(f.calls.find(([name]) => name === "prompt")?.[1]).toMatchObject({ delivery: "queue", sessionID: "session-1", text: "hello" })
  })

  test("returns typed queue failure and releases the claimed event when full", async () => {
    const f = fixture({ admissions: {
      withLock: async (fn: () => Promise<unknown>) => fn(), claim: async () => false,
      enqueue: async () => ({ kind: "queue_full", depth: 5, limit: 5 }), finishLocal: () => {},
      resumeDispatched: async () => {}, recordAccepted: async () => {}, active: false,
    } })
    const response = await f.adapter.onEvent(event("hello"))
    expect(await response.json()).toMatchObject({ queued: false, queueResult: { kind: "queue_full", depth: 5, limit: 5 } })
    expect(f.calls).toContainEqual(["releaseEvent", "event-1"])
    expect(f.replies[0]).toContain("queue is full (5/5)")
  })

  test("clears a failed startup admission before retrying through the FIFO queue", async () => {
    let enqueuePhase: unknown
    let optionsRef: ConversationSlackAdapterOptions
    const f = fixture({
      sessions: { ensure: async () => { throw new Error("container start failed") }, baseline: async () => undefined },
      admissions: {
        withLock: async (fn: () => Promise<unknown>) => fn(),
        claim: async () => true,
        enqueue: async () => {
          enqueuePhase = (await optionsRef.store.get()).phase
          return { kind: "enqueued", id: "q1", position: 1, depth: 1, limit: 5 }
        },
        finishLocal: () => {}, resumeDispatched: async () => {}, recordAccepted: async () => {}, active: false,
      },
    })
    optionsRef = f.options
    f.setState({ phase: "admitting", admissionID: "admission-1", admissionStartedAt: 10, queue: [] })
    const response = await f.adapter.onEvent(event("hello"))
    expect(enqueuePhase).toBe("idle")
    expect(f.getState()).toMatchObject({ phase: "idle", admissionID: undefined, admissionStartedAt: undefined })
    expect(await response.json()).toMatchObject({ queued: true, queueResult: { kind: "enqueued", position: 1 } })
  })
})
