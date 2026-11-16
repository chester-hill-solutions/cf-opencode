import { expect, mock, test } from "bun:test"
import { fixtureFiles, referenceFiles } from "./fixtures"
import { FROZEN_PROTOCOL_SHA256 } from "./baseline/freeze.generated"
import { TRUSTED_ORACLE } from "../../.wrangler/comparison-preflight/oracle-source"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

// Only pure validation/preparation is exercised. No submitted code executes on the host.
mock.module("cloudflare:workers", () => ({ DurableObject: class {} }))
const { parseEvaluationInput, prepareEvaluationFiles, trustedOraclePassed, qualifySmokeEvaluator, evaluatorBunFlags } = await import("./baseline/evaluator")
const id = (task = "L1") => `r0-23-${FROZEN_PROTOCOL_SHA256.slice(0, 12)}-${task.toLowerCase()}-cold-1`
const body = (files: Record<string, unknown>, taskID = "L1") => ({ id: id(taskID), taskID, files })

test("only the canonical smoke cells and matching route identity are accepted", () => {
  expect(parseEvaluationInput(body({ "src/index.ts": "bytes" }), id()).taskID).toBe("L1")
  expect(parseEvaluationInput(body({ "src/index.ts": "bytes" }, "Q1"), id("Q1")).taskID).toBe("Q1")
  const prefixed = { ...body({}), id: "aboiteau-" + id() }
  expect(parseEvaluationInput(prefixed, prefixed.id).id).toBe(prefixed.id)
  for (const input of [{ ...body({}), taskID: "L2" }, { ...body({}), id: "arbitrary-123" }, { ...body({}), command: "unsafe" }]) {
    expect(() => parseEvaluationInput(input, id())).toThrow()
  }
  expect(() => parseEvaluationInput(body({}), id("Q1"))).toThrow()
})

test("snapshot paths, object metadata and file/directory conflicts are refused", () => {
  for (const path of ["../escape", "/absolute", "src/../../escape", "src\\escape", "src//index.ts", ".git/config", ".r0-23-attempt", "src/./index.ts", "src\0index.ts"]) {
    expect(() => parseEvaluationInput(body({ [path]: "bytes" }), id())).toThrow()
  }
  expect(() => parseEvaluationInput(body({ "src/index.ts": { type: "symlink", target: "/grading/oracle.js" } }), id())).toThrow()
  expect(() => parseEvaluationInput(body({ src: "file", "src/index.ts": "other" }), id())).toThrow()
  expect(() => parseEvaluationInput(body(Object.create({ "src/index.ts": "inherited" })), id())).toThrow()
})

test("snapshot limits count UTF-8 bytes and bound file count", () => {
  expect(() => parseEvaluationInput(body({ "src/index.ts": "é".repeat(21_000) }), id())).toThrow()
  expect(() => parseEvaluationInput(body(Object.fromEntries(Array.from({ length: 65 }, (_, index) => ["file" + index, "x"]))), id())).toThrow()
  expect(parseEvaluationInput(body({ "src/index.ts": "x".repeat(40 * 1024) }), id()).files["src/index.ts"]!.length).toBe(40 * 1024)
})

test("trusted basic tests are restored while changed agent tests and other files are retained", () => {
  const input = parseEvaluationInput(body({ "src/index.ts": "agent code", "test/basic.test.ts": "agent changed basic", "test/agent-basic.test.ts": "another legitimate test" }), id())
  const prepared = prepareEvaluationFiles(input)
  expect(prepared.files["test/basic.test.ts"]).toBe(fixtureFiles.ledger["test/basic.test.ts"])
  expect(prepared.retainedAgentTest).toBe("test/agent-basic-2.test.ts")
  expect(prepared.files[prepared.retainedAgentTest!]).toBe("agent changed basic")
  expect(prepared.files["test/agent-basic.test.ts"]).toBe("another legitimate test")
  expect(prepared.files["src/index.ts"]).toBe("agent code")
  expect(input.files["test/basic.test.ts"]).toBe("agent changed basic")
  const queue = prepareEvaluationFiles(parseEvaluationInput(body({}, "Q1"), id("Q1")))
  expect(queue.files["test/basic.test.ts"]).toBe(fixtureFiles.queue["test/basic.test.ts"])
  expect(queue.retainedAgentTest).toBe(null)
})

test("oracle success requires a single exact matching JSON pass result", () => {
  expect(trustedOraclePassed('{"taskID":"L1","passed":true}\n', "L1")).toBe(true)
  for (const output of ['{"taskID":"Q1","passed":true}', '{"taskID":"L1","passed":"true"}', '{"taskID":"L1","passed":false}', 'noise\n{"taskID":"L1","passed":true}', '{"taskID":"L1","passed":true,"extra":1}', 'true']) {
    expect(trustedOraclePassed(output, "L1")).toBe(false)
  }
})

test("model-free qualification submits only built-in base/reference fixtures to separate grader identities", async () => {
  const calls: Array<{ name: string; path: string; body: unknown }> = []
  const env = { EVALUATOR: { getByName(name: string) { return { async fetch(request: Request) {
    const input = await request.json() as { id: string; taskID: string }
    calls.push({ name, path: new URL(request.url).pathname, body: input })
    return Response.json({ ...input, publicTestsPassed: true, oraclePassed: name.startsWith("qualify-reference-"), runtimeStopped: true,
      providerCalls: 0, phase: "complete", diagnostics: {} })
  } } } } }
  for (const taskID of ["L1", "Q1"] as const) for (const mode of ["base", "reference"] as const) {
    const receipt = await qualifySmokeEvaluator(env as never, taskID, mode)
    expect(receipt.publicTestsPassed).toBe(true)
    expect(receipt.oraclePassed).toBe(mode === "reference")
    expect(receipt.runtimeStopped).toBe(true)
    const observed = calls.at(-1)!
    expect(observed.name).toBe("qualify-" + mode + "-" + id(taskID))
    expect(observed.path).toBe("/evaluate/" + id(taskID))
    const repo = taskID === "L1" ? "ledger" : "queue"
    expect(observed.body).toEqual({ id: id(taskID), taskID, files: { ...fixtureFiles[repo], ...(mode === "reference" ? referenceFiles[repo] : {}) } })
  }
  expect(calls).toHaveLength(4)
})

test("model-free qualification refuses invalid inputs before selecting any grader", async () => {
  let selected = false
  const env = { EVALUATOR: { getByName() { selected = true; throw new Error("must not be selected") } } }
  await expect(qualifySmokeEvaluator(env as never, "L2" as never, "base")).rejects.toThrow("fixed evaluator qualification")
  await expect(qualifySmokeEvaluator(env as never, "L1", "caller-files" as never)).rejects.toThrow("fixed evaluator qualification")
  expect(selected).toBe(false)
})

test("model-free qualification retains cleanup-failure evidence and rejects cached or mismatched receipts", async () => {
  let value: unknown = { id: id(), taskID: "L1", publicTestsPassed: false, oraclePassed: false, runtimeStopped: false,
    providerCalls: 0, phase: "cleanup-unconfirmed", diagnostics: { failure: "unconfirmed stop" } }
  let status = 503
  const env = { EVALUATOR: { getByName() { return { async fetch() { return Response.json(value, { status }) } } } } }
  expect((await qualifySmokeEvaluator(env as never, "L1", "base")).runtimeStopped).toBe(false)
  value = { cached: true, receipt: value }; status = 409
  await expect(qualifySmokeEvaluator(env as never, "L1", "base")).rejects.toThrow("invalid evaluator qualification receipt")
  value = { id: id("Q1"), taskID: "Q1", publicTestsPassed: true, oraclePassed: true, runtimeStopped: true, providerCalls: 0, phase: "complete", diagnostics: {} }; status = 200
  await expect(qualifySmokeEvaluator(env as never, "L1", "base")).rejects.toThrow("invalid evaluator qualification receipt")
})

test("the grader's exact Bun flags execute trusted public tests and discriminate bundled base/reference oracles", async () => {
  // These are repository-owned fixtures only. Never substitute model-generated files here.
  const root = await mkdtemp(join(tmpdir(), "r0-23-trusted-evaluator-"))
  const config = join(root, "bunfig.toml"), oracle = join(root, "oracle.js")
  const flags = evaluatorBunFlags.map(flag => flag === "--config=/grading/bunfig.toml" ? "--config=" + config : flag)
  const run = async (argv: string[], cwd: string) => {
    const child = Bun.spawn([process.execPath, ...flags, ...argv], { cwd, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH } })
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill(9) }, 5000)
    try {
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      return { exitCode, stdout, stderr }
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(9) }
  }
  try {
    await writeFile(config, '[install]\nauto = "disable"\n')
    await writeFile(oracle, TRUSTED_ORACLE)
    for (const [taskID, repo] of [["L1", "ledger"], ["Q1", "queue"]] as const) for (const mode of ["base", "reference"] as const) {
      const destination = join(root, taskID, mode)
      for (const [path, content] of Object.entries({ ...fixtureFiles[repo], ...(mode === "reference" ? referenceFiles[repo] : {}) })) {
        await mkdir(dirname(join(destination, path)), { recursive: true })
        await writeFile(join(destination, path), content)
      }
      const publicResult = await run(["test", "--timeout", "3000", "--bail"], destination)
      expect(publicResult.exitCode).toBe(0)
      // Exit 0 alone missed the original CLI no-op. Require evidence that a test actually ran.
      expect(publicResult.stderr).toContain("1 pass")
      const result = await run([oracle, taskID, destination], root)
      expect(result.exitCode === 0).toBe(mode === "reference")
      expect(trustedOraclePassed(result.stdout, taskID)).toBe(mode === "reference")
    }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 20_000)
