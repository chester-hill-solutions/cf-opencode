import { DurableObject } from "cloudflare:workers"
import {
  Lifecycle,
  LifecycleCapability,
  type LifecycleJobContext,
  type MemoryLimitContext,
} from "agents/lifecycle"
import type { Env } from "../../src/env"
import { ConversationEventStream } from "../../src/conversation/event-stream"
import { ConversationStore } from "../../src/state"
import type { ConversationEvent } from "../../src/events"

type ProbePayload = { value?: string; wait?: boolean; outcomeAt?: number }

class ProbeEventStream extends ConversationEventStream {
  async enqueueHeartbeatAt(time: number): Promise<void> {
    await this.lifecycle.jobs.push({
      id: "sse:heartbeat",
      fn: "heartbeat",
      time,
      retry: { maxAttempts: 1 },
      singleflight: true,
    })
  }

  async rescheduleHeartbeat(time: number): Promise<void> {
    await this.lifecycle.jobs.reschedule("sse:heartbeat", time)
  }
}

class TerminalProbeCapability extends LifecycleCapability {
  constructor(private readonly host: LifecycleProbe) {
    super("lc0-terminal-probe")
  }

  async onStart(): Promise<void> {
    this.lifecycle.jobs.list()
  }

  async enqueue(): Promise<void> {
    await this.lifecycle.jobs.push({
      id: "probe:terminal",
      fn: "fail-once",
      time: Date.now(),
      retry: { maxAttempts: 1 },
    })
  }

  async cancelAll(): Promise<void> {
    for (const job of this.lifecycle.jobs.list()) await this.lifecycle.jobs.cancel(job.id)
  }

  async onJob(): Promise<void> {
    throw new Error("intentional terminal application failure")
  }

  async onJobError(context: LifecycleJobContext, error: unknown): Promise<{ rescheduleAt: number }> {
    await this.lifecycle.runInHostContext(() => this.host.recordTerminalFailure({
      id: context.job.id,
      message: error instanceof Error ? error.message : "unknown",
    }))
    return { rescheduleAt: Date.now() + 60_000 }
  }
}

/** Test-only Lifecycle host. It is reachable only through wrangler.test.jsonc. */
export class LifecycleProbe extends DurableObject<Env> {
  private readonly lifecycle: Lifecycle<Env>
  private readonly terminalCapability: TerminalProbeCapability
  private readonly eventStore: ConversationStore
  private readonly eventStream: ProbeEventStream
  private releaseBlockedJob: (() => void) | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.eventStore = new ConversationStore(ctx.storage)
    this.lifecycle = new Lifecycle(this)
    this.eventStream = new ProbeEventStream(this.eventStore)
    this.lifecycle.use(this.eventStream)
    this.terminalCapability = new TerminalProbeCapability(this)
    this.lifecycle.use(this.terminalCapability)
  }

  async fetch(request: Request): Promise<Response> {
    return this.lifecycle.fetch(request)
  }

  async alarm(): Promise<void> {
    await this.lifecycle.alarm()
  }

  async onStart(): Promise<void> {
    // Initializes cf_agents_jobs before any transaction attempts to include a
    // queue mutation. Also proves alarm-only startup on a named object.
    this.lifecycle.jobs.list()
    await this.ctx.storage.put("probe:starts", (await this.ctx.storage.get<number>("probe:starts") ?? 0) + 1)
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/events") return this.eventStream.open(request)
    if (url.pathname === "/local-backpressure") {
      const response = await this.eventStream.open(new Request("https://probe/events"))
      const reader = response.body!.getReader()
      const connected = new TextDecoder().decode((await reader.read()).value) === ": connected\n\n"
      const oversized = { type: "assistant", text: "x".repeat(70_000) } satisfies ConversationEvent
      const oversizedSeq = await this.eventStore.appendEvent(oversized)
      await this.eventStream.publish(oversized, oversizedSeq)
      const nextSeq = await this.eventStore.appendEvent({ type: "settled" })
      await this.eventStream.publish({ type: "settled" }, nextSeq)
      const frame = await reader.read()
      const closed = (await reader.read()).done === true
      const heartbeatJobs = [...this.ctx.storage.sql.exec<{ id: string }>(
        "SELECT id FROM cf_agents_jobs WHERE id = ?",
        "sse:heartbeat",
      )]
      return Response.json({
        connected,
        deliveredBytes: frame.value?.byteLength ?? 0,
        closed,
        heartbeatRetained: heartbeatJobs.length > 0,
      })
    }
    if (url.pathname === "/emit") {
      const event = await request.json() as ConversationEvent
      const seq = await this.eventStore.appendEvent(event)
      await this.eventStream.publish(event, seq)
      return Response.json({ seq })
    }
    if (url.pathname === "/heartbeat-now") {
      await this.eventStream.rescheduleHeartbeat(Date.now())
      return this.atomicSnapshot()
    }
    if (url.pathname === "/orphan-heartbeat") {
      await this.eventStream.enqueueHeartbeatAt(Date.now() + 15_000)
      return this.atomicSnapshot()
    }
    if (url.pathname === "/ping") {
      return Response.json({ name: this.lifecycle.name, started: this.lifecycle.isStarted() })
    }
    if (url.pathname === "/atomic-fail" || url.pathname === "/atomic-commit" || url.pathname === "/atomic-future") {
      await this.lifecycle.jobs.list()
      await this.ctx.storage.deleteAlarm()
      const fail = url.pathname === "/atomic-fail"
      try {
        await this.ctx.storage.transaction(async (transaction) => {
          await transaction.put("probe:atomic-marker", fail ? "rolled-back" : "committed")
          await this.lifecycle.jobs.push({
            id: "probe:atomic-job",
            fn: "record",
          time: fail || url.pathname === "/atomic-future" ? Date.now() + 60_000 : Date.now(),
            payload: { value: "from-transaction" },
            retry: { maxAttempts: 1 },
          })
          if (fail) throw new Error("intentional rollback")
        })
      } catch (error) {
        if (!fail) throw error
      }
      return this.atomicSnapshot()
    }
    if (url.pathname === "/jobs") {
      const body = await request.json() as { id: string; time: number; payload?: ProbePayload }
      const job = await this.lifecycle.jobs.push({
        id: body.id,
        fn: "record",
        time: body.time,
        payload: body.payload,
        retry: { maxAttempts: 1 },
        singleflight: true,
      })
      return Response.json(job)
    }
    if (url.pathname === "/cancel") {
      return Response.json({ cancelled: await this.lifecycle.jobs.cancel(url.searchParams.get("id") ?? "") })
    }
    if (url.pathname === "/release") {
      this.releaseBlockedJob?.()
      this.releaseBlockedJob = undefined
      return Response.json({ released: true })
    }
    if (url.pathname === "/reset") return this.resetProbeState()
    if (url.pathname === "/terminal") {
      await this.terminalCapability.enqueue()
      return this.atomicSnapshot()
    }
    if (url.pathname === "/simulate-sealed-hook") {
      // Test-only public hook seam; this does not simulate a platform OOM.
      await this.onAlarmMemoryLimit({ sealed: true })
      return this.atomicSnapshot()
    }
    if (url.pathname === "/drive") {
      await this.lifecycle.alarm()
      return this.atomicSnapshot()
    }
    if (url.pathname === "/drive-due") {
      await this.lifecycle.jobs.reschedule("probe:atomic-job", Date.now())
      await this.lifecycle.alarm()
      return this.atomicSnapshot()
    }
    if (url.pathname === "/snapshot") return this.atomicSnapshot()
    return new Response("not found", { status: 404 })
  }

  async onJob(context: LifecycleJobContext): Promise<{ rescheduleAt: number } | void> {
    const payload = context.job.payload as ProbePayload | undefined
    const epoch = await this.ctx.storage.get<number>("probe:epoch") ?? 0
    if (payload?.wait) {
      await this.ctx.storage.put("probe:entered", true)
      await new Promise<void>((resolve) => { this.releaseBlockedJob = resolve })
    }
    if (epoch !== (await this.ctx.storage.get<number>("probe:epoch") ?? 0)) {
      await this.ctx.storage.put("probe:stale-completion", true)
      return
    }
    const marker = await this.ctx.storage.get<string>("probe:atomic-marker")
    await this.ctx.storage.put("probe:ran", {
      id: context.job.id,
      value: payload?.value ?? null,
      marker: marker ?? null,
    })
    await this.ctx.storage.put("probe:runs", (await this.ctx.storage.get<number>("probe:runs") ?? 0) + 1)
    if (payload?.outcomeAt !== undefined) return { rescheduleAt: payload.outcomeAt }
  }

  async onAlarm(): Promise<void> {
    await this.ctx.storage.put("probe:alarms", (await this.ctx.storage.get<number>("probe:alarms") ?? 0) + 1)
  }

  async recordTerminalFailure(failure: { id: string; message: string }): Promise<void> {
    await this.ctx.storage.put("probe:terminal-blocked", failure)
  }

  async onAlarmMemoryLimit(context: MemoryLimitContext): Promise<void> {
    if (context.sealed) {
      await this.ctx.storage.put("probe:sealed-blocked", {
        sealed: true,
        executingJob: context.executing?.id ?? null,
      })
    }
  }

  private async resetProbeState(): Promise<Response> {
    for (const job of this.lifecycle.jobs.list()) await this.lifecycle.jobs.cancel(job.id)
    await this.terminalCapability.cancelAll()
    const epoch = (await this.ctx.storage.get<number>("probe:epoch") ?? 0) + 1
    await this.ctx.storage.put("probe:epoch", epoch)
    for (const key of ["probe:atomic-marker", "probe:ran", "probe:entered", "probe:stale-completion", "probe:terminal-blocked", "probe:sealed-blocked"]) {
      await this.ctx.storage.delete(key)
    }
    return this.atomicSnapshot()
  }

  private async atomicSnapshot(): Promise<Response> {
    const rows = [...this.ctx.storage.sql.exec<{ id: string; capability: string; fn: string; time: number; payload: string | null }>(
      "SELECT id, capability, fn, time, payload FROM cf_agents_jobs ORDER BY time",
    )]
    return Response.json({
      marker: await this.ctx.storage.get<string>("probe:atomic-marker") ?? null,
      jobs: rows,
      alarm: await this.ctx.storage.getAlarm(),
      ran: await this.ctx.storage.get("probe:ran") ?? null,
      alarms: await this.ctx.storage.get<number>("probe:alarms") ?? 0,
      starts: await this.ctx.storage.get<number>("probe:starts") ?? 0,
      seq: await this.ctx.storage.get<number>("seq") ?? 0,
      eventCount: (await this.eventStore.eventsAfter(-1)).length,
      runs: await this.ctx.storage.get<number>("probe:runs") ?? 0,
      entered: await this.ctx.storage.get("probe:entered") ?? null,
      staleCompletion: await this.ctx.storage.get("probe:stale-completion") ?? null,
      terminalBlocked: await this.ctx.storage.get("probe:terminal-blocked") ?? null,
      sealedBlocked: await this.ctx.storage.get("probe:sealed-blocked") ?? null,
    })
  }
}
