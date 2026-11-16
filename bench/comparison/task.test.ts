import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskJournal } from "./baseline/journal"
import { parseModelConfig, taskModel, type ModelConfig, type ProviderTransport } from "./baseline/task-model"
import { parseTaskConfig, parseTaskRequest, taskAttemptID, readTaskBody, taskConfigDigest, assertTaskConfiguration } from "./baseline/task-request"
import { LinuxToolPlane, type Exec } from "./baseline/linux"
import { prepareTaskWorkspace, snapshotCommand } from "./baseline/task-workspace"
import { materialize } from "./prepare"
import { fixtureFiles } from "./fixtures"
import { identity, MemoryStore, running } from "./test-support"
import { latch } from "./test-support"
const config: ModelConfig = { model: "test-model", baseURL: "https://provider.invalid/v1", temperature: 0, maxOutputTokens: 100, contextTokens: 2000, maxModelCalls: 2, requestTimeoutMs: 5000 }
function response(complete = true) {
  const chunk = (choices: unknown[], usage?: unknown) => "data: " + JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 0, model: config.model, choices, ...(usage ? { usage } : {}) }) + "\n\n"
  return new Response(chunk([{ index: 0, delta: { content: "answer" }, finish_reason: null }]) + (complete ? chunk([{ index: 0, delta: {}, finish_reason: "stop" }], { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }) + "data: [DONE]\n\n" : ""), { headers: { "content-type": "text/event-stream" } })
}

describe("durable task boundary", () => {
  test("concurrent admission and lost acknowledgements retain one immutable attempt", async () => {
    const journal = new TaskJournal(new MemoryStore())
    expect(await Promise.all([journal.admit(identity), journal.admit(identity)])).toEqual([true, false])
    await expect(journal.admit({ ...identity, taskID: "L2" })).rejects.toThrow("conflict")
    await journal.fail("setup failed"); await journal.cleaned()
    expect(await journal.admit(identity)).toBe(false)
    expect((await journal.store.read())?.cleanup).toBe("stopped")
  })

  test("tool claims are durable before effects; completed output can be replayed", async () => {
    const journal = await running()
    expect(await journal.beginTool("tool-1", "shell", "hash")).toBeNull()
    await expect(journal.beginTool("tool-1", "shell", "hash")).rejects.toThrow("ambiguous")
    await journal.finishTool("tool-1", "")
    expect(await journal.beginTool("tool-1", "shell", "hash")).toBe("")
    await expect(journal.beginTool("tool-1", "shell", "different")).rejects.toThrow("conflict")
    expect((await journal.store.read())?.tools).toHaveLength(1)
  })

  test("failed and uncached tool outcomes never execute again", async () => {
    const journal = await running()
    await journal.beginTool("error", "write", "hash"); await journal.finishTool("error", null)
    await expect(journal.beginTool("error", "write", "hash")).rejects.toThrow("ambiguous")
    await journal.beginTool("large", "read", "hash"); await journal.finishTool("large", "x".repeat(50_000))
    const tool = (await journal.store.read())?.tools[1]
    expect(tool?.status).toBe("done"); expect(tool?.output).toBeNull(); expect(tool?.outputBytes).toBe(50_000)
    await expect(journal.beginTool("large", "read", "hash")).rejects.toThrow("ambiguous")
  })

  test("unknown usage and pending tools stop automatic model continuation", async () => {
    const journal = await running()
    expect(await journal.beginModel(2)).toBe(0)
    await expect(journal.beginModel(2)).rejects.toThrow("unknown prior model usage")
    await journal.finishModel(0, 10, 2)
    await journal.beginTool("pending", "shell", "hash")
    await expect(journal.beginModel(2)).rejects.toThrow("unsettled tool")
    await journal.finishTool("pending", "ok")
    expect(await journal.beginModel(2)).toBe(1); await journal.finishModel(1, undefined, -1)
    await expect(journal.beginModel(2)).rejects.toThrow("not a dollar cap")
    const receipt = await journal.store.read()
    expect(receipt?.modelUSD).toBeNull(); expect(receipt?.modelCalls[1]?.outputTokens).toBeNull()
  })

  test("an answer with unsettled effects is ambiguous and cleanup retains evidence", async () => {
    const journal = await running()
    await journal.beginTool("pending", "shell", "hash"); await journal.settle("done", "looks finished")
    expect((await journal.store.read())?.phase).toBe("ambiguous")
    expect((await journal.store.read())?.cleanup).toBe("pending")
    await journal.cleaned()
    expect((await journal.store.read())?.tools[0]?.status).toBe("started")
    await expect(journal.beginModel(2)).rejects.toThrow("not running")
    expect(await journal.admit(identity)).toBe(false)
  })
})

describe("configured task model", () => {
  test("attempt cleanup cancels an in-flight provider request while usage stays unknown", async () => {
    const journal = await running(), stop = new AbortController(), entered = latch()
    let observedAbort = false
    const model = taskModel(config, "synthetic-key", journal, async () => {}, async (_input, init) => {
      entered.release()
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => { observedAbort = true; reject(new Error("synthetic transport canceled")) }
        init?.signal?.addEventListener("abort", abort, { once: true })
        if (init?.signal?.aborted) abort()
      })
    }, stop.signal)
    const work = model.doStream({ prompt: [] })
    await entered.promise; stop.abort()
    await expect(work).rejects.toThrow("usage remains unknown")
    expect(observedAbort).toBe(true); expect((await journal.store.read())?.modelCalls[0]?.finished).toBe(false)
  })
  test("resume refuses changed settings, protocol or provider credentials", async () => {
    const settings = { protocolSHA256: identity.protocolSHA256, model: config, spendBudgetUSD: 1, deadlineMs: 5000 }
    const pinned = { ...identity, configSHA256: await taskConfigDigest(settings, "synthetic-key") }
    await expect(assertTaskConfiguration(pinned, settings, "synthetic-key", identity.protocolSHA256)).resolves.toBeUndefined()
    await expect(assertTaskConfiguration(pinned, { ...settings, model: { ...config, temperature: 1 } }, "synthetic-key", identity.protocolSHA256)).rejects.toThrow("changed")
    await expect(assertTaskConfiguration(pinned, settings, "rotated-key", identity.protocolSHA256)).rejects.toThrow("changed")
    await expect(assertTaskConfiguration(pinned, settings, "synthetic-key", "stale")).rejects.toThrow("changed")
  })
  test("task bodies are byte-bounded and stalled streams are canceled", async () => {
    expect(await readTaskBody(new Request("https://local.invalid", { method: "POST", body: '{"taskID":"L1"}' }))).toEqual({ taskID: "L1" })
    await expect(readTaskBody(new Request("https://local.invalid", { method: "POST", body: "x".repeat(5000) }))).rejects.toThrow("limit")
    let canceled = false
    const body = new ReadableStream<Uint8Array>({ cancel() { canceled = true } })
    await expect(readTaskBody(new Request("https://local.invalid", { method: "POST", body }), 10)).rejects.toThrow("deadline")
    expect(canceled).toBe(true)
  })
  test("frozen tasks and explicit server settings reject payload substitution", () => {
    const body = { id: taskAttemptID("L1", "cold", 1, identity.protocolSHA256), taskID: "L1", protocolSHA256: identity.protocolSHA256, condition: "cold", repetition: 1 }
    expect(parseTaskRequest(body, identity.protocolSHA256).taskID).toBe("L1")
    for (const row of [{ ...body, prompt: "substitute" }, { ...body, taskID: "unknown" }, { ...body, condition: "fault" }, { ...body, id: "../escape" }, { ...body, id: "new-alias-attempt" }]) expect(() => parseTaskRequest(row, identity.protocolSHA256)).toThrow()
    const valid = { enabled: true, protocolSHA256: identity.protocolSHA256, spendBudgetUSD: 1, deadlineMs: 5000, model: config }
    expect(parseTaskConfig(JSON.stringify(valid), identity.protocolSHA256).model.model).toBe(config.model)
    for (const row of [{ ...valid, enabled: false }, { ...valid, spendBudgetUSD: null }, { ...valid, protocolSHA256: "stale" }]) expect(() => parseTaskConfig(JSON.stringify(row), identity.protocolSHA256)).toThrow()
    for (const baseURL of ["http://provider.invalid/v1", "https://user:secret@provider.invalid/v1", "https://provider.invalid/v1?token=secret"]) expect(() => parseModelConfig({ ...config, baseURL })).toThrow()
  })

  test("actual provider parser uses pinned settings, separate auth and terminal usage", async () => {
    const journal = await running(); let calls = 0
    const transport: ProviderTransport = async (input, init) => {
      calls++; expect(String(input)).toBe(config.baseURL + "/chat/completions")
      expect(init?.redirect).toBe("manual"); expect(init?.signal).toBeDefined()
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-key")
      const body = JSON.parse(String(init?.body))
      expect(body.temperature).toBe(0); expect(body.max_tokens).toBe(100); expect(body.model).toBe(config.model)
      expect(String(init?.body)).not.toContain("synthetic-key")
      return response()
    }
    const model = taskModel(config, "synthetic-key", journal, async () => {}, transport)
    const result = await model.doStream({ prompt: [], temperature: 1.8, maxOutputTokens: 999 })
    const parts = []; for await (const part of result.stream) parts.push(part)
    expect(parts.some(part => part.type === "text-delta")).toBe(true); expect(calls).toBe(1)
    expect((await journal.store.read())?.modelCalls[0]).toEqual({ id: 0, finished: true, inputTokens: 10, outputTokens: 2 })
    expect((await journal.store.read())?.modelUSD).toBeNull()
  })

  test("provider redirects are never followed or retried", async () => {
    const journal=await running();let calls=0
    const model=taskModel(config,"synthetic-key",journal,async()=>{},async(_input,init)=>{
      calls++;expect(init?.redirect).toBe("manual")
      return new Response(null,{status:307,headers:{location:"https://other.invalid/leak"}})
    })
    await expect(model.doStream({prompt:[]})).rejects.toThrow("usage remains unknown")
    await expect(model.doStream({prompt:[]})).rejects.toThrow("unknown prior model usage")
    expect(calls).toBe(1)
  })

  test("provider failure remains unknown, is redacted and is not automatically retried", async () => {
    const journal = await running(); let calls = 0
    const model = taskModel(config, "synthetic-key", journal, async () => {}, async () => {
      calls++; return new Response(JSON.stringify({ error: { message: "echo synthetic-key" } }), { status: 503 })
    })
    await expect(model.doStream({ prompt: [] })).rejects.toThrow("usage remains unknown")
    await expect(model.doStream({ prompt: [] })).rejects.toThrow("unknown prior model usage")
    expect(calls).toBe(1); expect((await journal.store.read())?.modelCalls[0]?.finished).toBe(false)
    expect(JSON.stringify(await journal.store.read())).not.toContain("synthetic-key")
  })

  test("truncated streams cannot turn a terminal answer into known completion", async () => {
    const journal = await running()
    const model = taskModel(config, "synthetic-key", journal, async () => {}, async () => response(false))
    for await (const _ of (await model.doStream({ prompt: [] })).stream) { /* drain */ }
    await journal.settle("done", "answer")
    expect((await journal.store.read())?.phase).toBe("ambiguous")
    expect((await journal.store.read())?.modelCalls[0]?.finished).toBe(false)
  })
})

test("native fixture installer matches host Git bases and exports no private checks", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "r0-23-task-workspace-"))
  try {
    for (const repo of ["ledger", "queue"] as const) {
      const root = join(temporary, repo), host = join(temporary, repo + "-host")
      const { mkdir } = await import("node:fs/promises"); await mkdir(root)
      const exec: Exec = async (argv, options) => {
        const child = Bun.spawn(argv, { cwd: options.cwd, stdin: options.stdin, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH } })
        return { stdout: child.stdout, stderr: child.stderr, exitCode: child.exited, kill: () => { if (child.exitCode === null) child.kill(9) } }
      }
      const plane = new LinuxToolPlane(exec, root), signal = AbortSignal.timeout(10_000)
      const commit = await prepareTaskWorkspace(repo === "ledger" ? "L1" : "Q1", identity.id, plane, signal)
      expect(commit).toBe(await materialize(repo, host))
      const snapshot = JSON.parse(await plane.execute("shell", { command: snapshotCommand }, signal))
      expect(snapshot.files).toEqual(fixtureFiles[repo]); expect(snapshot.quiescence).toBe("unproven")
      expect(await readFile(join(root, ".r0-23-attempt"), "utf8")).toBe(identity.id)
      expect((await readdir(root)).includes("oracle.ts")).toBe(false)
      await expect(prepareTaskWorkspace("L1", identity.id, plane, signal)).rejects.toThrow()
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
