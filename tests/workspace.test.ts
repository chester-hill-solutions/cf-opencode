import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { archiveWorkspace, workspaceFingerprint } from "../control-server"

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

  test("changes when an ignored file is edited", async () => {
    const dir = newRepo()
    writeFileSync(join(dir, "file.txt"), "one")
    writeFileSync(join(dir, ".gitignore"), "ignored.bin\n")
    git(dir, ["add", "."])
    git(dir, ["commit", "-qm", "init"])

    writeFileSync(join(dir, "ignored.bin"), "draft")
    const firstEdit = await workspaceFingerprint(dir)
    writeFileSync(join(dir, "ignored.bin"), "final")
    const secondEdit = await workspaceFingerprint(dir)

    expect(secondEdit).not.toBe(firstEdit)
  })

  test("changes when a non-git workspace file is edited", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-opencode-fingerprint-nogit-"))
    dirs.push(dir)
    writeFileSync(join(dir, "a.txt"), "one")
    const baseline = await workspaceFingerprint(dir)
    expect(await workspaceFingerprint(dir)).toBe(baseline)

    writeFileSync(join(dir, "a.txt"), "two, with a longer body")
    const edited = await workspaceFingerprint(dir)
    expect(edited).not.toBe(baseline)
  })

  test("ignores edits to an existing legacy root .stow directory", async () => {
    const dir = newRepo()
    writeFileSync(join(dir, "file.txt"), "one")
    writeFileSync(join(dir, ".gitignore"), "/.stow/\n")
    git(dir, ["add", "."])
    git(dir, ["commit", "-qm", "init"])
    mkdirSync(join(dir, ".stow"))
    writeFileSync(join(dir, ".stow", "legacy-record"), "first")

    const baseline = await workspaceFingerprint(dir)
    writeFileSync(join(dir, ".stow", "legacy-record"), "second")
    expect(await workspaceFingerprint(dir)).toBe(baseline)

    const nonGit = mkdtempSync(join(tmpdir(), "cf-opencode-fingerprint-legacy-"))
    dirs.push(nonGit)
    mkdirSync(join(nonGit, ".stow"))
    writeFileSync(join(nonGit, ".stow", "legacy-record"), "first")
    const nonGitBaseline = await workspaceFingerprint(nonGit)
    writeFileSync(join(nonGit, ".stow", "legacy-record"), "second")
    expect(await workspaceFingerprint(nonGit)).toBe(nonGitBaseline)
  })

  test("fingerprints nested native .stow metadata in Git and non-Git workspaces", async () => {
    const dir = newRepo()
    writeFileSync(join(dir, "file.txt"), "one")
    writeFileSync(join(dir, ".gitignore"), "/.stow/\n")
    git(dir, ["add", "."])
    git(dir, ["commit", "-qm", "init"])
    mkdirSync(join(dir, "native-workspace", ".stow"), { recursive: true })
    writeFileSync(join(dir, "native-workspace", ".stow", "manifest.json"), '{"version":3}')
    writeFileSync(join(dir, "native-workspace", ".stow", "index.json"), '{"items":1}')

    const baseline = await workspaceFingerprint(dir)
    writeFileSync(join(dir, "native-workspace", ".stow", "manifest.json"), '{"version":3,"updated":true}')
    const manifestEdited = await workspaceFingerprint(dir)
    expect(manifestEdited).not.toBe(baseline)
    writeFileSync(join(dir, "native-workspace", ".stow", "index.json"), '{"items":2}')
    expect(await workspaceFingerprint(dir)).not.toBe(manifestEdited)

    const nonGit = mkdtempSync(join(tmpdir(), "cf-opencode-fingerprint-native-"))
    dirs.push(nonGit)
    mkdirSync(join(nonGit, "native-workspace", ".stow"), { recursive: true })
    writeFileSync(join(nonGit, "native-workspace", ".stow", "manifest.json"), '{"version":3}')
    writeFileSync(join(nonGit, "native-workspace", ".stow", "index.json"), '{"items":1}')
    const nonGitBaseline = await workspaceFingerprint(nonGit)
    writeFileSync(join(nonGit, "native-workspace", ".stow", "manifest.json"), '{"version":3,"updated":true}')
    const nonGitManifestEdited = await workspaceFingerprint(nonGit)
    expect(nonGitManifestEdited).not.toBe(nonGitBaseline)
    writeFileSync(join(nonGit, "native-workspace", ".stow", "index.json"), '{"items":2}')
    expect(await workspaceFingerprint(nonGit)).not.toBe(nonGitManifestEdited)
  })

  test("fingerprints metadata inside a nested independent Git repository", async () => {
    const dir = newRepo()
    writeFileSync(join(dir, "file.txt"), "one")
    writeFileSync(join(dir, ".gitignore"), "/.stow/\n")
    git(dir, ["add", "."])
    git(dir, ["commit", "-qm", "outer init"])

    const nested = join(dir, "native-workspace")
    mkdirSync(nested)
    git(nested, ["init", "-q"])
    git(nested, ["config", "user.email", "test@example.com"])
    git(nested, ["config", "user.name", "Test"])
    writeFileSync(join(nested, ".gitignore"), "/.stow/\n")
    writeFileSync(join(nested, "source.txt"), "inner repo")
    git(nested, ["add", "."])
    git(nested, ["commit", "-qm", "inner init"])
    mkdirSync(join(nested, ".stow"))
    writeFileSync(join(nested, ".stow", "index.json"), '{"items":1}')

    const initial = await workspaceFingerprint(dir)
    writeFileSync(join(nested, ".stow", "index.json"), '{"items":2}')
    const firstMetadataEdit = await workspaceFingerprint(dir)
    writeFileSync(join(nested, ".stow", "index.json"), '{"items":3}')
    const secondMetadataEdit = await workspaceFingerprint(dir)

    expect(firstMetadataEdit).not.toBe(initial)
    expect(secondMetadataEdit).not.toBe(firstMetadataEdit)

  })

  test("fingerprints ignored native metadata inside a tracked Git submodule", async () => {
    const source = newRepo()
    writeFileSync(join(source, ".gitignore"), "/.stow/\n")
    writeFileSync(join(source, "source.txt"), "nested repo")
    git(source, ["add", "."])
    git(source, ["commit", "-qm", "submodule source"])

    const dir = newRepo()
    writeFileSync(join(dir, "file.txt"), "outer repo")
    git(dir, ["add", "."])
    git(dir, ["commit", "-qm", "outer init"])
    git(dir, ["-c", "protocol.file.allow=always", "submodule", "add", source, "native-workspace"])
    git(dir, ["commit", "-qm", "add workspace submodule"])

    mkdirSync(join(dir, "native-workspace", ".stow"))
    writeFileSync(join(dir, "native-workspace", ".stow", "index.json"), '{"items":1}')
    const initial = await workspaceFingerprint(dir)
    writeFileSync(join(dir, "native-workspace", ".stow", "index.json"), '{"items":2}')
    const firstMetadataEdit = await workspaceFingerprint(dir)
    writeFileSync(join(dir, "native-workspace", ".stow", "index.json"), '{"items":3}')
    const secondMetadataEdit = await workspaceFingerprint(dir)

    expect(firstMetadataEdit).not.toBe(initial)
    expect(secondMetadataEdit).not.toBe(firstMetadataEdit)

    rmSync(join(dir, "native-workspace"), { recursive: true, force: true })
    expect(await workspaceFingerprint(dir)).not.toBe(secondMetadataEdit)
  })

  test("archives nested native .stow metadata but excludes legacy root .stow and node_modules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-opencode-archive-"))
    dirs.push(dir)
    const archiveDir = mkdtempSync(join(tmpdir(), "cf-opencode-archive-out-"))
    dirs.push(archiveDir)
    const archive = join(archiveDir, "workspace.tar.gz")
    mkdirSync(join(dir, ".stow"))
    writeFileSync(join(dir, ".stow", "legacy-record"), "legacy")
    mkdirSync(join(dir, "native-workspace", ".stow"), { recursive: true })
    writeFileSync(join(dir, "native-workspace", ".stow", "manifest.json"), '{"version":3}')
    writeFileSync(join(dir, "native-workspace", ".stow", "index.json"), '{"items":1}')
    mkdirSync(join(dir, "native-workspace", "node_modules", "package"), { recursive: true })
    writeFileSync(join(dir, "native-workspace", "node_modules", "package", "index.js"), "ignored")

    expect(await archiveWorkspace(archive, dir)).toBe(0)
    const listed = Bun.spawnSync(["tar", "tzf", archive], { stdout: "pipe", stderr: "pipe" })
    expect(listed.exitCode).toBe(0)
    const names = listed.stdout.toString().split("\n")
    expect(names).toContain("native-workspace/.stow/manifest.json")
    expect(names).toContain("native-workspace/.stow/index.json")
    expect(names).not.toContain(".stow/legacy-record")
    expect(names.some((name) => name.includes("node_modules"))).toBe(false)
  })
})
