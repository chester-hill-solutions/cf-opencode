import { expect, test } from "bun:test"
import { TaskRuntime, type HarnessPort } from "./baseline/task-runtime"
import { running, identity, latch } from "./test-support"
import { executeTaskTool } from "./baseline/task-plugin"
import { LinuxToolPlane } from "./baseline/linux"

function host(overrides: Partial<HarnessPort> = {}): HarnessPort {
  return { async submit() {}, async wait() { return { status: "done", text: "answer" } }, async abort() {}, async dispose() {}, ...overrides }
}

test("cleanup destroys the container even while SDK cancellation stalls", async () => {
  const journal = await running(), abort = latch(), entered = latch()
  let destroyed = false
  const runtime = new TaskRuntime(journal, async () => {}, host({ async abort() { entered.release(); await abort.promise } }))
  const cleanup = runtime.cleanup({ async destroy() { destroyed = true }, running: () => !destroyed }, 10)
  await entered.promise
  try {
    await Bun.sleep(25)
    expect(destroyed).toBe(true)
    expect(await Promise.race([cleanup, Bun.sleep(10).then(() => "stalled")])).not.toBe("stalled")
  } finally { abort.release(); await cleanup }
})

test("cleanup does not declare disposal or submit after a paused startup", async () => {
  const journal = await running(), start = latch(), entered = latch()
  let submitted = false, destroyed = false
  const runtime = new TaskRuntime(journal, async () => { entered.release(); await start.promise }, host({ async submit() { submitted = true } }))
  const submission = runtime.submit("task", identity.id).catch(() => {})
  await entered.promise
  let result
  try { result = await runtime.cleanup({ async destroy() { destroyed = true }, running: () => !destroyed }, 10) }
  finally { start.release(); await submission }
  expect(result.runtimeStopped).toBe(true)
  expect(result.coordinatorDisposed).toBe(false)
  expect(submitted).toBe(false)
  expect((await journal.store.read())?.cleanup).toBe("stopped")
})

test("observation of not_found cannot fail a concurrent submission", async () => {
  const journal = await running(), accept = latch(), entered = latch()
  let accepted = false
  const runtime = new TaskRuntime(journal, async () => {}, host({
    async submit() { entered.release(); await accept.promise; accepted = true },
    async wait() { return accepted ? { status: "done", text: "answer" } : { status: "unanswered", reason: "not_found" } },
  }))
  const submitting = runtime.submit("task", identity.id)
  await entered.promise
  try { await runtime.observe(identity.id) }
  finally { accept.release(); await submitting }
  expect((await journal.store.read())?.phase).toBe("running")
  await runtime.observe(identity.id)
  expect((await journal.store.read())?.phase).toBe("done")
})

test("unconfirmed tool cancellation blocks automatic model and tool continuation", async () => {
  const journal = await running(), entered = latch(), controller = new AbortController()
  const plane = new LinuxToolPlane(async () => {
    entered.release()
    return { stdout: new ReadableStream(), stderr: new ReadableStream(), exitCode: new Promise<number>(() => {}), kill() {} }
  }, "/unused-synthetic-root")
  const work = executeTaskTool(plane, journal, "tool-1", "shell", { command: "synthetic-only" }, controller.signal)
  await entered.promise; controller.abort()
  await expect(work).rejects.toThrow("stop unproven")
  await expect(journal.beginModel(2)).rejects.toThrow()
  await expect(journal.beginTool("tool-2", "shell", "retry")).rejects.toThrow()
})

test("cleanup attempts container stop even when receipt persistence stalls", async () => {
  const journal = await running(), persistence = latch(), entered = latch()
  let destroyed = false
  const originalFail = journal.fail.bind(journal)
  journal.fail = async stage => { entered.release(); await persistence.promise; await originalFail(stage) }
  const runtime = new TaskRuntime(journal, async () => {}, host())
  const cleanup = runtime.cleanup({ async destroy() { destroyed = true }, running: () => !destroyed }, 10)
  await entered.promise
  try { await Bun.sleep(25); expect(destroyed).toBe(true) }
  finally { persistence.release(); await cleanup }
})

test("an observed answer can settle before the submission acknowledgement returns", async () => {
  const journal = await running(), accept = latch(), entered = latch()
  const runtime = new TaskRuntime(journal, async () => {}, host({ async submit() { entered.release(); await accept.promise } }))
  const submitting = runtime.submit("task", identity.id)
  await entered.promise
  try { await runtime.observe(identity.id) }
  finally { accept.release() }
  await expect(submitting).resolves.toBeUndefined()
  const receipt = await journal.store.read()
  expect(receipt?.phase).toBe("done"); expect(receipt?.submission).toBe("accepted")
})

test("a known accepted operation that disappears remains ambiguous", async () => {
  const journal = await running()
  const runtime = new TaskRuntime(journal, async () => {}, host({ async wait() { return { status: "unanswered", reason: "not_found" } } }))
  await runtime.submit("task", identity.id)
  expect(await runtime.observe(identity.id)).toBe("submission-unconfirmed")
  expect((await journal.store.read())?.phase).toBe("ambiguous")
})

test("an unconfirmed container stop cannot write a stopped receipt", async () => {
  const journal = await running(), destroyed = latch()
  let containerRunning = true
  const runtime = new TaskRuntime(journal, async () => {}, host())
  try {
    const result = await runtime.cleanup({ async destroy() { await destroyed.promise; containerRunning = false }, running: () => containerRunning }, 10)
    expect(result.runtimeStopped).toBe(false); expect(result.cleanupRecorded).toBe(false)
    expect((await journal.store.read())?.cleanup).toBe("pending")
  } finally { destroyed.release() }
})

test("confirmed container stop with a failed receipt write reports partial cleanup", async () => {
  const journal = await running()
  journal.cleaned = async () => { throw new Error("synthetic storage failure") }
  const runtime = new TaskRuntime(journal, async () => {}, host())
  const result = await runtime.cleanup({ async destroy() {}, running: () => false }, 10)
  expect(result.runtimeStopped).toBe(true); expect(result.cleanupRecorded).toBe(false)
  expect(result.stopFenceRecorded).toBe(true); expect((await journal.store.read())?.cleanup).toBe("pending")
})

test("ordinary observed process failure still permits corrective coding work", async () => {
  const journal = await running()
  const plane = new LinuxToolPlane(async () => ({ stdout: null, stderr: null, exitCode: Promise.resolve(7), kill() {} }), "/unused-synthetic-root")
  await expect(executeTaskTool(plane, journal, "test-run", "shell", { command: "synthetic failing test" }, new AbortController().signal)).rejects.toThrow("7")
  expect((await journal.store.read())?.phase).toBe("running")
  expect(await journal.beginModel(2)).toBe(0)
})

test("a successful effect with an unacknowledged receipt is not rewritten as tool failure", async () => {
  const journal = await running()
  const finish = journal.finishTool.bind(journal)
  let writes = 0
  journal.finishTool = async (...args) => {
    if (++writes === 1) throw new Error("synthetic receipt write acknowledgement lost")
    await finish(...args)
  }
  await expect(executeTaskTool({ async execute() { return "written" } }, journal, "write-1", "write", { path: "file", content: "x" }, new AbortController().signal)).rejects.toThrow("acknowledgement lost")
  expect((await journal.store.read())?.tools[0]?.status).toBe("started")
  await expect(journal.beginModel(2)).rejects.toThrow()
})

test("cleanup retries cannot confirm disposal while a prior SDK close is pending", async () => {
  const journal = await running(), firstClose = latch()
  let disposals = 0
  const runtime = new TaskRuntime(journal, async () => {}, host({ async dispose() { if (++disposals === 1) await firstClose.promise } }))
  const container = { async destroy() {}, running: () => false }
  try {
    expect((await runtime.cleanup(container, 5)).coordinatorDisposed).toBe(false)
    expect((await runtime.cleanup(container, 5)).coordinatorDisposed).toBe(false)
    expect(disposals).toBe(1)
    expect((await journal.store.read())?.cleanupCoordinatorDisposed).toBe(false)
  } finally { firstClose.release() }
  expect((await runtime.cleanup(container, 5)).coordinatorDisposed).toBe(true)
})

test("a missing result captured before admission cannot invalidate a later accepted submission", async () => {
  const journal = await running(), accept = latch(), submittingNow = latch(), queried = latch(), deliver = latch()
  let accepted = false
  const runtime = new TaskRuntime(journal, async () => {}, host({
    async submit() { submittingNow.release(); await accept.promise; accepted = true },
    async wait() {
      const result = accepted ? { status: "done", text: "answer" } : { status: "unanswered", reason: "not_found" }
      queried.release(); await deliver.promise; return result
    },
  }))
  const submission = runtime.submit("task", identity.id)
  await submittingNow.promise
  const observation = runtime.observe(identity.id)
  await queried.promise
  accept.release(); await submission
  deliver.release(); await observation
  expect((await journal.store.read())?.phase).toBe("running")
  await runtime.observe(identity.id)
  expect((await journal.store.read())?.phase).toBe("done")
})
