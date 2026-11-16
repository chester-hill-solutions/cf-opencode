import { DurableObject } from "cloudflare:workers"
import { TRUSTED_ORACLE } from "../../../.wrangler/comparison-preflight/oracle-source"
import { QUALIFICATION_ARTIFACT } from "../../../scripts/native-storage-qualification/artifact"
import { fixtureFiles, referenceFiles } from "../fixtures"
import { FROZEN_PROTOCOL_SHA256 } from "./freeze.generated"

const ROOT = "/grading/repo"
const KEY = "smoke-evaluation"
const MAX_FILES = 64
const MAX_BYTES = 40 * 1024
const MAX_BODY = 300_000
// Bun treats a separated --config value as a different CLI path and can exit 0 without executing.
export const evaluatorBunFlags = ["--no-env-file", "--no-install", "--config=/grading/bunfig.toml"] as const
type SmokeTask = "L1" | "Q1"
export interface EvaluationInput { id: string; taskID: SmokeTask; files: Record<string, string> }

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" &&
  !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))

/** The HTTP boundary accepts plain file bytes only, never filesystem metadata or caller commands. */
export function parseEvaluationInput(value: unknown, pathID: string): EvaluationInput {
  if (!record(value) || Object.keys(value).sort().join(",") !== "files,id,taskID") throw new Error("evaluation shape")
  if (value.taskID !== "L1" && value.taskID !== "Q1") throw new Error("smoke task required")
  const canonical = `r0-23-${FROZEN_PROTOCOL_SHA256.slice(0, 12)}-${value.taskID.toLowerCase()}-cold-1`
  if (value.id !== pathID || (value.id !== canonical && value.id !== "aboiteau-" + canonical)) throw new Error("canonical smoke identity required")
  if (!record(value.files) || Object.keys(value.files).length > MAX_FILES) throw new Error("snapshot file limit")
  const files = Object.create(null) as Record<string, string>
  let bytes = 0
  for (const [path, content] of Object.entries(value.files)) {
    if (path.length > 200 || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path) || path.split("/").some(part => part === "." || part === ".." || part === ".git") || path === ".r0-23-attempt") throw new Error("snapshot path refused")
    if (typeof content !== "string" || (bytes += new TextEncoder().encode(content).byteLength) > MAX_BYTES) throw new Error("snapshot byte/type limit")
    files[path] = content
  }
  for (const path of Object.keys(files)) {
    const parts = path.split("/")
    while (parts.length > 1) { parts.pop(); if (Object.hasOwn(files, parts.join("/"))) throw new Error("snapshot file/directory conflict") }
  }
  return { id: pathID, taskID: value.taskID, files }
}

/** Preserve a changed agent test; restore the original trusted public regression separately. */
export function prepareEvaluationFiles(input: EvaluationInput): { files: Record<string, string>; retainedAgentTest: string | null } {
  const repo = input.taskID === "L1" ? "ledger" : "queue"
  const trusted = fixtureFiles[repo]["test/basic.test.ts"]
  const files = Object.assign(Object.create(null), input.files) as Record<string, string>
  let retainedAgentTest: string | null = null
  const changed = files["test/basic.test.ts"]
  if (changed !== undefined && changed !== trusted) {
    let index = 1
    do { retainedAgentTest = `test/agent-basic${index === 1 ? "" : "-" + index}.test.ts`; index++ } while (Object.hasOwn(files, retainedAgentTest))
    files[retainedAgentTest] = changed
  }
  if (Object.hasOwn(files, "test")) throw new Error("snapshot blocks trusted test directory")
  files["test/basic.test.ts"] = trusted
  return { files, retainedAgentTest }
}

export function trustedOraclePassed(stdout: string, taskID: SmokeTask): boolean {
  try {
    const value: unknown = JSON.parse(stdout.trim())
    return record(value) && Object.keys(value).sort().join(",") === "passed,taskID" && value.taskID === taskID && value.passed === true
  } catch { return false }
}

async function within<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("evaluation deadline")), milliseconds) })]) }
  finally { if (timer) clearTimeout(timer) }
}

async function readBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > MAX_BODY || !request.body) throw new Error("evaluation body limit")
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  try {
    const read = async () => {
      for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > MAX_BODY) throw new Error("evaluation body limit"); chunks.push(part.value) }
      const data = new Uint8Array(bytes); let offset = 0
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength }
      return JSON.parse(new TextDecoder().decode(data)) as unknown
    }
    return await within(read(), 5000)
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
}

const COPY = String.raw`
const fs=await import("node:fs/promises"),path=await import("node:path");
const input=JSON.parse(await Bun.stdin.text());
await fs.mkdir("/grading");await fs.mkdir("/grading/repo");
for(const [name,content] of Object.entries(input.files)){
 const target=path.resolve("/grading/repo",name);
 if(typeof content!=="string"||!target.startsWith("/grading/repo/"))throw new Error("invalid snapshot");
 await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,content,{flag:"wx"});
}
await fs.writeFile("/grading/oracle.js",input.oracle,{flag:"wx"});
await fs.writeFile("/grading/bunfig.toml","[install]\nauto = \"disable\"\n",{flag:"wx"});
`

interface CommandResult { exitCode: number | null; stdout: string; failure: "command_failed" | "observation_failed" | null }
type Container = NonNullable<DurableObjectState["container"]>
async function command(container: Container, argv: string[], cwd: string, milliseconds: number, input?: string): Promise<CommandResult> {
  let child: Awaited<ReturnType<Container["exec"]>> | undefined
  const signal = AbortSignal.timeout(milliseconds)
  const text = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
    if (!stream) return ""
    const reader = stream.getReader(); let bytes = 0, result = ""; const decoder = new TextDecoder()
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 8192) throw new Error("evaluation output bound"); result += decoder.decode(part.value, { stream: true }) }
      return result + decoder.decode()
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
  }
  try {
    const run = async (): Promise<CommandResult> => {
      const launched = container.exec(argv, { cwd, signal, stdout: "pipe", stderr: "pipe",
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", BUN_OPTIONS: "" },
        ...(input === undefined ? {} : { stdin: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(input)); controller.close() } }) }) })
      void launched.then(process => { if (signal.aborted) { try { process.kill(9) } catch {} } }, () => {})
      child = await launched
      const [exitCode, stdout] = await Promise.all([child.exitCode, text(child.stdout), text(child.stderr)])
      return { exitCode, stdout, failure: exitCode === 0 ? null : "command_failed" }
    }
    return await within(run(), milliseconds)
  } catch {
    try { child?.kill(9) } catch {}
    return { exitCode: null, stdout: "", failure: "observation_failed" }
  } finally {
    void child?.stdout?.cancel().catch(() => {}); void child?.stderr?.cancel().catch(() => {})
  }
}

interface EvaluationReceipt {
  id: string
  taskID: SmokeTask
  publicTestsPassed: boolean
  oraclePassed: boolean
  runtimeStopped: boolean
  providerCalls: 0
  phase: "grading" | "complete" | "cleanup-unconfirmed"
  diagnostics: { copiedFiles: number; retainedAgentTest: string | null; publicExitCode: number | null; oracleExitCode: number | null; failure: string | null }
}

/** Model-free qualification uses the real grader with built-in fixtures and separate one-shot identities. */
export async function qualifySmokeEvaluator(env: ComparisonBindings, taskID: SmokeTask, mode: "base" | "reference"): Promise<EvaluationReceipt> {
  if ((taskID !== "L1" && taskID !== "Q1") || (mode !== "base" && mode !== "reference")) throw new Error("fixed evaluator qualification required")
  const repo = taskID === "L1" ? "ledger" : "queue"
  const id = `r0-23-${FROZEN_PROTOCOL_SHA256.slice(0, 12)}-${taskID.toLowerCase()}-cold-1`
  const files = { ...fixtureFiles[repo], ...(mode === "reference" ? referenceFiles[repo] : {}) }
  return within((async () => {
    const response = await env.EVALUATOR.getByName("qualify-" + mode + "-" + id).fetch(new Request("https://evaluator/evaluate/" + id, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, taskID, files }), signal: AbortSignal.timeout(60_000),
    }))
    const receipt = await response.json<EvaluationReceipt>()
    if (!record(receipt) || receipt.id !== id || receipt.taskID !== taskID || receipt.providerCalls !== 0 ||
      typeof receipt.publicTestsPassed !== "boolean" || typeof receipt.oraclePassed !== "boolean" || typeof receipt.runtimeStopped !== "boolean" ||
      (receipt.phase !== "complete" && receipt.phase !== "cleanup-unconfirmed") || !record(receipt.diagnostics) ||
      (response.status !== 200 && response.status !== 503)) throw new Error("invalid evaluator qualification receipt")
    // Return failures as evidence too. The parent checks the expected base/reference outcomes.
    return receipt
  })(), 60_000)
}

/** Agent bytes execute only in this separate, credential-free VM. This is not a hostile-code anti-cheating oracle. */
export class SmokeEvaluator extends DurableObject<ComparisonBindings> {
  constructor(ctx: DurableObjectState, env: ComparisonBindings) {
    super(ctx, env)
    if (ctx.container?.running) ctx.waitUntil(ctx.container.setInactivityTimeout(120_000).catch(() => {}))
  }

  private async stop(): Promise<boolean> {
    const container = this.ctx.container
    if (!container) return false
    return within((async () => { if (container.running) await container.destroy(); return container.running === false })(), 5000).catch(() => false)
  }

  async alarm(): Promise<void> {
    const receipt = await this.ctx.storage.get<EvaluationReceipt>(KEY)
    if (!receipt) return
    const runtimeStopped = await this.stop()
    await this.ctx.storage.put(KEY, { ...receipt, runtimeStopped, phase: runtimeStopped ? "complete" : "cleanup-unconfirmed",
      diagnostics: { ...receipt.diagnostics, failure: receipt.diagnostics.failure ?? "grading interrupted; no automatic rerun" } })
    if (runtimeStopped) await this.ctx.storage.deleteAlarm()
    else await this.ctx.storage.setAlarm(Date.now() + 10_000)
  }

  async fetch(request: Request): Promise<Response> {
    const match = new URL(request.url).pathname.match(/^\/evaluate\/([a-zA-Z0-9_-]{8,100})$/)
    if (request.method !== "POST" || !match) return new Response("not found", { status: 404 })
    let input: EvaluationInput, prepared: ReturnType<typeof prepareEvaluationFiles>
    try { input = parseEvaluationInput(await readBody(request), match[1]!); prepared = prepareEvaluationFiles(input) }
    catch { return Response.json({ error: "invalid bounded smoke snapshot", providerCalls: 0 }, { status: 400 }) }
    const receipt: EvaluationReceipt = { id: input.id, taskID: input.taskID, publicTestsPassed: false, oraclePassed: false, runtimeStopped: false, providerCalls: 0, phase: "grading",
      diagnostics: { copiedFiles: Object.keys(prepared.files).length, retainedAgentTest: prepared.retainedAgentTest, publicExitCode: null, oracleExitCode: null, failure: null } }
    const admitted = await this.ctx.storage.transaction(async tx => { if (await tx.get(KEY)) return false; await tx.put(KEY, receipt); return true })
    if (!admitted) return Response.json({ error: "evaluation already attempted; no cached pass counted as new", providerCalls: 0, cached: true, receipt: await this.ctx.storage.get(KEY) }, { status: 409 })
    await this.ctx.storage.setAlarm(Date.now() + 90_000)
    try {
      const container = this.ctx.container
      if (!container || container.running || container.images.evented !== QUALIFICATION_ARTIFACT.image) throw new Error("fresh frozen evaluator unavailable")
      container.start({ image: container.images.evented, entrypoint: ["sleep", "infinity"], enableInternet: false, instance: { ...QUALIFICATION_ARTIFACT.instance } })
      await container.setInactivityTimeout(120_000)
      const copied = await command(container, ["bun", "-e", COPY], "/", 15_000, JSON.stringify({ files: prepared.files, oracle: TRUSTED_ORACLE }))
      if (copied.failure) throw new Error("snapshot preparation failed")
      const flags = evaluatorBunFlags
      const publicResult = await command(container, ["bun", ...flags, "test", "--timeout", "3000", "--bail"], ROOT, 15_000)
      receipt.publicTestsPassed = publicResult.exitCode === 0 && publicResult.failure === null
      receipt.diagnostics.publicExitCode = publicResult.exitCode
      const oracle = await command(container, ["bun", ...flags, "/grading/oracle.js", input.taskID, ROOT], "/grading", 10_000)
      receipt.oraclePassed = oracle.exitCode === 0 && oracle.failure === null && trustedOraclePassed(oracle.stdout, input.taskID)
      receipt.diagnostics.oracleExitCode = oracle.exitCode
      receipt.diagnostics.failure = publicResult.failure ?? oracle.failure ?? (receipt.oraclePassed ? null : "trusted oracle did not report pass")
    } catch { receipt.diagnostics.failure = "isolated grading preparation/execution failed" }
    finally {
      receipt.runtimeStopped = await this.stop()
      receipt.phase = receipt.runtimeStopped ? "complete" : "cleanup-unconfirmed"
      await this.ctx.storage.put(KEY, receipt)
      if (receipt.runtimeStopped) await this.ctx.storage.deleteAlarm()
      else await this.ctx.storage.setAlarm(Date.now() + 10_000)
    }
    return Response.json(receipt, { status: receipt.runtimeStopped ? 200 : 503 })
  }
}
