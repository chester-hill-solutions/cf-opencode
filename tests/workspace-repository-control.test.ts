import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executeRepositoryAction, invokeRepositoryAction, WorkspaceRepositoryHost, type RepositoryGitRunner } from "../workspace-repository"
import { accountSeedContainsStow } from "../control-server"
import type { WorkspaceRepositoryBinding } from "../src/workspace-repository"

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aboiteau-binding-"))
  const source = join(root, "source"), bare = join(root, "remote.git"), workspace = join(root, "workspace"), stateRoot = join(root, "state"), runDir = join(root, "run")
  for (const path of [source, workspace, stateRoot]) mkdirSync(path)
  mkdirSync(join(workspace, ".stow"))
  const command = (args: string[], cwd = source) => {
    const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 10_000,
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "file:https", GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null" },
    })
    if (result.exitCode !== 0) throw new Error("synthetic Git fixture command failed")
    return result.stdout.toString().trim()
  }
  command(["init", "-b", "main"])
  command(["config", "user.name", "Synthetic Fixture"])
  command(["config", "user.email", "fixture@example.invalid"])
  writeFileSync(join(source, "README.md"), "synthetic base\n")
  command(["add", "."]); command(["commit", "-m", "base"])
  const baseCommit = command(["rev-parse", "HEAD"])
  command(["clone", "--bare", source, bare])
  const pending: WorkspaceRepositoryBinding = { schemaVersion: 1, bindingID: randomUUID(), repository: "https://github.com/example/synthetic", baseBranch: "main", workingBranch: "aboiteau/task", status: "pending", baseCommit: null }
  let cloneCount = 0
  const run: RepositoryGitRunner = async (args, cwd) => {
    if (args[0] === "clone") {
      cloneCount++
      expect(JSON.parse(readFileSync(join(runDir, "workspace-repository.json"), "utf8")).phase).toBe("intent")
      // This private fixture transport never appears in the production API.
      args = args.map(arg => arg === pending.repository ? bare : arg)
    }
    return command(args, cwd)
  }
  const perform = (input: Parameters<typeof executeRepositoryAction>[0]) => executeRepositoryAction(input, run)
  const host = () => new WorkspaceRepositoryHost({ workspace, stateRoot, runDir, perform })
  return { root, source, workspace, stateRoot, runDir, pending, baseCommit, command, run, perform, host, clones: () => cloneCount, close: () => {
    const path = join(runDir, "workspace-repository.json")
    if (existsSync(path)) {
      const intent = JSON.parse(readFileSync(path, "utf8"))
      if (typeof intent.staging === "string" && /^\/tmp\/aboiteau-bound-[0-9a-f-]{36}$/.test(intent.staging)) rmSync(intent.staging, { recursive: true, force: true })
    }
    rmSync(root, { recursive: true, force: true })
  } }
}

describe("trusted workspace repository materialization", () => {
  test("protected bound receipt reads perform no Git/writes and reject missing, mismatched or unsafe authority", async () => {
    const f = fixture()
    try {
      let calls = 0
      const reader = new WorkspaceRepositoryHost({ workspace: f.workspace, stateRoot: f.stateRoot, runDir: f.runDir, perform: async () => { calls++; throw new Error("protected receipt must not execute") } })
      const expected = { ...f.pending, status: "bound" as const, baseCommit: f.baseCommit }
      expect(() => reader.boundReceipt(expected)).toThrow()
      expect(existsSync(f.runDir)).toBe(false)
      const host = f.host(); host.configure(f.pending); const receipt = await host.prepare()
      const path = join(f.runDir, "workspace-repository.json"), before = statSync(path).mtimeMs
      const mirror = readFileSync(join(f.stateRoot, "workspace-repository.json"), "utf8")
      expect(reader.boundReceipt(receipt)).toEqual(receipt)
      expect(calls).toBe(0)
      expect(statSync(path).mtimeMs).toBe(before)
      expect(readFileSync(join(f.stateRoot, "workspace-repository.json"), "utf8")).toBe(mirror)
      expect(() => reader.boundReceipt({ ...receipt, bindingID: randomUUID() })).toThrow()
      expect(() => reader.boundReceipt({ ...receipt, baseCommit: "0".repeat(40) })).toThrow()
      const intent = JSON.parse(readFileSync(path, "utf8"))
      writeFileSync(path, JSON.stringify({ ...intent, phase: "copying" }))
      expect(() => reader.boundReceipt(receipt)).toThrow()
      writeFileSync(path, JSON.stringify(intent)); chmodSync(path, 0o644)
      expect(() => reader.boundReceipt(receipt)).toThrow()
      expect(calls).toBe(0)
    } finally { f.close() }
  })

  test("clones an explicitly selected branch, records intent before effects and preserves base across retries/commits", async () => {
    const f = fixture()
    try {
      const host = f.host(); host.configure(f.pending)
      const receipt = await host.prepare()
      expect(receipt).toEqual({ ...f.pending, status: "bound", baseCommit: f.baseCommit })
      expect(f.command(["symbolic-ref", "--short", "HEAD"], f.workspace)).toBe(f.pending.workingBranch)
      expect(f.command(["config", "--get", "remote.origin.url"], f.workspace)).toBe(f.pending.repository)
      expect(await invokeRepositoryAction({ action: "verify", workspace: f.workspace, staging: `/tmp/aboiteau-bound-${randomUUID()}`, binding: receipt }, args => args)).toEqual({})
      f.command(["config", "user.name", "Fixture"], f.workspace); f.command(["config", "user.email", "fixture@example.invalid"], f.workspace)
      writeFileSync(join(f.workspace, "work.txt"), "working commit\n")
      f.command(["add", "work.txt"], f.workspace); f.command(["commit", "-m", "work"], f.workspace)
      const retry = f.host(); retry.configure(f.pending) // acknowledged start response was lost
      expect(await retry.prepare()).toEqual(receipt)
      expect((await f.host().prepare()).baseCommit).toBe(f.baseCommit) // process restart, no configure
      expect(f.command(["rev-parse", "HEAD"], f.workspace)).not.toBe(f.baseCommit)
      expect(f.clones()).toBe(1)
    } finally { f.close() }
  })

  test("refuses an existing unowned checkout or file without mutation", async () => {
    const f = fixture()
    try {
      writeFileSync(join(f.workspace, "existing.txt"), "retain")
      const host = f.host(); host.configure(f.pending)
      await expect(host.prepare()).rejects.toThrow()
      expect(readFileSync(join(f.workspace, "existing.txt"), "utf8")).toBe("retain")
      expect(f.clones()).toBe(0)
      expect(existsSync(join(f.runDir, "workspace-repository.json"))).toBe(false)
    } finally { f.close() }
  })

  test("an interrupted copy remains blocked after restart and is never automatically repeated", async () => {
    const f = fixture()
    try {
      let copies = 0
      const host = new WorkspaceRepositoryHost({ workspace: f.workspace, stateRoot: f.stateRoot, runDir: f.runDir, perform: async input => {
        if (input.action === "copy") {
          copies++
          expect(JSON.parse(readFileSync(join(f.runDir, "workspace-repository.json"), "utf8")).phase).toBe("copying")
          writeFileSync(join(f.workspace, "partial.txt"), "partial")
          throw new Error("synthetic interrupted copy")
        }
        return f.perform(input)
      } })
      host.configure(f.pending)
      await expect(host.prepare()).rejects.toThrow()
      const retry = f.host(); retry.configure(f.pending)
      await expect(retry.prepare()).rejects.toThrow()
      expect(copies).toBe(1)
      expect(readFileSync(join(f.workspace, "partial.txt"), "utf8")).toBe("partial")
    } finally { f.close() }
  })

  test("cold mirror adoption requires trusted bound identity and matching base; pending cannot adopt", async () => {
    const f = fixture()
    try {
      const host = f.host(); host.configure(f.pending); const receipt = await host.prepare()
      rmSync(f.runDir, { recursive: true, force: true })
      const pending = f.host(); pending.configure(f.pending)
      await expect(pending.prepare()).rejects.toThrow()
      const cold = f.host(); cold.configure(receipt)
      expect(await cold.prepare()).toEqual(receipt)
      writeFileSync(join(f.stateRoot, "workspace-repository.json"), JSON.stringify({ ...receipt, bindingID: randomUUID() }))
      await expect(cold.prepare()).rejects.toThrow()
    } finally { f.close() }
  })

  test("rejects changed binding, wrong branch and multiple origin URLs", async () => {
    const f = fixture()
    try {
      const host = f.host(); host.configure(f.pending); const receipt = await host.prepare()
      expect(() => host.configure({ ...receipt, workingBranch: "different" })).toThrow()
      f.command(["checkout", "-b", "different"], f.workspace)
      await expect(host.prepare()).rejects.toThrow()
      f.command(["checkout", f.pending.workingBranch], f.workspace)
      f.command(["config", "--add", "remote.origin.url", f.pending.repository], f.workspace)
      await expect(host.prepare()).rejects.toThrow()
    } finally { f.close() }
  })

  test("mirror publication replaces a concurrent symlink without writing its target", async () => {
    const f = fixture()
    try {
      const outside = join(f.root, "protected.txt"); writeFileSync(outside, "unchanged")
      let verified = 0
      const host = new WorkspaceRepositoryHost({ workspace: f.workspace, stateRoot: f.stateRoot, runDir: f.runDir, perform: async input => {
        const result = await f.perform(input)
        if (input.action === "verify" && ++verified === 2) symlinkSync(outside, join(f.stateRoot, "workspace-repository.json"))
        return result
      } })
      host.configure(f.pending); const receipt = await host.prepare()
      expect(readFileSync(outside, "utf8")).toBe("unchanged")
      expect(JSON.parse(readFileSync(join(f.stateRoot, "workspace-repository.json"), "utf8"))).toEqual(receipt)
    } finally { f.close() }
  })

  test("rejects core.worktree redirecting Git outside the selected workspace", async () => {
    const f = fixture()
    try {
      const host = f.host(); host.configure(f.pending); await host.prepare()
      const other = join(f.root, "other-worktree"); mkdirSync(other)
      f.command(["config", "core.worktree", other], f.workspace)
      await expect(host.prepare()).rejects.toThrow()
    } finally { f.close() }
  })

  test("production verification ignores replacement refs that would fake base ancestry", async () => {
    const f = fixture()
    try {
      const host = f.host(); host.configure(f.pending); const receipt = await host.prepare()
      f.command(["config", "user.name", "Fixture"], f.workspace); f.command(["config", "user.email", "fixture@example.invalid"], f.workspace)
      const unrelated = f.command(["commit-tree", "HEAD^{tree}", "-m", "unrelated root"], f.workspace)
      // The test writes the replacement explicitly; production Git must ignore it.
      f.command(["replace", "--graft", "HEAD", unrelated], f.workspace)
      await expect(executeRepositoryAction({ action: "verify", workspace: f.workspace, staging: `/tmp/aboiteau-bound-${randomUUID()}`, binding: { ...receipt, baseCommit: unrelated } })).rejects.toThrow()
      mkdirSync(join(f.workspace, ".git", "info"), { recursive: true })
      writeFileSync(join(f.workspace, ".git", "info", "grafts"), `${f.baseCommit} ${unrelated}\n`)
      await expect(executeRepositoryAction({ action: "verify", workspace: f.workspace, staging: `/tmp/aboiteau-bound-${randomUUID()}`, binding: { ...receipt, baseCommit: unrelated } })).rejects.toThrow()
    } finally { f.close() }
  })

  test("account seeds reject root binding receipts and temporary mirror names", () => {
    expect(accountSeedContainsStow("./workspace-repository.json\n")).toBe(true)
    expect(accountSeedContainsStow("././workspace-repository.json.partial.tmp\n")).toBe(true)
    expect(accountSeedContainsStow("./workspace-repository.json/child\n")).toBe(true)
    expect(accountSeedContainsStow("./config/workspace-repository.json\n")).toBe(false)
  })
})
