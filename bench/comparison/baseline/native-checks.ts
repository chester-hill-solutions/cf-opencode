import { LinuxToolPlane, ToolExitError, UncertainToolOutcome, type Exec, type ToolProcess } from "./linux"
import { prepareTaskWorkspace } from "./task-workspace"

export const nativeRoot = "/workspace/r0-23-native"
export const fixtureCommits = {
  ledger: "8f85941eaf677eab8670b67acd4ea9c854f7840c",
  queue: "b56cb0c4654010e1b80f6255b560906960b868e7",
} as const

export interface NativeCheck {
  id: string
  passed: boolean
  details: Record<string, string | number | boolean | null>
}

export interface CancellationObservation {
  callerReturned: boolean
  callerRejectedAsUncertain: boolean
  directExitObserved: boolean
  directExitCode: number | null
  descendantProgressAfterAbort: boolean | null
  descendantKillRequested: boolean
  descendantProgressAfterKill: boolean | null
  descendantStopped: "unproven"
}

/** Bound the observation, not the underlying operation. Callers must separately stop work. */
export async function boundedObservation<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("native observation deadline")), timeoutMs)
    })])
  } finally { if (timer) clearTimeout(timer) }
}

/** Empty HTTP POSTs may still have a stream. Inspect bytes, not stream presence. */
export async function assertEmptyNativeActionBody(request: Request, timeoutMs = 5000): Promise<void> {
  if (!request.body) return
  const reader = request.body.getReader()
  try {
    await boundedObservation((async () => {
      for (;;) {
        const part = await reader.read()
        if (part.done) return
        if (part.value.byteLength !== 0) throw new Error("fixed native action body must be empty")
      }
    })(), timeoutMs)
  } finally {
    // A stuck cancellation acknowledgement must not extend the read deadline.
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function fixedPlane(exec: Exec, root: string, lifetime: AbortSignal): LinuxToolPlane {
  return new LinuxToolPlane(exec, root, lifetime)
}

/** Fixed synthetic child self-exits after 8 seconds even if parent observation is lost. */
const childScript = `const fs=await import("node:fs"); const path="descendant-heartbeat";
fs.appendFileSync(path,"x"); const tick=setInterval(()=>fs.appendFileSync(path,"x"),50);
setTimeout(()=>{clearInterval(tick);process.exit(0)},8000);`
const parentScript = `const child=Bun.spawn(["bun","-e",${JSON.stringify(childScript)}],{cwd:process.cwd(),stdin:"ignore",stdout:"ignore",stderr:"ignore"});
await Bun.write("descendant.pid",String(child.pid)); await Bun.write("parent.pid",String(process.pid));
setInterval(()=>{},1000);`
const cancelCommand = "exec bun -e " + "'" + parentScript + "'"
const heartbeatSample = `bun -e 'const fs=await import("node:fs/promises");const size=async()=>{try{return (await fs.stat("descendant-heartbeat")).size}catch{return null}};const before=await size();await Bun.sleep(180);const after=await size();process.stdout.write(JSON.stringify({before,after}));'`
const killDescendant = `bun -e 'const fs=await import("node:fs/promises");const raw=await fs.readFile("descendant.pid","utf8");if(!/^[1-9][0-9]{0,8}$/.test(raw))throw new Error("invalid synthetic pid");try{process.kill(Number(raw),9);process.stdout.write("requested")}catch(error){if(error.code!=="ESRCH")throw error;process.stdout.write("absent")}'`

function progress(value: string): boolean | null {
  const sample: unknown = JSON.parse(value)
  if (!sample || typeof sample !== "object" || !("before" in sample) || !("after" in sample)) throw new Error("invalid heartbeat sample")
  const { before, after } = sample
  if (before === null || after === null) return null
  if (typeof before !== "number" || typeof after !== "number") throw new Error("invalid heartbeat sample")
  return after > before
}

/** A direct abort is measured independently of direct exit and child progress. */
export async function observeNativeCancellation(exec: Exec, root: string, lifetime: AbortSignal): Promise<CancellationObservation> {
  const tools = fixedPlane(exec, root, lifetime)
  const cancel = new AbortController()
  let direct: ToolProcess | undefined
  const cancelling = new LinuxToolPlane(async (argv, options) => {
    direct = await exec(argv, options)
    return direct
  }, root, lifetime)
  const work = cancelling.execute("shell", { command: cancelCommand }, cancel.signal)
    .then(() => ({ returned: true, uncertain: false }), error => ({ returned: true, uncertain: error instanceof UncertainToolOutcome }))
  let callerReturned = false, callerRejectedAsUncertain = false, directExitCode: number | null = null
  let descendantProgressAfterAbort: boolean | null = null, descendantProgressAfterKill: boolean | null = null
  let descendantKillRequested = false
  try {
    await tools.execute("shell", { command: "for n in {1..80}; do if test -s parent.pid && test -s descendant.pid && test -s descendant-heartbeat; then exit 0; fi; sleep 0.05; done; exit 1" }, lifetime)
    cancel.abort()
    const observed = await boundedObservation(work, 2000)
    callerReturned = observed.returned; callerRejectedAsUncertain = observed.uncertain
    if (direct) directExitCode = await boundedObservation(direct.exitCode, 2000).catch(() => null)
    descendantProgressAfterAbort = progress(await tools.execute("shell", { command: heartbeatSample }, lifetime))
  } finally {
    cancel.abort()
    try { direct?.kill(9) } catch {}
    // Cleanup uses its own short signal: caller/lifetime cancellation must not skip it.
    const cleanupSignal = AbortSignal.timeout(3000)
    const cleanupTools = fixedPlane(exec, root, cleanupSignal)
    try {
      await cleanupTools.execute("shell", { command: killDescendant }, cleanupSignal)
      descendantKillRequested = true
      descendantProgressAfterKill = progress(await cleanupTools.execute("shell", { command: heartbeatSample }, cleanupSignal))
    } catch { /* Physical container cleanup is the final safety boundary. */ }
  }
  return { callerReturned, callerRejectedAsUncertain, directExitObserved: directExitCode !== null, directExitCode,
    descendantProgressAfterAbort, descendantKillRequested, descendantProgressAfterKill, descendantStopped: "unproven" }
}

/** All commands/data are authored here; neither model output nor caller commands enter this runner. */
export async function runFixedNativeChecks(exec: Exec, root: string, signal: AbortSignal, onCheck?: (check: NativeCheck) => Promise<void>): Promise<{
  checks: NativeCheck[]
  commits: Record<"ledger" | "queue", string>
  cancellation: CancellationObservation
}> {
  const checks: NativeCheck[] = []
  const tools = fixedPlane(exec, root + "/tools", signal)
  const assert = async (id: string, passed: boolean, details: NativeCheck["details"] = {}) => {
    const check = { id, passed, details }
    checks.push(check)
    await onCheck?.(check)
    if (!passed) throw new Error("fixed native check failed: " + id)
  }
  const refused = async (tool: string, input: Record<string, unknown>): Promise<boolean> => {
    try { await tools.execute(tool, input, signal); return false }
    catch (error) { return error instanceof ToolExitError }
  }
  await tools.execute("write", { path: "probe.txt", content: "alpha\n" }, signal)
  await assert("write-read", await tools.execute("read", { path: "probe.txt" }, signal) === "alpha\n")
  await tools.execute("edit", { path: "probe.txt", oldText: "alpha", newText: "beta" }, signal)
  await assert("edit-shell", await tools.execute("shell", { command: "cat probe.txt" }, signal) === "beta\n")
  await tools.execute("shell", { command: "printf retain > ../outside-marker; ln -s ../outside-marker escape; printf 'x x' > ambiguous" }, signal)
  for (const kind of ["read", "write", "edit"] as const) {
    const extra = kind === "write" ? { content: "changed" } : kind === "edit" ? { oldText: "retain", newText: "changed" } : {}
    await assert("path-" + kind, await refused(kind, { path: "../outside-marker", ...extra }), { scope: "file-tool boundary only; shell is trusted unrestricted execution" })
    await assert("symlink-" + kind, await refused(kind, { path: "escape", ...extra }))
  }
  await assert("outside-retained", await tools.execute("shell", { command: "cat ../outside-marker" }, signal) === "retain")
  await assert("ambiguous-edit", await refused("edit", { path: "ambiguous", oldText: "x", newText: "y" }))
  await assert("ambiguous-edit-retained", await tools.execute("read", { path: "ambiguous" }, signal) === "x x")
  await tools.execute("shell", { command: "bun -e 'await Bun.write(\"large\",\"x\".repeat(70000))'" }, signal)
  await assert("read-size-limit", await refused("read", { path: "large" }))
  await assert("write-size-limit", await refused("write", { path: "large-write", content: "x".repeat(70_000) }))
  for (const channel of ["stdout", "stderr"] as const) {
    let limited = false
    try { await tools.execute("shell", { command: `bun -e 'process.${channel}.write("x".repeat(70000))'` }, signal) }
    catch (error) { limited = error instanceof UncertainToolOutcome && error.message.includes("limit") }
    await assert(channel + "-limit", limited, { bytesLimit: 65_536, physicalStop: "unproven by output refusal" })
  }
  const commits = { ledger: "", queue: "" }
  for (const [repo, task] of [["ledger", "L1"], ["queue", "Q1"]] as const) {
    commits[repo] = await prepareTaskWorkspace(task, "native-" + repo + "-v1", fixedPlane(exec, root + "/" + repo, signal), signal)
    await assert("fixture-" + repo, commits[repo] === fixtureCommits[repo], { expected: fixtureCommits[repo], observed: commits[repo] })
  }
  const cancellation = await observeNativeCancellation(exec, root + "/cancellation", signal)
  await assert("cancellation-observation", cancellation.callerReturned && cancellation.callerRejectedAsUncertain && cancellation.directExitObserved && cancellation.descendantKillRequested,
    { callerReturned: cancellation.callerReturned, directExitObserved: cancellation.directExitObserved,
      descendantProgressAfterAbort: cancellation.descendantProgressAfterAbort, descendantProgressAfterKill: cancellation.descendantProgressAfterKill,
      descendantStopped: "unproven; progress sampling is not a process-tree stop proof" })
  return { checks, commits, cancellation }
}
