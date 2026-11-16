import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { boundedDockerRunner, checkerCreateArgs, collectWorkspaceCheck, inspectCheckerImage, observeWorkspaceCheck, readLocalCheck } from "../scripts/workspace-check-docker"
import { checkRequest, checkSnapshot, checkerImage, fakeCheckDocker } from "./fixtures/workspace-check"
import "../runtime/check/bootstrap"

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
async function directory() { const path = await mkdtemp(join(tmpdir(), "aboiteau-check-test-")); dirs.push(path); return path }

test("owned profile rejects secret environment, overridden entrypoints, volumes and wrong IDs", async () => {
  const request = await checkRequest(), image = checkerImage(request.imageID)
  expect(inspectCheckerImage(image, request.imageID)).toBe("linux/amd64")
  for (const config of [{ ...image[0].Config, Env: [...image[0].Config.Env, "API_TOKEN=SECRET"] }, { ...image[0].Config, Entrypoint: ["/bin/sh"] }, { ...image[0].Config, Volumes: { "/host": {} } }, { ...image[0].Config, User: "root" }, { ...image[0].Config, Healthcheck: { Test: ["CMD", "false"] } }]) expect(() => inspectCheckerImage([{ ...image[0], Config: config }], request.imageID)).toThrow()
  expect(() => inspectCheckerImage(image, "sha256:" + "c".repeat(64))).toThrow()
  const args = checkerCreateArgs(request, "33333333-3333-4333-8333-333333333333")
  for (const flag of ["--pull=never", "--read-only", "--cap-drop", "--security-opt", "--memory", "--pids-limit", "--log-driver"]) expect(args).toContain(flag)
  expect(args[args.indexOf("--network") + 1]).toBe("none")
  for (const forbidden of ["--volume", "-v", "--mount", "--env", "-e", "--publish", "--privileged"]) expect(args).not.toContain(forbidden)
})

test("collector journals before create, ignores fake success stdout, and retains exact identity/log digest", async () => {
  const dir = await directory(), request = await checkRequest(), snapshot = await checkSnapshot()
  const docker = fakeCheckDocker({ exitCode: 7, onCreate: async () => {
    expect(JSON.parse(await readFile(join(dir, "journal.json"), "utf8")).phase).toBe("create_requested")
    expect(await readFile(join(dir, "snapshot.json"), "utf8")).toBe(snapshot.canonicalJSON)
  } })
  const receipt = await collectWorkspaceCheck({ directory: dir, request, snapshot, before: "matched", after: async () => "matched", docker: docker.runner })
  expect(receipt.outcome).toBe("failed")
  expect(receipt.exitCode).toBe(7)
  expect(receipt.sourceSHA256).toBe(snapshot.snapshotSHA256)
  expect(receipt.cleanupConfirmed).toBe(true)
  expect(receipt.logs.stdout.sha256).toMatch(/^[a-f0-9]{64}$/)
  expect((await readLocalCheck(dir)).receipt).toEqual(receipt)
  const count = docker.calls.length
  await expect(collectWorkspaceCheck({ directory: dir, request, snapshot, before: "matched", after: async () => "matched", docker: docker.runner })).rejects.toThrow("never rerun")
  expect(docker.calls.length).toBe(count)
})

test("timeouts, OOM, flood, lost create acknowledgment and failed cleanup stay distinct", async () => {
  for (const [options, outcome] of [[{ timeout: true }, "timeout"], [{ oom: true, exitCode: 137 }, "oom"], [{ flood: true }, "collector_error"], [{ exitCode: 125 }, "collector_error"], [{ createLost: true }, "collector_error"], [{ cleanupFails: true }, "cleanup_unknown"]] as const) {
    const docker = fakeCheckDocker(options)
    const receipt = await collectWorkspaceCheck({ directory: await directory(), request: await checkRequest(), snapshot: await checkSnapshot(), before: "matched", after: async () => "unknown", docker: docker.runner })
    expect(receipt.outcome).toBe(outcome)
    expect(receipt.freshness.after).toBe("unknown")
    expect(docker.calls.some(args => args[0] === "rm")).toBe(true)
    if (options.flood) expect(receipt.logs.stdout.truncated).toBe(true)
  }
})

test("stale/unknown source prevents Docker entirely, observe does not repeat unresolved work", async () => {
  const dir = await directory(), request = await checkRequest(), snapshot = await checkSnapshot(), docker = fakeCheckDocker()
  const receipt = await collectWorkspaceCheck({ directory: dir, request, snapshot, before: "stale", after: async () => "stale", docker: docker.runner })
  expect(receipt.outcome).toBe("not_run")
  expect(docker.calls).toHaveLength(0)
  expect(await observeWorkspaceCheck(dir, docker.runner)).toEqual({ receipt })
  await writeFile(join(dir, "receipt-sha256.json"), '{"sha256":"tampered"}')
  await expect(readLocalCheck(dir)).rejects.toThrow("digest")
  const unresolved = await directory()
  const collectorID = "33333333-3333-4333-8333-333333333333"
  await writeFile(join(unresolved, "journal.json"), JSON.stringify({ schemaVersion: 1, provenance: "local_operator", request, collectorID, sourceSHA256: snapshot.snapshotSHA256, containerName: "aboiteau-check-" + collectorID, phase: "start_requested" }))
  const observed = await observeWorkspaceCheck(unresolved, docker.runner)
  expect(observed).toEqual({ status: "stopped_unsettled", requestID: request.requestID, executionRetried: false })
  expect(docker.calls.map(args => args[0])).toEqual(["inspect"])
})

test("lost create acknowledgement never removes a different collector's container for the same request", async () => {
  const docker = fakeCheckDocker({ createLost: true, observedOwner: "44444444-4444-4444-8444-444444444444" })
  const receipt = await collectWorkspaceCheck({ directory: await directory(), request: await checkRequest(), snapshot: await checkSnapshot(), before: "matched", after: async () => "matched", docker: docker.runner })
  expect(receipt.outcome).toBe("cleanup_unknown")
  expect(docker.calls.some(args => args[0] === "rm")).toBe(false)
})

test("real bounded Docker-client subprocess drops service environment and bounds floods/timeouts/descendants", async () => {
  const dir = await directory(), program = join(dir, "client.ts"), marker = join(dir, "descendant-ran")
  await writeFile(program, `
if(process.argv.includes("flood")){for(let n=0;n<100;n++)process.stdout.write("x".repeat(65536));setInterval(()=>{},1000)}
else if(process.argv.includes("hang")){Bun.spawn([process.execPath,"-e",${JSON.stringify("setTimeout(async()=>{await Bun.write(" + JSON.stringify(marker) + ",'unexpected')},600)")}],{stdout:"inherit",stderr:"inherit"});console.log("child launched");setInterval(()=>{},1000)}
else console.log(JSON.stringify({token:process.env.ABOITEAU_API_TOKEN,provider:process.env.OPENAI_API_KEY,args:process.argv.slice(2)}))
`)
  const run = boundedDockerRunner([process.execPath, program])
  const token = process.env.ABOITEAU_API_TOKEN, provider = process.env.OPENAI_API_KEY
  process.env.ABOITEAU_API_TOKEN = "synthetic-collector-secret"
  process.env.OPENAI_API_KEY = "synthetic-provider-secret"
  try {
    const result = await run(["literal;echo", "$(unsafe)"], { timeoutMs: 2000 })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({ args: ["literal;echo", "$(unsafe)"] })
  } finally {
    if (token === undefined) delete process.env.ABOITEAU_API_TOKEN; else process.env.ABOITEAU_API_TOKEN = token
    if (provider === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = provider
  }
  const flood = await run(["flood"], { timeoutMs: 2000 })
  expect(flood.outputExceeded).toBe(true)
  expect(flood.stdout.byteLength).toBe(65536)
  const started = Date.now(), hang = await run(["hang"], { timeoutMs: 250 })
  expect(hang.timedOut).toBe(true)
  expect(Date.now() - started).toBeLessThan(1500)
  expect(new TextDecoder().decode(hang.stdout)).toContain("child launched")
  await new Promise(resolve => setTimeout(resolve, 750))
  expect(await Bun.file(marker).exists()).toBe(false)
})
