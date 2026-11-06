import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { workspaceFingerprint } from "../control-server"

const dirs: string[] = []

function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cf-opencode-fingerprint-"))
  dirs.push(dir)
  git(dir, ["init", "-q"])
  git(dir, ["config", "user.email", "test@example.com"])
  git(dir, ["config", "user.name", "Test"])
  return dir
}

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
  }
  return result.stdout.toString()
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("workspaceFingerprint", () => {
  test("is stable when nothing changes", async () => {
    const dir = newRepo()
    writeFileSync(join(dir, "file.txt"), "one")
    git(dir, ["add", "."])
    git(dir, ["commit", "-qm", "init"])

    expect(await workspaceFingerprint(dir)).toBe(await workspaceFingerprint(dir))
  })

  test("changes when an already-modified tracked file is edited again", async () => {
    const dir = newRepo()
    writeFileSync(join(dir, "file.txt"), "one")
    git(dir, ["add", "."])
    git(dir, ["commit", "-qm", "init"])

    const committed = await workspaceFingerprint(dir)
    writeFileSync(join(dir, "file.txt"), "two")
    const firstEdit = await workspaceFingerprint(dir)
    writeFileSync(join(dir, "file.txt"), "three")
    const secondEdit = await workspaceFingerprint(dir)

    expect(firstEdit).not.toBe(committed)
    // The status filenames are identical for both edits; the content is not.
    expect(secondEdit).not.toBe(firstEdit)
  })

  test("changes when an untracked file is edited", async () => {
    const dir = newRepo()
    writeFileSync(join(dir, "tracked.txt"), "one")
    git(dir, ["add", "."])
    git(dir, ["commit", "-qm", "init"])

    writeFileSync(join(dir, "notes.txt"), "draft")
    const firstEdit = await workspaceFingerprint(dir)
    writeFileSync(join(dir, "notes.txt"), "final")
    const secondEdit = await workspaceFingerprint(dir)

    expect(secondEdit).not.toBe(firstEdit)
  })

  test("records staged changes", async () => {
    const dir = newRepo()
    writeFileSync(join(dir, "file.txt"), "one")
    git(dir, ["add", "."])
    git(dir, ["commit", "-qm", "init"])

    writeFileSync(join(dir, "file.txt"), "staged")
    const unstaged = await workspaceFingerprint(dir)
    git(dir, ["add", "file.txt"])
    const staged = await workspaceFingerprint(dir)

    expect(staged).not.toBe(unstaged)
  })
})
