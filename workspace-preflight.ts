import { constants } from "node:fs"
import { access, lstat, open, realpath } from "node:fs/promises"
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path"
import { parseWorkspacePreflight, type WorkspacePreflight } from "./src/workspace-preflight"

const TRUSTED_PATH = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"].join(delimiter)
const FILE_LIMIT = 65536
const LOCK_LIMIT = 2 * 1024 * 1024
const OUTPUT_LIMIT = 16384
const tools = ["git", "bun", "node", "npm", "pnpm", "yarn", "python3", "make"]
const manifests = ["package.json", "bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"]
const guidance = ["AGENTS.md", "CLAUDE.md", "README.md", "CONTRIBUTING.md"]
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value))
const inside = (root: string, path: string) => {
  const child = relative(root, path)
  return child === "" || (!child.startsWith(".." + sep) && child !== ".." && !isAbsolute(child))
}

async function executable(name: string): Promise<string | null> {
  const candidates = name === "bun" ? [process.execPath] : []
  candidates.push(...TRUSTED_PATH.split(delimiter).map(dir => join(dir, name)))
  for (const file of candidates) {
    try {
      if ((await lstat(file)).isDirectory()) continue
      await access(file, constants.X_OK)
      return file
    } catch { /* unavailable */ }
  }
  return null
}

/** No shell, inherited Git configuration, package-manager probes or repository executables. */
async function gitProbe(git: string, root: string, gitdir: string, args: string[]): Promise<{ code: number; output: string } | null> {
  let child: ReturnType<typeof Bun.spawn> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const command = [git, "--no-pager", "--no-optional-locks", "--git-dir=" + gitdir, "--work-tree=" + root,
      "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.untrackedCache=false", "-c", "core.attributesFile=/dev/null", "-c", "core.excludesFile=/dev/null", "-c", "core.bare=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args]
    const spawned = Bun.spawn(command, { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: {
      PATH: TRUSTED_PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_ALLOW_PROTOCOL: "", GIT_NO_LAZY_FETCH: "1", LC_ALL: "C",
    } })
    child = spawned
    const read = async (stream: ReadableStream<Uint8Array> | null, keep: boolean) => {
      if (!stream) return ""
      let size = 0, output = ""
      const reader = stream.getReader(), decoder = new TextDecoder()
      try {
        for (;;) {
          const part = await reader.read()
          if (part.done) return output
          size += part.value.byteLength
          if (size > OUTPUT_LIMIT) throw new Error("probe output bound")
          if (keep) output += decoder.decode(part.value, { stream: true })
        }
      } finally {
        void reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    }
    const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { child?.kill("SIGKILL"); reject(new Error("probe deadline")) }, 1200) })
    const [code, output] = await Promise.race([Promise.all([spawned.exited, read(spawned.stdout, true), read(spawned.stderr, false)]), deadline])
    return { code, output }
  } catch { child?.kill("SIGKILL"); return null }
  finally { if (timer) clearTimeout(timer) }
}

export async function inspectWorkspace(workspace: string): Promise<WorkspacePreflight> {
  const report: WorkspacePreflight = { schemaVersion: 1, mode: "read_only", status: "needs_verification", repository: { kind: "unavailable", head: null, branch: null, dirty: null }, tools: [], project: { packageManager: null, manifests: [], scripts: [], guidance: [], dependencies: "unknown" }, suggestions: [], findings: [], verification: { setup: "not_run", checks: "not_run" } }
  const finding = (code: string, severity: "blocker" | "warning" | "info", message: string) => {
    if (report.findings.length < 64) report.findings.push({ code, severity, message })
    if (severity === "blocker") report.status = "blocked"
  }
  let root: string
  try { const stat = await lstat(workspace); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(); root = await realpath(workspace) }
  catch { finding("workspace_unavailable", "blocker", "Workspace must be an accessible native directory."); return report }
  const available = new Map(await Promise.all(tools.map(async name => [name, await executable(name)] as const)))
  report.tools = tools.map(name => ({ name, available: Boolean(available.get(name)) }))
  const present = new Set<string>()
  const file = async (path: string, lockName?: string): Promise<string | null> => {
    try {
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe")
      const limit = lockName ? LOCK_LIMIT : FILE_LIMIT
      if (lockName) present.add(lockName)
      if (stat.size > limit) {
        if (!lockName) throw new Error("unsafe")
        finding("lock_oversized", "warning", "A lockfile exceeds the inspection bound and needs manual validation.")
        return null
      }
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        if (!(await handle.stat()).isFile()) throw new Error("unsafe")
        const bytes = new Uint8Array(limit + 1), result = await handle.read(bytes, 0, bytes.length, 0)
        if (result.bytesRead > limit) throw new Error("unsafe")
        if (lockName === "bun.lockb") return ""
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, result.bytesRead))
      } finally { await handle.close() }
    } catch (error) {
      if (record(error) && error.code === "ENOENT") return null
      finding("metadata_unavailable", "blocker", "A metadata file is unsafe, oversized, malformed or unreadable."); return null
    }
  }
  const contents = new Map<string, string>()
  for (const name of [...manifests, ...guidance]) {
    const value = await file(join(root, name), manifests.includes(name) && name !== "package.json" ? name : undefined)
    if (value !== null) contents.set(name, value)
    if (value !== null || present.has(name)) (manifests.includes(name) ? report.project.manifests : report.project.guidance).push(name)
  }
  let pkg: Record<string, unknown> | null = null
  if (contents.has("package.json")) {
    try { const value: unknown = JSON.parse(contents.get("package.json")!); if (!record(value)) throw new Error(); pkg = value }
    catch { finding("package_invalid", "blocker", "Package metadata is not a valid object.") }
  }
  let manager: WorkspacePreflight["project"]["packageManager"] = null
  if (pkg && typeof pkg.packageManager === "string") {
    const match = /^(bun|npm|pnpm|yarn)@[0-9][A-Za-z0-9.+_-]{0,63}$/.exec(pkg.packageManager)
    if (match) manager = match[1] as NonNullable<typeof manager>
    else finding("manager_invalid", "warning", "Declared package manager is unsupported or malformed.")
  }
  const locks = [["bun", "bun.lock"], ["bun", "bun.lockb"], ["npm", "package-lock.json"], ["npm", "npm-shrinkwrap.json"], ["pnpm", "pnpm-lock.yaml"], ["yarn", "yarn.lock"]] as const
  const lockManagers = [...new Set(locks.filter(([, name]) => present.has(name)).map(([name]) => name))]
  if (lockManagers.length > 1 || (manager && lockManagers.some(name => name !== manager))) finding("lock_conflict", "blocker", "Package manager declarations and lockfiles conflict.")
  if (!manager && lockManagers.length === 1) manager = lockManagers[0]
  report.project.packageManager = manager
  const validLocks = new Set<string>()
  for (const [name, lock] of locks) if (contents.has(lock)) {
    try {
      if (["bun.lock", "package-lock.json", "npm-shrinkwrap.json"].includes(lock)) {
        const parsed: unknown = JSON.parse(contents.get(lock)!)
        if (!record(parsed) || !Number.isInteger(parsed.lockfileVersion) || Number(parsed.lockfileVersion) < 1) throw new Error()
        validLocks.add(name)
      } else finding("lock_unverified", "warning", "This lockfile profile needs manual validation before setup is proposed.")
    } catch {
      if (lock === "bun.lock") finding("lock_unverified", "warning", "Bun text lock syntax needs manual validation before setup is proposed.")
      else finding("lock_invalid", "blocker", "A package lockfile is malformed or unsupported.")
    }
  }
  if (pkg) {
    if (record(pkg.scripts)) report.project.scripts = Object.keys(pkg.scripts).filter(name => /^[A-Za-z][A-Za-z0-9:_-]{0,63}$/.test(name) && typeof pkg!.scripts === "object" && typeof (pkg!.scripts as Record<string, unknown>)[name] === "string").slice(0, 64).sort()
    else if (pkg.scripts !== undefined) finding("scripts_invalid", "warning", "Package script metadata is malformed.")
    const needsDependencies = [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies].some(value => record(value) && Object.keys(value).length > 0)
    if (!needsDependencies) report.project.dependencies = "present"
    else try { const stat = await lstat(join(root, "node_modules")); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(); report.project.dependencies = "present" }
    catch (error) { if (record(error) && error.code === "ENOENT") report.project.dependencies = "missing"; else finding("dependencies_unsafe", "blocker", "Dependency directory is unsafe or unreadable.") }
    if (!manager) finding("manager_unknown", "warning", "No unambiguous supported package manager was identified.")
    else {
      if (!available.get(manager)) finding("manager_unavailable", "blocker", "The selected package manager is unavailable.")
      if (!locks.some(([name, lock]) => name === manager && present.has(lock))) finding("lock_missing", "warning", "No matching lockfile was found; setup was not proposed.")
      if (report.project.dependencies === "missing" && validLocks.has(manager)) report.suggestions.push({ purpose: "setup", argv: manager === "npm" ? ["npm", "ci"] : [manager, "install", "--frozen-lockfile"], requiresApproval: true })
      for (const name of ["test", "check", "typecheck", "lint", "build"]) if (report.project.scripts.includes(name)) report.suggestions.push({ purpose: "check", argv: [manager, "run", name], requiresApproval: true })
    }
  } else finding("package_missing", "info", "No supported root package manifest was identified.")

  const git = available.get("git")
  let foundDotGit = false
  try {
    const dotgit = join(root, ".git"), stat = await lstat(dotgit)
    foundDotGit = true
    let gitdir: string
    if (stat.isSymbolicLink()) throw new Error()
    if (stat.isDirectory()) gitdir = await realpath(dotgit)
    else { const pointer = await file(dotgit), match = pointer && /^gitdir: ([^\r\n\x00]{1,512})\s*$/.exec(pointer); if (!match) throw new Error(); gitdir = resolve(root, match[1]) }
    if (!inside(root, gitdir) || !(await lstat(gitdir)).isDirectory() || (await lstat(gitdir)).isSymbolicLink() || !inside(root, await realpath(gitdir))) throw new Error()
    const beforeMetadata = report.findings.length
    const common = await file(join(gitdir, "commondir"))
    if (report.findings.length !== beforeMetadata) throw new Error()
    let configdir = gitdir
    if (common !== null) { const path = resolve(gitdir, common.trim()); if (!inside(root, path) || !inside(root, await realpath(path))) throw new Error(); configdir = path }
    if (!git) throw new Error()
    for (const config of [join(configdir, "config"), join(gitdir, "config.worktree")]) {
      const beforeConfig = report.findings.length
      const value = await file(config)
      if (report.findings.length !== beforeConfig) throw new Error()
      if (value === null) continue
      const keys = await gitProbe(git, root, gitdir, ["config", "--no-includes", "--file", config, "--name-only", "--list"])
      if (!keys || keys.code !== 0) throw new Error()
      for (const key of keys.output.split("\n").filter(Boolean)) {
        if (/^include(?:if\..*)?\.path$/i.test(key)) throw new Error()
      }
    }
    const head = await gitProbe(git, root, gitdir, ["rev-parse", "--verify", "HEAD"])
    const branch = await gitProbe(git, root, gitdir, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    if (!head || !branch || ![0, 128].includes(head.code) || ![0, 1].includes(branch.code)) throw new Error()
    const headValue = head.output.trim(), branchValue = branch.output.trim()
    report.repository = { kind: "git", head: /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(headValue) ? headValue : null, branch: branch.code === 0 && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branchValue) ? branchValue : null, dirty: null }
    if (!report.repository.head) finding("head_unavailable", "warning", "Repository has no readable committed HEAD.")
    finding("worktree_changes_unverified", "warning", "Local changes were not inspected because working-tree Git probes can execute repository filters.")
  } catch (error) {
    if (!foundDotGit && record(error) && error.code === "ENOENT") { report.repository.kind = "none"; finding("repository_none", "warning", "No root Git repository was found.") }
    else finding("repository_unavailable", "blocker", "Git metadata is unsafe, unsupported, unreadable or exceeded inspection limits.")
  }
  finding("verification_not_run", "info", "Setup and checks were not run; this report does not establish readiness.")
  if (report.status === "blocked") report.suggestions = []
  return parseWorkspacePreflight(report)
}

if (import.meta.main) {
  const report = await inspectWorkspace(process.argv[2] ?? process.env.WORKSPACE ?? "/workspace")
  process.stdout.write(JSON.stringify(parseWorkspacePreflight(report)) + "\n")
}
