import { spawn } from "bun"
import { constants, chmodSync, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, writeFileSync } from "node:fs"
import { lstat, readlink, readdir, realpath, rm } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import {
  parseWorkspaceRepositoryBinding, parseWorkspaceRepositoryReceipt, sameWorkspaceRepositorySelection,
  WorkspaceRepositoryConflictError, type WorkspaceRepositoryBinding, type WorkspaceRepositoryReceipt,
} from "./src/workspace-repository"

const conflict = () => new WorkspaceRepositoryConflictError()
const BOUND_FILE = "workspace-repository.json"
const environment = {
  PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", LANG: "C",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_COUNT: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "https",
  GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null",
}
type Action = { action: "empty" | "clone" | "copy" | "verify" | "cleanup"; workspace: string; staging: string; binding: WorkspaceRepositoryBinding }
type ActionResult = { baseCommit?: string }
export type RepositoryGitRunner = (args: string[], cwd: string) => Promise<string>

async function observedExit(exited: Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([exited.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2_000) })])
  } finally { if (timer) clearTimeout(timer) }
}

async function boundedCommand(command: string[], cwd: string, timeout = 90_000, env = environment): Promise<string> {
  const child = spawn(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "ignore" })
  let timer: ReturnType<typeof setTimeout> | undefined
  const reader = child.stdout.getReader()
  const output = async () => {
    let bytes = 0, value = ""
    const decoder = new TextDecoder()
    for (;;) {
      const part = await reader.read()
      if (part.done) return value
      bytes += part.value.byteLength
      if (bytes > 64 * 1024) throw conflict()
      value += decoder.decode(part.value, { stream: true })
    }
  }
  try {
    const [code, stdout] = await Promise.race([
      Promise.all([child.exited, output()]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(conflict()), timeout) }),
    ])
    if (code !== 0) throw conflict()
    return stdout.trim()
  } finally {
    if (timer) clearTimeout(timer)
    if (child.exitCode === null) child.kill("SIGKILL")
    void reader.cancel().catch(() => {})
    const exited = await observedExit(child.exited)
    if (!exited) throw conflict()
  }
}

const git: RepositoryGitRunner = (args, cwd) => boundedCommand([
  "git", "--no-pager", "--no-optional-locks", "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false", "-c", "http.followRedirects=false", "-c", "credential.helper=",
  "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", ...args,
], cwd, 90_000, { ...environment, GIT_ALLOW_PROTOCOL: args[0] === "clone" ? "https" : "" })

function contained(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith("../"))
}

async function safeCheckout(root: string): Promise<void> {
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        if (!contained(root, resolve(dirname(path), await readlink(path)))) throw conflict()
      } else if (entry.isDirectory()) await walk(path)
      else if (!entry.isFile()) throw conflict()
    }
  }
  await walk(root)
}

async function verifyCheckout(root: string, binding: WorkspaceRepositoryReceipt, run: RepositoryGitRunner): Promise<void> {
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw conflict()
  root = await realpath(root)
  const stat = await lstat(join(root, ".git"))
  if (!stat.isDirectory() || stat.isSymbolicLink() || !contained(root, await realpath(join(root, ".git"))) || existsSync(join(root, ".git", "commondir"))) throw conflict()
  const topLevel = await run(["-C", root, "rev-parse", "--show-toplevel"], root)
  const gitDirectory = await run(["-C", root, "rev-parse", "--absolute-git-dir"], root)
  if (await realpath(topLevel) !== root || await realpath(gitDirectory) !== await realpath(join(root, ".git"))) throw conflict()
  const keys = await run(["-C", root, "config", "--no-includes", "--local", "--name-only", "--list"], root)
  if (keys.split("\n").some(key => /^include(?:if\..*)?\.path$/i.test(key))) throw conflict()
  const origin = await run(["-C", root, "config", "--no-includes", "--local", "--get-all", "remote.origin.url"], root)
  const branch = await run(["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"], root)
  if (origin !== binding.repository || branch !== binding.workingBranch) throw conflict()
  await run(["-C", root, "merge-base", "--is-ancestor", binding.baseCommit, "HEAD"], root)
}

/** Fixed agent-side operations. Test injection maps only the clone transport. */
export async function executeRepositoryAction(input: Action, run: RepositoryGitRunner = git): Promise<ActionResult> {
  const binding = parseWorkspaceRepositoryBinding(input.binding)
  const root = resolve(input.workspace), staging = resolve(input.staging)
  if (!isAbsolute(input.workspace) || !isAbsolute(input.staging) || !/^aboiteau-bound-[0-9a-f-]{36}$/.test(staging.split("/").pop() ?? "")) throw conflict()
  if (input.action === "cleanup") { await rm(staging, { recursive: true, force: true }); return {} }
  if (input.action === "empty") {
    const stat = await lstat(root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await readdir(root)).some(name => name !== ".stow")) throw conflict()
    return {}
  }
  if (input.action === "clone") {
    await rm(staging, { recursive: true, force: true })
    await run(["clone", "--no-checkout", "--no-recurse-submodules", "--no-local", "--no-hardlinks", "--single-branch", "--no-tags", "--template=", "--branch", binding.baseBranch, "--", binding.repository, staging], dirname(staging))
    // Keep the canonical public URL even when a private test transport is used.
    await run(["-C", staging, "remote", "set-url", "origin", binding.repository], staging)
    const baseCommit = await run(["-C", staging, "rev-parse", "--verify", `refs/remotes/origin/${binding.baseBranch}`], staging)
    const receipt = parseWorkspaceRepositoryReceipt({ ...binding, status: "bound", baseCommit })
    await run(["-C", staging, "checkout", "--no-recurse-submodules", "--no-track", "-b", binding.workingBranch, receipt.baseCommit], staging)
    if (existsSync(join(staging, ".stow"))) throw conflict()
    await safeCheckout(staging)
    await verifyCheckout(staging, receipt, run)
    return { baseCommit }
  }
  if (input.action === "copy") {
    await executeRepositoryAction({ ...input, action: "empty" }, run)
    await boundedCommand(["cp", "-a", `${staging}/.`, root], dirname(root), 30_000)
    return {}
  }
  if (input.action === "verify") { await verifyCheckout(root, parseWorkspaceRepositoryReceipt(binding), run); return {} }
  throw conflict()
}

export async function invokeRepositoryAction(input: Action, agentCommand: (args: string[]) => string[]): Promise<ActionResult> {
  const child = spawn(agentCommand([process.execPath, import.meta.path, "--agent-action"]), {
    cwd: import.meta.dir, env: environment, stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "ignore", detached: true,
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const reader = child.stdout.getReader()
  try {
    const output = async () => {
      let bytes = 0, text = ""
      const decoder = new TextDecoder()
      for (;;) { const part = await reader.read(); if (part.done) return text; bytes += part.value.byteLength; if (bytes > 16_384) throw conflict(); text += decoder.decode(part.value, { stream: true }) }
    }
    const [code, text] = await Promise.race([
      Promise.all([child.exited, output()]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(conflict()), 120_000) }),
    ])
    if (code !== 0) throw conflict()
    const result: unknown = JSON.parse(text)
    if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).some(key => key !== "baseCommit")) throw conflict()
    if ("baseCommit" in result && (typeof result.baseCommit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result.baseCommit))) throw conflict()
    return result
  } finally {
    if (timer) clearTimeout(timer)
    try { process.kill(-child.pid, "SIGKILL") } catch { if (child.exitCode === null) child.kill("SIGKILL") }
    void reader.cancel().catch(() => {})
    if (!await observedExit(child.exited)) throw conflict()
  }
}

type Intent = { phase: "intent" | "copying" | "bound"; binding: WorkspaceRepositoryBinding; staging: string }
interface HostOptions { workspace: string; stateRoot: string; runDir: string; perform: (input: Action) => Promise<ActionResult> }

/** Root-owned receipt survives controller restarts; archived mirror is untrusted. */
export class WorkspaceRepositoryHost {
  private requested: WorkspaceRepositoryBinding | undefined
  constructor(private readonly options: HostOptions) {}
  private path() { return join(this.options.runDir, BOUND_FILE) }
  private mirror() { return join(this.options.stateRoot, BOUND_FILE) }
  private read(path: string, trusted = false): unknown {
    if (!existsSync(path)) return undefined
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384 || (trusted && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) throw conflict()
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const opened = fstatSync(fd)
      if (!opened.isFile() || opened.size > 16_384 || (trusted && (opened.uid !== process.getuid?.() || (opened.mode & 0o077) !== 0))) throw conflict()
      const data = Buffer.alloc(16_385), bytes = readSync(fd, data, 0, data.length, 0)
      if (bytes > 16_384) throw conflict()
      return JSON.parse(data.subarray(0, bytes).toString("utf8"))
    } finally { closeSync(fd) }
  }
  private intent(): Intent | undefined {
    const value = this.read(this.path(), true)
    if (value === undefined) return undefined
    if (!value || typeof value !== "object" || !("phase" in value) || !["intent", "copying", "bound"].includes(String(value.phase)) || !("binding" in value) || !("staging" in value) || typeof value.staging !== "string" || !/^\/tmp\/aboiteau-bound-[0-9a-f-]{36}$/.test(value.staging)) throw conflict()
    const binding = parseWorkspaceRepositoryBinding(value.binding)
    if ((value.phase === "bound") !== (binding.status === "bound") && value.phase !== "copying") throw conflict()
    return { phase: value.phase as Intent["phase"], binding, staging: value.staging }
  }
  private publish(intent: Intent) {
    mkdirSync(this.options.runDir, { recursive: true, mode: 0o700 })
    const directory = lstatSync(this.options.runDir)
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.()) throw conflict()
    chmodSync(this.options.runDir, 0o700)
    const temp = `${this.path()}.${randomUUID()}.tmp`
    const fd = openSync(temp, "wx", 0o600)
    try { writeFileSync(fd, JSON.stringify(intent)); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temp, this.path())
    const dir = openSync(this.options.runDir, "r")
    try { fsyncSync(dir) } finally { closeSync(dir) }
  }
  private matching(left: WorkspaceRepositoryBinding, right: WorkspaceRepositoryBinding) {
    if (left.bindingID !== right.bindingID || !sameWorkspaceRepositorySelection(left, right) || (left.status === "bound" && right.status === "bound" && left.baseCommit !== right.baseCommit)) throw conflict()
  }
  configure(value: unknown): WorkspaceRepositoryBinding {
    const binding = parseWorkspaceRepositoryBinding(value)
    if (this.requested) this.matching(this.requested, binding)
    const current = this.intent()
    if (current) this.matching(current.binding, binding)
    this.requested = binding
    return binding
  }
  hasBinding(): boolean { return Boolean(this.requested || this.intent() || existsSync(this.mirror())) }
  /** Protected identity only; no Git, archived-mirror adoption or filesystem writes. */
  boundReceipt(value: unknown): WorkspaceRepositoryReceipt {
    const expected = parseWorkspaceRepositoryReceipt(value), intent = this.intent()
    if (!intent || intent.phase !== "bound") throw conflict()
    const receipt = parseWorkspaceRepositoryReceipt(intent.binding)
    this.matching(receipt, expected)
    return receipt
  }
  /** Verify the checkout when a caller has not already performed that check. */
  async verifiedReceipt(value: unknown): Promise<WorkspaceRepositoryReceipt> {
    const receipt = this.boundReceipt(value), intent = this.intent()
    if (!intent) throw conflict()
    await this.options.perform({ action: "verify", workspace: this.options.workspace, staging: intent.staging, binding: receipt })
    return receipt
  }
  selection(): WorkspaceRepositoryBinding | undefined { const intent = this.intent(); return intent?.phase === "bound" ? intent.binding : this.requested ?? intent?.binding }
  async prepare(): Promise<WorkspaceRepositoryReceipt> {
    let intent = this.intent()
    const binding = this.requested ?? intent?.binding
    if (!binding) throw conflict()
    if (intent) this.matching(intent.binding, binding)
    if (intent?.phase === "copying") throw conflict()
    if (intent?.phase === "bound") {
      const mirror = this.read(this.mirror())
      if (mirror !== undefined) this.matching(intent.binding, parseWorkspaceRepositoryReceipt(mirror))
    }
    const action = (kind: Action["action"], selected = intent?.binding ?? binding) => this.options.perform({ action: kind, workspace: this.options.workspace, staging: intent?.staging ?? `/tmp/aboiteau-bound-${randomUUID()}`, binding: selected })
    if (!intent) {
      const mirror = this.read(this.mirror())
      if (mirror !== undefined) {
        if (binding.status !== "bound") throw conflict()
        const receipt = parseWorkspaceRepositoryReceipt(mirror)
        this.matching(receipt, binding)
        await action("verify", receipt)
        intent = { phase: "bound", binding: receipt, staging: `/tmp/aboiteau-bound-${randomUUID()}` }
        this.publish(intent)
      } else {
        if (binding.status !== "pending") throw conflict()
        await action("empty")
        intent = { phase: "intent", binding, staging: `/tmp/aboiteau-bound-${randomUUID()}` }
        this.publish(intent)
      }
    }
    if (intent.phase === "intent") {
      if (binding.status !== "pending") throw conflict()
      const cloned = await action("clone")
      const receipt = parseWorkspaceRepositoryReceipt({ ...binding, status: "bound", baseCommit: cloned.baseCommit })
      intent = { ...intent, phase: "copying", binding: receipt }
      this.publish(intent)
      await action("copy", receipt)
      await action("verify", receipt)
      intent = { ...intent, phase: "bound" }
      this.publish(intent)
      await action("cleanup", receipt).catch(() => {})
    }
    const receipt = parseWorkspaceRepositoryReceipt(intent.binding)
    await action("verify", receipt)
    mkdirSync(this.options.stateRoot, { recursive: true })
    const stateDirectory = lstatSync(this.options.stateRoot)
    if (!stateDirectory.isDirectory() || stateDirectory.isSymbolicLink() || stateDirectory.uid !== process.getuid?.()) throw conflict()
    // STATE_ROOT is agent-writable. Never follow the mirror path, even after a
    // preceding lstat: write a fresh exclusive inode and atomically replace it.
    const mirror = this.mirror(), temporaryMirror = `${mirror}.${randomUUID()}.tmp`
    const fd = openSync(temporaryMirror, "wx", 0o644)
    try { writeFileSync(fd, JSON.stringify(receipt)); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporaryMirror, mirror)
    return receipt
  }
}

if (import.meta.main && process.argv[2] === "--agent-action") {
  try {
    const reader = Bun.stdin.stream().getReader(), decoder = new TextDecoder()
    let input = "", bytes = 0
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 16_384) throw conflict(); input += decoder.decode(part.value, { stream: true }) }
    } finally { void reader.cancel().catch(() => {}) }
    const result = await executeRepositoryAction(JSON.parse(input))
    process.stdout.write(JSON.stringify(result))
  } catch { process.exitCode = 1 }
}
