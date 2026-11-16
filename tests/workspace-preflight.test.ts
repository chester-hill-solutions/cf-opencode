import { afterEach, expect, spyOn, test } from "bun:test"
import { appendFileSync } from "node:fs"
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspectWorkspace } from "../workspace-preflight"
import { parseWorkspacePreflight } from "../src/workspace-preflight"

const roots: string[] = []
const gitEnv = { PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" }
async function directory() { const root = await mkdtemp(join(tmpdir(), "workspace-preflight-")); roots.push(root); return root }
function git(root: string, args: string[]) {
  const child = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd: root, env: gitEnv, stdout: "pipe", stderr: "pipe", timeout: 3000 })
  if (child.exitCode !== 0) throw new Error("fixture Git setup failed")
  return child.stdout.toString().trim()
}
async function repository() {
  const root = await directory()
  git(root, ["init", "-q", "--initial-branch=main"])
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: "bun test", typecheck: "do-not-run" } }))
  await writeFile(join(root, "bun.lock"), '{"lockfileVersion":1}')
  await writeFile(join(root, "README.md"), "Fixture guidance")
  git(root, ["add", "."])
  git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Fixture"])
  return root
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

test("repository references remain unverified without worktree probes or index writes", async () => {
  const root = await repository(), index = await readFile(join(root, ".git/index")), before = await lstat(join(root, ".git/index"))
  const clean = await inspectWorkspace(root)
  expect(clean.repository).toEqual({ kind: "git", head: git(root, ["rev-parse", "HEAD"]), branch: "main", dirty: null })
  expect(clean.findings.some(item => item.code === "worktree_changes_unverified")).toBe(true)
  expect(clean.status).toBe("needs_verification")
  expect(clean.verification).toEqual({ setup: "not_run", checks: "not_run" })
  expect(clean.project.guidance).toEqual(["README.md"])
  expect(clean.suggestions).toContainEqual({ purpose: "check", argv: ["bun", "run", "test"], requiresApproval: true })
  expect(await readFile(join(root, ".git/index"))).toEqual(index)
  expect((await lstat(join(root, ".git/index"))).mtimeMs).toBe(before.mtimeMs)
  expect(await readdir(join(root, ".git"))).not.toContain("index.lock")
  await writeFile(join(root, "new.txt"), "untracked")
  expect((await inspectWorkspace(root)).repository.dirty).toBeNull()
  git(root, ["checkout", "--detach", "-q"])
  expect((await inspectWorkspace(root)).repository.branch).toBeNull()
})

test("Gitless/unavailable workspaces and malformed metadata return structured findings", async () => {
  const root = await directory()
  expect((await inspectWorkspace(root)).repository.kind).toBe("none")
  await writeFile(join(root, "package.json"), "{broken")
  const malformed = await inspectWorkspace(root)
  expect(malformed.status).toBe("blocked")
  expect(malformed.findings.some(item => item.code === "package_invalid")).toBe(true)
  const absent = await inspectWorkspace(join(root, "missing"))
  expect(absent.status).toBe("blocked")
  expect(absent.repository.kind).toBe("unavailable")
})

test("scripts, Git fsmonitor, clean filters and hooks never execute or leak values", async () => {
  const root = await repository(), marker = join(root, "executed"), trap = join(root, "trap")
  await writeFile(trap, `#!/bin/sh\nprintf executed > '${marker}'\ncat\n`)
  await chmod(trap, 0o755)
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: `${trap} SECRET_SCRIPT_VALUE`, postinstall: `${trap}`, "bad;name": `${trap}` }, dependencies: { example: "1" } }))
  await writeFile(join(root, ".gitattributes"), "package.json filter=trap\n")
  git(root, ["config", "core.fsmonitor", trap])
  git(root, ["config", "filter.trap.clean", trap])
  git(root, ["config", "filter.trap.process", trap])
  git(root, ["config", "filter.trap.required", "true"])
  await writeFile(join(root, ".git/hooks/post-index-change"), await readFile(trap))
  await chmod(join(root, ".git/hooks/post-index-change"), 0o755)
  const report = await inspectWorkspace(root)
  expect(report.repository.kind).toBe("git")
  expect(report.project.scripts).toEqual(["postinstall", "test"])
  expect(JSON.stringify(report)).not.toContain("SECRET_SCRIPT_VALUE")
  expect(JSON.stringify(report)).not.toContain(trap)
  expect(await Bun.file(marker).exists()).toBe(false)
  expect(report.verification.setup).toBe("not_run")
})

test("external or symlink Git metadata and symlink package files fail closed", async () => {
  const outside = await repository(), root = await directory()
  await writeFile(join(root, ".git"), `gitdir: ${join(outside, ".git")}\n`)
  expect((await inspectWorkspace(root)).status).toBe("blocked")
  await rm(join(root, ".git"))
  await symlink(join(outside, ".git"), join(root, ".git"))
  expect((await inspectWorkspace(root)).repository.kind).toBe("unavailable")
  await rm(join(root, ".git"))
  await symlink(join(outside, "package.json"), join(root, "package.json"))
  const linked = await inspectWorkspace(root)
  expect(linked.status).toBe("blocked")
  expect(linked.project.scripts).toEqual([])
})

test("untrusted config includes and partial-clone remotes cannot launch helpers", async () => {
  const root = await repository(), marker = join(root, "executed"), included = join(root, "included")
  await writeFile(included, '[core]\n fsmonitor = touch executed\n')
  git(root, ["config", "include.path", included])
  expect((await inspectWorkspace(root)).status).toBe("blocked")
  git(root, ["config", "--unset", "include.path"])
  git(root, ["config", "extensions.partialClone", "trap"])
  git(root, ["config", "remote.trap.url", "ext::touch " + marker])
  git(root, ["config", "remote.trap.promisor", "true"])
  await rm(join(root, ".git/objects"), { recursive: true })
  await mkdir(join(root, ".git/objects"))
  const report = await inspectWorkspace(root)
  expect(report.repository.head).toMatch(/^[a-f0-9]{40}$/)
  expect(report.repository.dirty).toBeNull()
  expect(await Bun.file(marker).exists()).toBe(false)
})

test("large locks are bounded, inferred by presence and never imply setup ran", async () => {
  for (const [name, manager] of [["bun.lock", "bun"], ["package-lock.json", "npm"]] as const) {
    const root = await directory()
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { example: "1" } }))
    await writeFile(join(root, name), JSON.stringify({ lockfileVersion: 1, padding: "x".repeat(90000) }))
    const report = await inspectWorkspace(root)
    expect(report.status).toBe("needs_verification")
    expect(report.project.packageManager).toBe(manager)
    expect(report.project.dependencies).toBe("missing")
    expect(report.suggestions.some(item => item.purpose === "setup")).toBe(true)
    await writeFile(join(root, name), "x".repeat(2 * 1024 * 1024 + 1))
    const oversized = await inspectWorkspace(root)
    expect(oversized.status).toBe("needs_verification")
    expect(oversized.project.packageManager).toBe(manager)
    expect(oversized.findings.some(item => item.code === "lock_oversized")).toBe(true)
    expect(oversized.suggestions).toEqual([])
  }
})

test("conservative lock profiles and dependency presence do not claim verification", async () => {
  const root = await directory()
  await writeFile(join(root, "package.json"), JSON.stringify({ packageManager: "bun@1.3.5", dependencies: { example: "1" } }))
  expect((await inspectWorkspace(root)).findings.some(item => item.code === "lock_missing")).toBe(true)
  await writeFile(join(root, "bun.lock"), '{"lockfileVersion":1,}')
  const manual = await inspectWorkspace(root)
  expect(manual.status).toBe("needs_verification")
  expect(manual.findings.some(item => item.code === "lock_unverified")).toBe(true)
  expect(manual.suggestions).toEqual([])
  await mkdir(join(root, "node_modules"))
  expect((await inspectWorkspace(root)).project.dependencies).toBe("present")
  await writeFile(join(root, "package-lock.json"), "{broken")
  expect((await inspectWorkspace(root)).status).toBe("blocked")
})

test("Git output and ordinary metadata bounds fail closed without leaking content", async () => {
  const root = await repository()
  await writeFile(join(root, "AGENTS.md"), "secret-metadata".repeat(6000))
  const oversized = await inspectWorkspace(root)
  expect(oversized.status).toBe("blocked")
  expect(JSON.stringify(oversized)).not.toContain("secret-metadata")
  await rm(join(root, "AGENTS.md"))
  await writeFile(join(root, ".git/config"), "[oversized]\n" + Array.from({ length: 1600 }, (_, index) => `name${index} = ignored\n`).join(""))
  const overflow = await inspectWorkspace(root)
  expect(overflow.status).toBe("blocked")
  expect(overflow.repository.dirty).toBeNull()
})

test("concurrent filter injection cannot turn metadata inspection into code execution", async () => {
  const root = await repository(), marker = join(root, "FILTER-RAN"), trap = join(root, "filter")
  await writeFile(join(root, "tracked.txt"), "same-size-before")
  git(root, ["add", "tracked.txt"])
  git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Tracked fixture"])
  await writeFile(join(root, "tracked.txt"), "same-size-after!")
  await writeFile(join(root, ".gitattributes"), "*.txt filter=reviewprobe\n")
  await writeFile(trap, `#!/bin/sh\nprintf executed > '${marker}'\ncat\n`)
  await chmod(trap, 0o755)
  const original = Bun.spawn, commands: string[][] = []
  let injected = false
  const interception = spyOn(Bun, "spawn").mockImplementation((...args: unknown[]) => {
    const command = args[0]
    if (Array.isArray(command)) {
      commands.push(command.filter((arg): arg is string => typeof arg === "string"))
      if (!injected && command.includes("rev-parse")) {
        injected = true
        appendFileSync(join(root, ".git/config"), `\n[filter "reviewprobe"]\n clean = ${trap}\n required = true\n`)
      }
    }
    return Reflect.apply(original, Bun, args)
  })
  try {
    const report = await inspectWorkspace(root)
    expect(injected).toBe(true)
    expect(report.repository.dirty).toBeNull()
    expect(report.status).toBe("needs_verification")
    expect(commands.every(command => !command.some(arg => ["status", "diff", "ls-files", "update-index"].includes(arg)))).toBe(true)
    expect(await Bun.file(marker).exists()).toBe(false)
  } finally { interception.mockRestore() }
})

test("shared parser strips extra fields and rejects ready claims, execution and unsafe argv", async () => {
  const report = await inspectWorkspace(await directory())
  expect(parseWorkspacePreflight({ ...report, secret: "not retained" })).toEqual(report)
  for (const change of [{ schemaVersion: 2 }, { status: "ready" }, { mode: "execute" }, { verification: { setup: "done", checks: "not_run" } }, { tools: [{ name: "git", available: "yes" }] }, { findings: [{ code: "bad", severity: "info", message: "x".repeat(1000) }] }]) expect(() => parseWorkspacePreflight({ ...report, ...change })).toThrow()
  expect(() => parseWorkspacePreflight({ ...report, project: { ...report.project, packageManager: "bun", scripts: ["test"] }, suggestions: [{ purpose: "check", argv: ["bun", "-e", "execute"], requiresApproval: true }] })).toThrow()
})
