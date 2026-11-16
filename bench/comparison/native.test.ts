import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Exec } from "./baseline/linux"
import { assertEmptyNativeActionBody, boundedObservation, fixtureCommits, observeNativeCancellation, runFixedNativeChecks } from "./baseline/native-checks"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "r0-23-native-checks-")); roots.push(root)
  for (const name of ["tools", "ledger", "queue", "cancellation"]) await mkdir(join(root, name))
  const exec: Exec = async (argv, options) => {
    const child = Bun.spawn(argv, { cwd: options.cwd, stdin: options.stdin, stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } })
    return { stdout: child.stdout, stderr: child.stderr, exitCode: child.exited,
      kill(signal = 15) { if (child.exitCode === null) child.kill(signal) } }
  }
  return { root, exec, signal: new AbortController().signal }
}

test("fixed native checks exercise real local tools, both frozen Git fixtures and cancellation observations", async () => {
  const { root, exec, signal } = await fixture()
  const result = await runFixedNativeChecks(exec, root, signal)
  expect(result.commits).toEqual(fixtureCommits)
  expect(result.checks.length).toBeGreaterThan(15)
  expect(result.checks.every(check => check.passed)).toBe(true)
  expect(result.cancellation.callerReturned).toBe(true)
  expect(result.cancellation.directExitObserved).toBe(true)
  expect(result.cancellation.descendantProgressAfterAbort).toBe(true)
  expect(result.cancellation.descendantProgressAfterKill).toBe(false)
  expect(result.cancellation.descendantStopped).toBe("unproven")
}, 30_000)

test("cancellation observation records descendant progress rather than claiming tree shutdown", async () => {
  const { root, exec, signal } = await fixture()
  const result = await observeNativeCancellation(exec, join(root, "cancellation"), signal)
  expect(result.callerRejectedAsUncertain).toBe(true)
  expect(result.directExitObserved).toBe(true)
  expect(result.descendantProgressAfterAbort).toBe(true)
  expect(result.descendantKillRequested).toBe(true)
  expect(result.descendantStopped).toBe("unproven")
}, 15_000)

test("a bounded observation returns even when the underlying process never acknowledges", async () => {
  await expect(boundedObservation(new Promise<never>(() => {}), 10)).rejects.toThrow("deadline")
})

test("failed durable progress acknowledgement stops the fixed check sequence", async () => {
  const { root, exec, signal } = await fixture()
  let observed = 0
  await expect(runFixedNativeChecks(exec, root, signal, async () => {
    observed++
    throw new Error("synthetic receipt persistence unavailable")
  })).rejects.toThrow("receipt persistence")
  expect(observed).toBe(1)
  expect(await Bun.file(join(root, "tools", "probe.txt")).text()).toBe("alpha\n")
  expect(await Bun.file(join(root, "ledger", ".git", "HEAD")).exists()).toBe(false)
})

test("fixed native actions accept null bodies and empty nonnull HTTP streams", async () => {
  await assertEmptyNativeActionBody(new Request("https://native/native/prepare", { method: "POST" }))
  const empty = new Request("https://native/native/prepare", { method: "POST", body: new Uint8Array(0) })
  expect(empty.body).not.toBe(null)
  await assertEmptyNativeActionBody(empty)
  const emptyChunks = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(0)); controller.close() } })
  await assertEmptyNativeActionBody(new Request("https://native/native/cleanup", { method: "POST", body: emptyChunks }))
})

test("fixed native actions reject actual bytes even with a zero content-length claim", async () => {
  await expect(assertEmptyNativeActionBody(new Request("https://native/native/prepare", {
    method: "POST", headers: { "content-length": "0" }, body: "{}",
  }))).rejects.toThrow("must be empty")
})

test("empty-body inspection has a deadline even if stream cancellation never acknowledges", async () => {
  let cancellations = 0
  const body = new ReadableStream<Uint8Array>({ cancel() { cancellations++; return new Promise<void>(() => {}) } })
  const work = assertEmptyNativeActionBody(new Request("https://native/native/cleanup", { method: "POST", body }), 10)
  await expect(work).rejects.toThrow("deadline")
  expect(cancellations).toBe(1)
})
