import { spawn } from "bun"
import { describe, expect, test } from "bun:test"
import { createLifecycleGate, stopChild } from "../control-lifecycle"

describe("control lifecycle gate", () => {
  test("holds later work until the current asynchronous operation finishes", async () => {
    const gate = createLifecycleGate()
    let release!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    const events: string[] = []
    const first = gate(async () => {
      events.push("first-start")
      await hold
      events.push("first-end")
      return 1
    })
    const second = gate(async () => {
      events.push("second-start")
      return 2
    })
    await Bun.sleep(20)
    expect(events).toEqual(["first-start"])
    release()
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2])
    expect(events).toEqual(["first-start", "first-end", "second-start"])
  })

  test("preserves FIFO order across multiple awaits", async () => {
    const gate = createLifecycleGate()
    const events: string[] = []
    const tasks = [1, 2, 3].map((number) => gate(async () => {
      events.push(`start-${number}`)
      await Bun.sleep(number === 1 ? 20 : 1)
      events.push(`end-${number}`)
      return number
    }))
    await expect(Promise.all(tasks)).resolves.toEqual([1, 2, 3])
    expect(events).toEqual([
      "start-1", "end-1", "start-2", "end-2", "start-3", "end-3",
    ])
  })

  test("continues accepting work after an operation rejects", async () => {
    const gate = createLifecycleGate()
    await expect(gate(async () => { throw new Error("fixture failure") })).rejects.toThrow("fixture failure")
    await expect(gate(async () => "recovered")).resolves.toBe("recovered")
  })
})

describe("bounded child shutdown", () => {
  test("escalates a real child ignoring SIGTERM and waits for its exit", async () => {
    const child = spawn([
      "bun",
      "-e",
      'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)',
    ], { stdout: "pipe", stderr: "ignore" })
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let output = ""
    try {
      const readyDeadline = performance.now() + 2_000
      while (!output.includes("ready")) {
        const remaining = readyDeadline - performance.now()
        if (remaining <= 0) throw new Error("child readiness timed out")
        const next = await Promise.race([
          reader.read(),
          Bun.sleep(remaining).then(() => { throw new Error("child readiness timed out") }),
        ])
        if (next.done) throw new Error("child exited before readiness")
        output += decoder.decode(next.value)
      }
      const started = performance.now()
      await stopChild(child, "fixture child")
      const elapsed = performance.now() - started
      const exitCode = await child.exited
      expect(elapsed).toBeLessThan(5_000)
      expect(typeof exitCode).toBe("number")
      expect(exitCode).not.toBe(0)
    } finally {
      reader.releaseLock()
      if (child.exitCode === null) {
        child.kill("SIGKILL")
        await child.exited
      }
    }
  }, 10_000)
})
