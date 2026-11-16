import { describe, expect, it } from "bun:test"
import { RuntimeUseGate } from "../src/conversation/runtime-gate"

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe("RuntimeUseGate", () => {
  it("allows concurrent uses", async () => {
    const gate = new RuntimeUseGate()
    const release = deferred()
    const started = [deferred(), deferred()]
    const first = gate.use(async () => { started[0]!.resolve(); await release.promise })
    const second = gate.use(async () => { started[1]!.resolve(); await release.promise })
    await Promise.all(started.map((item) => item.promise))
    expect(gate.activeUses).toBe(2)
    release.resolve()
    await Promise.all([first, second])
    expect(gate.activeUses).toBe(0)
  })

  it("waits for all active uses before a writer and blocks later readers", async () => {
    const gate = new RuntimeUseGate()
    const releaseReaders = deferred()
    const readerAStarted = deferred()
    const readerBStarted = deferred()
    const firstReader = gate.use(async () => { readerAStarted.resolve(); await releaseReaders.promise })
    const secondReader = gate.use(async () => { readerBStarted.resolve(); await releaseReaders.promise })
    await Promise.all([readerAStarted.promise, readerBStarted.promise])

    const writerStarted = deferred()
    const releaseWriter = deferred()
    const writer = gate.exclusive(async () => { writerStarted.resolve(); await releaseWriter.promise })
    expect(gate.exclusivePending).toBe(1)
    const order: string[] = []
    const laterReader = gate.use(() => { order.push("reader") })
    releaseReaders.resolve()
    await writerStarted.promise
    expect(order).toEqual([])
    releaseWriter.resolve()
    await Promise.all([firstReader, secondReader, writer, laterReader])
    expect(order).toEqual(["reader"])
  })

  it("increments activity synchronously while a reader waits behind a writer", async () => {
    const gate = new RuntimeUseGate()
    const entered = deferred()
    const release = deferred()
    const writer = gate.exclusive(async () => { entered.resolve(); await release.promise })
    await entered.promise
    const before = gate.activityEpoch
    const reader = gate.use(() => {})
    expect(gate.activityEpoch).toBe(before + 1)
    expect(gate.activeUses).toBe(0)
    release.resolve()
    await Promise.all([writer, reader])
  })

  it("runs queued writers FIFO", async () => {
    const gate = new RuntimeUseGate()
    const hold = deferred()
    const readerStarted = deferred()
    const firstReader = gate.use(async () => { readerStarted.resolve(); await hold.promise })
    await readerStarted.promise
    const order: number[] = []
    const first = gate.exclusive(() => { order.push(1) })
    const second = gate.exclusive(() => { order.push(2) })
    hold.resolve()
    await Promise.all([firstReader, first, second])
    expect(order).toEqual([1, 2])
  })

  it("releases the gate after rejecting use and exclusive operations", async () => {
    const gate = new RuntimeUseGate()
    await expect(gate.use(() => { throw new Error("use failed") })).rejects.toThrow("use failed")
    await expect(gate.exclusive(() => { throw new Error("exclusive failed") })).rejects.toThrow("exclusive failed")
    expect(await gate.use(() => "available again")).toBe("available again")
    expect(gate.activeUses).toBe(0)
  })

  it("releases a waiting writer after a use rejects", async () => {
    const gate = new RuntimeUseGate()
    const rejectReader = deferred()
    const readerStarted = deferred()
    const reader = gate.use(async () => {
      readerStarted.resolve()
      await rejectReader.promise
      throw new Error("reader rejected")
    })
    await readerStarted.promise
    const writerStarted = deferred()
    const writer = gate.exclusive(() => { writerStarted.resolve() })
    rejectReader.resolve()
    await expect(reader).rejects.toThrow("reader rejected")
    await writerStarted.promise
    await writer
    expect(gate.activeUses).toBe(0)
    expect(gate.exclusivePending).toBe(0)
  })

  it("releases a queued reader after an exclusive operation rejects", async () => {
    const gate = new RuntimeUseGate()
    const firstStarted = deferred()
    const releaseFirst = deferred()
    const first = gate.exclusive(async () => { firstStarted.resolve(); await releaseFirst.promise })
    await firstStarted.promise
    const rejectedWriter = gate.exclusive(() => { throw new Error("queued writer rejected") })
    const readerStarted = deferred()
    const reader = gate.use(() => { readerStarted.resolve() })
    releaseFirst.resolve()
    await first
    await expect(rejectedWriter).rejects.toThrow("queued writer rejected")
    await readerStarted.promise
    await reader
    expect(gate.exclusivePending).toBe(0)
    expect(gate.activeUses).toBe(0)
  })
})
