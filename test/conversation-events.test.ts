import { describe, expect, it } from "vitest"
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test"
import type { ConversationEvent, StoredEvent } from "../src/events"

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  let value = await read()
  for (let i = 0; i < 50 && !ready(value); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    value = await read()
  }
  if (!ready(value)) throw new Error("timed out waiting for test state")
  return value
}

async function readText(reader: ReadableStreamDefaultReader<Uint8Array>, match: string): Promise<string> {
  let text = ""
  for (let i = 0; i < 8 && !text.includes(match); i++) {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`timed out waiting for ${match}`)), 2_000) }),
    ]).finally(() => { if (timeout) clearTimeout(timeout) })
    if (result.done) break
    text += new TextDecoder().decode(result.value)
  }
  return text
}

describe("Lifecycle conversation event stream", () => {
  it("preserves replay frames and emits a reset before replay for an expired cursor", async () => {
    const stub = env.LIFECYCLE_PROBE.getByName("lc1b:replay-reset")
    const replay: StoredEvent[] = [
      { seq: 4, event: { type: "assistant", text: "four" } },
      { seq: 5, event: { type: "settled" } },
    ]
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("seq", 5)
      await state.storage.put("events", replay)
    })

    const response = await stub.fetch("https://probe/events", { headers: { "last-event-id": "2" } })
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(response.headers.get("cache-control")).toBe("no-cache")
    const reader = response.body!.getReader()
    const output = await readText(reader, ": connected\n\n")
    expect(output).toContain('event: reset\ndata: {"type":"reset"}\n\n')
    expect(output.indexOf("event: reset")).toBeLessThan(output.indexOf("id: 4\nevent: assistant"))
    expect(output).toContain('id: 4\nevent: assistant\ndata: {"type":"assistant","text":"four"}\n\n')
    expect(output).toContain('id: 5\nevent: settled\ndata: {"type":"settled"}\n\n')
    await reader.cancel()
  })

  it("publishes monotonically numbered stored events to an open stream", async () => {
    const stub = env.LIFECYCLE_PROBE.getByName("lc1b:monotonic")
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("seq", 2)
      await state.storage.put("events", [
        { seq: 1, event: { type: "assistant", text: "one" } },
        { seq: 2, event: { type: "settled" } },
      ] satisfies StoredEvent[])
    })
    const response = await stub.fetch("https://probe/events", { headers: { "last-event-id": "2" } })
    const reader = response.body!.getReader()
    expect(await readText(reader, ": connected\n\n")).toContain(": connected\n\n")
    const event: ConversationEvent = { type: "assistant", text: "three" }
    await stub.fetch("https://probe/emit", { method: "POST", body: JSON.stringify(event) })
    const frame = await readText(reader, "id: 3\n")
    expect(frame).toContain('id: 3\nevent: assistant\ndata: {"type":"assistant","text":"three"}\n\n')
    await reader.cancel()
  })

  it("sends heartbeat comments without durable append and cancels after the last disconnect", async () => {
    const stub = env.LIFECYCLE_PROBE.getByName("lc1b:heartbeat")
    const response = await stub.fetch("https://probe/events")
    const reader = response.body!.getReader()
    await readText(reader, ": connected\n\n")
    const queued = await waitFor(
      async () => (await (await stub.fetch("https://probe/snapshot")).json()) as { jobs: { id: string; capability: string; time: number }[]; seq: number },
      (snapshot) => snapshot.jobs.some((job) => job.id === "sse:heartbeat"),
    )
    expect(queued.jobs.find((job) => job.id === "sse:heartbeat")?.capability).toBe("event-stream")
    const originalSeq = queued.seq
    const wake = await (await stub.fetch("https://probe/heartbeat-now")).json() as { jobs: { id: string; time: number }[] }
    expect(wake.jobs.some((job) => job.id === "sse:heartbeat")).toBe(true)
    await runInDurableObject(stub, async (instance) => instance.alarm())
    expect(await readText(reader, ": heartbeat\n\n")).toContain(": heartbeat\n\n")
    const afterHeartbeat = await (await stub.fetch("https://probe/snapshot")).json() as { jobs: { id: string }[]; seq: number }
    expect(afterHeartbeat.seq).toBe(originalSeq)
    expect(afterHeartbeat.jobs.some((job) => job.id === "sse:heartbeat")).toBe(true)

    await reader.cancel()
    const afterDisconnect = await waitFor(
      async () => (await (await stub.fetch("https://probe/snapshot")).json()) as { jobs: { id: string }[] },
      (snapshot) => !snapshot.jobs.some((job) => job.id === "sse:heartbeat"),
    )
    expect(afterDisconnect.jobs.some((job) => job.id === "sse:heartbeat")).toBe(false)
  })

  it("drops an oversized local stream and cancels its heartbeat", async () => {
    const stub = env.LIFECYCLE_PROBE.getByName("lc1b:local-backpressure")
    const result = await (await stub.fetch("https://probe/local-backpressure")).json() as {
      connected: boolean
      deliveredBytes: number
      closed: boolean
      heartbeatRetained: boolean
    }
    expect(result.connected).toBe(true)
    expect(result.deliveredBytes).toBeGreaterThan(64 * 1024)
    expect(result.closed).toBe(true)
    expect(result.heartbeatRetained).toBe(false)
  })

  it("removes orphan heartbeat intent when a fresh instance starts after eviction", async () => {
    const stub = env.LIFECYCLE_PROBE.getByName("lc1b:evicted-heartbeat")
    const before = await (await stub.fetch("https://probe/orphan-heartbeat")).json() as { jobs: { id: string }[] }
    expect(before.jobs.some((job) => job.id === "sse:heartbeat")).toBe(true)

    await evictDurableObject(stub)
    const afterRestart = await (await stub.fetch("https://probe/snapshot")).json() as { jobs: { id: string }[]; starts: number }
    expect(afterRestart.starts).toBe(2)
    expect(afterRestart.jobs.some((job) => job.id === "sse:heartbeat")).toBe(false)
  })
})
