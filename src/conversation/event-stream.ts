import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle"
import { formatSse, isSlowSubscriber, type ConversationEvent } from "../events"

export interface EventReplayEntry {
  seq: number
  event: ConversationEvent
}

/** Durable replay input. Appending and sequencing remain owned by ConversationStore. */
export interface EventReplayStore {
  oldestSeq(): Promise<number | undefined>
  eventsAfter(lastID: number): Promise<EventReplayEntry[]>
}

const HEARTBEAT_JOB_ID = "sse:heartbeat"
const HEARTBEAT_FN = "heartbeat"
const HEARTBEAT_INTERVAL_MS = 15_000

/** HTTP/SSE subscribers and heartbeat scheduling; no runtime or container access. */
export class ConversationEventStream extends LifecycleCapability {
  private readonly store: EventReplayStore
  private readonly subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>()
  private heartbeatTail: Promise<void> = Promise.resolve()

  constructor(store: EventReplayStore) {
    super("event-stream")
    this.store = store
  }

  /** Process-local subscribers disappear on eviction, so discard orphaned heartbeats. */
  async onStart(): Promise<void> {
    await this.lifecycle.jobs.cancel(HEARTBEAT_JOB_ID)
  }

  async open(request: Request): Promise<Response> {
    const lastID = Number(request.headers.get("last-event-id") ?? "0") || 0
    const oldest = await this.store.oldestSeq()
    const replay = await this.store.eventsAfter(lastID)
    const encoder = new TextEncoder()
    let ref: ReadableStreamDefaultController<Uint8Array> | undefined

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        ref = controller
        if (lastID > 0 && oldest !== undefined && lastID < oldest - 1) {
          controller.enqueue(encoder.encode(formatSse({ type: "reset" })))
        }
        for (const entry of replay) controller.enqueue(encoder.encode(formatSse(entry.event, entry.seq)))
        controller.enqueue(encoder.encode(": connected\n\n"))
        this.subscribers.add(controller)
        void this.reconcileHeartbeat().catch(() => {
          this.drop(controller, true)
          void this.reconcileHeartbeat().catch(() => {})
        })
      },
      cancel: async () => {
        if (ref) this.drop(ref, false)
        await this.reconcileHeartbeat().catch(() => {})
      },
    }, {
      // The slow-subscriber limit is measured in bytes, so make
      // desiredSize byte-based instead of the default chunk count.
      highWaterMark: 0,
      size: (chunk) => chunk.byteLength,
    })

    const response = new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    })
    // Stream start runs synchronously, but heartbeat persistence is async.
    // Make open's boundary observable to callers once that subscription owns
    // its wake, rather than returning a stream with an unarmed heartbeat.
    await this.heartbeatTail.catch(() => {})
    return response
  }

  /** Publish an already-persisted event without duplicating durable event storage. */
  async publish(event: ConversationEvent, seq: number): Promise<void> {
    const chunk = new TextEncoder().encode(formatSse(event, seq))
    for (const controller of this.subscribers) this.enqueue(controller, chunk)
    await this.reconcileHeartbeat().catch(async () => {
      this.dropAll()
      await this.reconcileHeartbeat().catch(() => {})
    })
  }

  async onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome | void> {
    if (context.job.fn !== HEARTBEAT_FN) return
    const chunk = new TextEncoder().encode(": heartbeat\n\n")
    for (const controller of this.subscribers) this.enqueue(controller, chunk)
    if (this.subscribers.size === 0) return
    return { rescheduleAt: Date.now() + HEARTBEAT_INTERVAL_MS }
  }

  async onJobError(context: LifecycleJobContext): Promise<LifecycleJobOutcome | void> {
    if (context.job.fn !== HEARTBEAT_FN || this.subscribers.size === 0) return
    return { rescheduleAt: Date.now() + HEARTBEAT_INTERVAL_MS }
  }

  private enqueue(controller: ReadableStreamDefaultController<Uint8Array>, chunk: Uint8Array): void {
    if (!this.subscribers.has(controller)) return
    if (isSlowSubscriber(controller.desiredSize)) {
      this.drop(controller, true)
      return
    }
    try {
      controller.enqueue(chunk)
      // Check after enqueue too: one oversized frame can exceed the byte
      // budget without a later event arriving to trigger another preflight.
      if (isSlowSubscriber(controller.desiredSize)) this.drop(controller, true)
    } catch {
      this.drop(controller, false)
    }
  }

  private drop(controller: ReadableStreamDefaultController<Uint8Array>, close: boolean): void {
    if (!this.subscribers.delete(controller)) return
    if (close) {
      try {
        controller.close()
      } catch {
        // Already closed by the stream implementation.
      }
    }
  }

  private dropAll(): void {
    for (const controller of this.subscribers) this.drop(controller, true)
  }

  private reconcileHeartbeat(): Promise<void> {
    const next = this.heartbeatTail.catch(() => {}).then(async () => {
      const jobs = this.lifecycle.jobs
      if (this.subscribers.size === 0) {
        await jobs.cancel(HEARTBEAT_JOB_ID)
        return
      }
      if (jobs.get(HEARTBEAT_JOB_ID)) return
      await jobs.push({
        id: HEARTBEAT_JOB_ID,
        fn: HEARTBEAT_FN,
        time: Date.now() + HEARTBEAT_INTERVAL_MS,
        retry: { maxAttempts: 1 },
        singleflight: true,
      })
    })
    this.heartbeatTail = next
    return next
  }
}
