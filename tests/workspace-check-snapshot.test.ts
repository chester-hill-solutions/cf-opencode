import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  verifyWorkspaceCheckSnapshot, workspaceCheckObjectOID, WORKSPACE_CHECK_SNAPSHOT_LIMITS as limits,
  type WorkspaceCheckSnapshot, type WorkspaceCheckGitObject,
} from "../src/workspace-check-snapshot"
import { invokeWorkspaceCheckSnapshot, readWorkspaceCheckHead, readWorkspaceCheckSnapshot } from "../workspace-check-snapshot"
import type { WorkspaceRepositoryReceipt } from "../src/workspace-repository"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
const bytes = (value: string) => new TextEncoder().encode(value)
const binding = (baseCommit: string): WorkspaceRepositoryReceipt => ({ schemaVersion: 1, bindingID: randomUUID(), repository: "https://github.com/example/snapshot", baseBranch: "main", workingBranch: "aboiteau/check", status: "bound", baseCommit })

async function graph(entries: Array<{ name: string | Uint8Array; content: string | Uint8Array; mode?: string }>, algorithm: "SHA-1" | "SHA-256" = "SHA-1"): Promise<WorkspaceCheckSnapshot> {
  const objects = new Map<string, WorkspaceCheckGitObject>()
  const store = async (type: WorkspaceCheckGitObject["type"], content: Uint8Array) => {
    const oid = await workspaceCheckObjectOID(type, content, algorithm)
    objects.set(oid, { oid, type, contentBase64: Buffer.from(content).toString("base64") })
    return oid
  }
  const parts: Buffer[] = []
  for (const entry of entries) {
    const id = await store("blob", typeof entry.content === "string" ? bytes(entry.content) : entry.content)
    parts.push(Buffer.from(`${entry.mode ?? "100644"} `), Buffer.from(entry.name), Buffer.from([0]), Buffer.from(id, "hex"))
  }
  const tree = await store("tree", Buffer.concat(parts))
  const commit = await store("commit", bytes(`tree ${tree}\nauthor Fixture <fixture@example.invalid> 0 +0000\ncommitter Fixture <fixture@example.invalid> 0 +0000\n\nfixture\n`))
  return { schemaVersion: 1, mode: "committed_only", worktreeChanges: "unverified", workspaceRepository: binding(commit), commit, tree, objects: [...objects.values()] }
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "aboiteau-check-snapshot-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const run = (args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "ignore", timeout: 10_000,
      env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1" } })
    if (result.exitCode !== 0) throw new Error("synthetic snapshot fixture failed")
    return result.stdout.toString().trim()
  }
  run(["init", "-b", "aboiteau/check"])
  run(["config", "user.name", "Fixture"]); run(["config", "user.email", "fixture@example.invalid"])
  run(["remote", "add", "origin", "https://github.com/example/snapshot"])
  mkdirSync(join(root, "nested"))
  writeFileSync(join(root, ".gitattributes"), "hidden.txt export-ignore\nsubst.txt export-subst\n*.filter filter=malicious\n")
  writeFileSync(join(root, "hidden.txt"), "must remain included\n")
  writeFileSync(join(root, "subst.txt"), "$Format:%H$\n")
  writeFileSync(join(root, "tracked.filter"), "committed bytes\n")
  writeFileSync(join(root, "nested", "binary.bin"), Buffer.from([0, 255, 10, 0, 42]))
  run(["add", "."]); run(["commit", "-m", "fixture"])
  const commit = run(["rev-parse", "HEAD"])
  return { root, run, commit, receipt: binding(commit) }
}

describe("cryptographic committed snapshot graph", () => {
  test.each(["SHA-1", "SHA-256"] as const)("verifies %s identity, bytes, executable mode and deterministic canonical JSON", async algorithm => {
    const input = await graph([{ name: "test.sh", mode: "100755", content: "exit 0\n" }, { name: "data.bin", content: new Uint8Array([0, 255, 10]) }], algorithm)
    const result = await verifyWorkspaceCheckSnapshot(input)
    expect(result.files).toEqual([{ path: "data.bin", mode: "100644", contentBase64: "AP8K" }, { path: "test.sh", mode: "100755", contentBase64: Buffer.from("exit 0\n").toString("base64") }])
    expect(result.snapshotSHA256).toMatch(/^[a-f0-9]{64}$/)
    const reordered = await verifyWorkspaceCheckSnapshot({ ...input, objects: [...input.objects].reverse() })
    expect(reordered.canonicalJSON).toBe(result.canonicalJSON)
    expect(reordered.snapshotSHA256).toBe(result.snapshotSHA256)
  })

  test("rejects substituted object bytes, missing objects and unreachable history/data", async () => {
    const input = await graph([{ name: "test.ts", content: "source" }])
    const blob = input.objects.find(item => item.type === "blob")!
    await expect(verifyWorkspaceCheckSnapshot({ ...input, objects: input.objects.map(item => item === blob ? { ...item, contentBase64: "dGFtcGVy" } : item) })).rejects.toThrow()
    await expect(verifyWorkspaceCheckSnapshot({ ...input, objects: input.objects.filter(item => item !== blob) })).rejects.toThrow()
    const extra = (await graph([{ name: "unreachable", content: "not in selected commit" }])).objects.find(item => item.type === "blob")!
    await expect(verifyWorkspaceCheckSnapshot({ ...input, objects: [...input.objects, extra] })).rejects.toThrow()
  })

  test.each(["../escape", "/absolute", "bad\\path", ".git", ".stow", "bad\nname"])("rejects unsafe tree entry %s", async name => {
    await expect(verifyWorkspaceCheckSnapshot(await graph([{ name, content: "x" }]))).rejects.toThrow()
  })

  test.each(["120000", "160000", "100664"])("rejects unsupported tree mode %s", async mode => {
    await expect(verifyWorkspaceCheckSnapshot(await graph([{ name: "entry", mode, content: "target" }]))).rejects.toThrow()
  })

  test("rejects duplicate paths and expanded bytes beyond the cap even when blobs deduplicate", async () => {
    await expect(verifyWorkspaceCheckSnapshot(await graph([{ name: "same", content: "x" }, { name: "same", content: "x" }]))).rejects.toThrow()
    const shared = new Uint8Array(limits.objectBytes).fill(42)
    const input = await graph(["a", "b", "c"].map(name => ({ name, content: shared })))
    expect(input.objects.filter(item => item.type === "blob").length).toBe(1)
    await expect(verifyWorkspaceCheckSnapshot(input)).rejects.toThrow()
  })

  test("rejects non-UTF8 names, overlong paths and object-count overflow", async () => {
    await expect(verifyWorkspaceCheckSnapshot(await graph([{ name: new Uint8Array([255]), content: "x" }]))).rejects.toThrow()
    await expect(verifyWorkspaceCheckSnapshot(await graph([{ name: "x".repeat(limits.pathBytes + 1), content: "x" }]))).rejects.toThrow()
    const input = await graph([{ name: "x", content: "x" }])
    await expect(verifyWorkspaceCheckSnapshot({ ...input, objects: Array.from({ length: limits.objects + 1 }, () => input.objects[0]) })).rejects.toThrow()
  })
})

describe("bounded agent Git reader", () => {
  test("includes export-ignore/subst bytes and never invokes injected worktree filters or scripts", async () => {
    const f = repository()
    const marker = join(f.root, "FILTER-RAN")
    writeFileSync(join(f.root, "tracked.filter"), "uncommitted changed bytes\n")
    f.run(["config", "filter.malicious.clean", `touch ${marker}`])
    let injected = false
    const probe = spyOn(Bun, "spawn")
    const writer = setInterval(() => {
      if (!injected && probe.mock.calls.some(([argv]) => argv.includes("cat-file"))) {
        injected = true
        appendFileSync(join(f.root, ".git", "config"), `\n[filter "later"]\n clean = touch ${marker}\n`)
      }
    }, 1)
    try {
      const result = await verifyWorkspaceCheckSnapshot(await readWorkspaceCheckSnapshot(f.root, f.receipt, f.commit))
      const contents = new Map(result.files.map(file => [file.path, Buffer.from(file.contentBase64, "base64").toString()]))
      expect(injected).toBe(true)
      expect(contents.get("hidden.txt")).toBe("must remain included\n")
      expect(contents.get("subst.txt")).toBe("$Format:%H$\n")
      expect(contents.get("tracked.filter")).toBe("committed bytes\n")
      expect(contents.has("FILTER-RAN")).toBe(false)
      expect(existsSync(marker)).toBe(false)
      expect(result.worktreeChanges).toBe("unverified")
    } finally { clearInterval(writer); probe.mockRestore() }
  })

  test("rejects HEAD moved during capture and serves read-only head without publishing metadata", async () => {
    const f = repository()
    const head = await readWorkspaceCheckHead(f.root, f.receipt)
    expect(head.commit).toBe(f.commit)
    expect(existsSync(join(f.root, "workspace-repository.json"))).toBe(false)
    const second = f.run(["commit-tree", "HEAD^{tree}", "-p", f.commit, "-m", "next"])
    const probe = spyOn(Bun, "spawn")
    let moved = false
    const writer = setInterval(() => {
      if (!moved && probe.mock.calls.some(([argv]) => argv.includes("cat-file"))) {
        moved = true
        writeFileSync(join(f.root, ".git", "refs", "heads", "aboiteau", "check"), `${second}\n`)
      }
    }, 1)
    try { await expect(readWorkspaceCheckSnapshot(f.root, f.receipt, f.commit)).rejects.toThrow() }
    finally { clearInterval(writer); probe.mockRestore() }
  })

  test("trusted parent verifies the real helper subprocess graph independently", async () => {
    const f = repository()
    const result = await invokeWorkspaceCheckSnapshot({ mode: "snapshot", workspace: f.root, workspaceRepository: f.receipt, commit: f.commit }, args => args)
    expect(result.commit).toBe(f.commit)
    expect("snapshotSHA256" in result).toBe(true)
    if (!("files" in result)) throw new Error("missing verified files")
    expect(result.files.some(file => file.path === ".git" || file.path.startsWith(".git/"))).toBe(false)
    expect(result.files.some(file => file.path === "nested/binary.bin" && file.contentBase64 === "AP8KACo=")).toBe(true)
  })
})
