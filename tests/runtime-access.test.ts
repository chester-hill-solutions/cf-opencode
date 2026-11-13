import { describe, expect, it } from "bun:test"
import type { ContainerPort } from "../src/opencode"
import { ConversationRuntimeAccess } from "../src/conversation/runtime-access"

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function port(label: string): ContainerPort {
  return { fetch: async () => new Response(label) }
}

describe("ConversationRuntimeAccess", () => {
  it("coalesces concurrent preparation", async () => {
    const ready = deferred<ContainerPort>()
    const started = deferred()
    let calls = 0
    const access = new ConversationRuntimeAccess({
      prepareOwned: async () => { calls++; started.resolve(); return ready.promise },
      identity: () => ({ ready: false, running: false }),
    })

    const first = access.prepare()
    const second = access.prepare()
    await started.promise
    expect(calls).toBe(1)
    ready.resolve(port("prepared"))
    const [firstPort, secondPort] = await Promise.all([first, second])
    expect(firstPort).toBe(secondPort)
  })

  it("waits for a complete use before exclusive work, then prepares a fresh port for queued demand", async () => {
    const oldPort = port("old")
    const newPort = port("new")
    let currentPort: ContainerPort | undefined = oldPort
    let running = true
    let generation = "one"
    const useStarted = deferred()
    const finishUse = deferred()
    const closeStarted = deferred()
    const access = new ConversationRuntimeAccess({
      prepareOwned: async () => {
        if (!running) {
          currentPort = newPort
          generation = "two"
          running = true
        }
        return currentPort!
      },
      identity: () => ({ port: currentPort, generation, ready: !!currentPort, running }),
    })

    const activeUse = access.useReady(async (usedPort) => {
      useStarted.resolve()
      await finishUse.promise
      return usedPort
    })
    await useStarted.promise

    const close = access.exclusive(async () => {
      closeStarted.resolve()
      currentPort = undefined
      running = false
    })
    const reopenedUse = access.useReady(async (usedPort) => usedPort)
    expect(access.exclusivePending).toBeGreaterThan(0)
    finishUse.resolve()
    expect(await activeUse).toBe(oldPort)
    await closeStarted.promise
    await close
    expect(await reopenedUse).toBe(newPort)
    expect(generation).toBe("two")
  })

  it("records queued use demand synchronously while preparation waits", async () => {
    const exclusiveStarted = deferred()
    const finishExclusive = deferred()
    const prepStarted = deferred()
    const finishPrep = deferred<ContainerPort>()
    const identityPort = port("ready")
    let ready = false
    const access = new ConversationRuntimeAccess({
      prepareOwned: async () => {
        prepStarted.resolve()
        const result = await finishPrep.promise
        ready = true
        return result
      },
      identity: () => ({ port: ready ? identityPort : undefined, generation: "one", ready, running: ready }),
    })
    const writer = access.exclusive(async () => { exclusiveStarted.resolve(); await finishExclusive.promise })
    await exclusiveStarted.promise
    const before = access.activityEpoch
    const user = access.useReady(async () => "ok")
    expect(access.activityEpoch).toBe(before + 1)
    await Promise.resolve()
    expect(access.activeUses).toBe(0)
    finishExclusive.resolve()
    await prepStarted.promise
    finishPrep.resolve(identityPort)
    await Promise.all([writer, user])
  })

  it("re-prepares after a stale port gap without repeating the user callback", async () => {
    const stalePort = port("stale")
    const currentPort = port("current")
    let prepareCalls = 0
    let identityReads = 0
    let callbackCalls = 0
    const access = new ConversationRuntimeAccess({
      prepareOwned: async () => {
        prepareCalls++
        return prepareCalls === 1 ? stalePort : currentPort
      },
      identity: () => {
        identityReads++
        // The identity changes between the pre-lock snapshot and its locked recheck.
        const isCurrent = identityReads === 2 || identityReads >= 3
        return {
          port: isCurrent ? currentPort : stalePort,
          generation: isCurrent ? "two" : "one",
          ready: true,
          running: true,
        }
      },
    })

    const result = await access.useReady(async (usedPort) => { callbackCalls++; return usedPort })
    expect(result).toBe(currentPort)
    expect(prepareCalls).toBe(2)
    expect(callbackCalls).toBe(1)
  })

  it("releases the use gate when the callback rejects", async () => {
    const readyPort = port("ready")
    const access = new ConversationRuntimeAccess({
      prepareOwned: async () => readyPort,
      identity: () => ({ port: readyPort, generation: "one", ready: true, running: true }),
    })

    await expect(access.useReady(async () => { throw new Error("request failed") })).rejects.toThrow("request failed")
    expect(access.activeUses).toBe(0)
    expect(await access.exclusive(() => "gate released")).toBe("gate released")
  })

  it("uses a warm runtime under the shared gate without preparing or touching activity", async () => {
    const readyPort = port("warm")
    const callbackStarted = deferred()
    const finishCallback = deferred()
    let completeHooks = 0
    let prepareCalls = 0
    const access = new ConversationRuntimeAccess({
      prepareOwned: async () => { prepareCalls++; throw new Error("must not prepare") },
      identity: () => ({ port: readyPort, generation: "gen-warm", ready: true, running: true }),
      onUseComplete: () => { completeHooks++ },
    })

    const before = access.activityEpoch
    const borrowed = access.useWarm(async (usedPort) => {
      callbackStarted.resolve()
      await finishCallback.promise
      return usedPort
    })
    await callbackStarted.promise
    expect(access.activeUses).toBe(1)
    expect(access.activityEpoch).toBe(before)
    const writerStarted = deferred()
    const writer = access.exclusive(() => { writerStarted.resolve() })
    expect(access.exclusivePending).toBe(1)
    finishCallback.resolve()
    expect(await borrowed).toBe(readyPort)
    await writerStarted.promise
    await writer
    expect(prepareCalls).toBe(0)
    expect(completeHooks).toBe(0)
  })

  it("rejects warm borrowing with a fixed error when runtime identity is unavailable", async () => {
    let callbackCalls = 0
    const access = new ConversationRuntimeAccess({
      prepareOwned: async () => { throw new Error("must not prepare") },
      identity: () => ({ ready: false, running: false }),
    })

    await expect(access.useWarm(async () => { callbackCalls++; return "unreachable" }))
      .rejects.toThrow("warm runtime unavailable")
    expect(callbackCalls).toBe(0)
    expect(access.activityEpoch).toBe(0)
    expect(access.activeUses).toBe(0)
  })
})
