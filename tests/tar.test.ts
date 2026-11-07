import { describe, expect, test } from "bun:test"
import { assertSafeArchiveMembers, linkStaysInside, safeRelativeLink, safeArchiveMembers } from "../src/tar"

describe("archive member validation", () => {
  test("accepts ordinary relative members", () => {
    expect(safeArchiveMembers(".\n./src/index.ts\nsrc/a b.txt\n")).toBe(true)
  })

  test("rejects absolute paths", () => {
    expect(safeArchiveMembers("./ok\n/etc/passwd\n")).toBe(false)
    expect(safeArchiveMembers("C:\\Windows\\system.ini\n")).toBe(false)
  })

  test("rejects traversal", () => {
    expect(safeArchiveMembers("../../etc/passwd\n")).toBe(false)
    expect(safeArchiveMembers("src/../../escape\n")).toBe(false)
    expect(safeArchiveMembers("..\\..\\escape\n")).toBe(false)
  })

  test("throws from the asserting variant", () => {
    expect(() => assertSafeArchiveMembers("./ok\n../bad\n")).toThrow(/escapes/)
  })
})

describe("hard-link targets", () => {
  test("accepts relative targets inside the archive", () => {
    expect(safeRelativeLink("./b")).toBe(true)
    expect(safeRelativeLink("dir/file")).toBe(true)
  })

  test("rejects absolute and escaping targets", () => {
    expect(safeRelativeLink("/var/lib/aboiteau/state/data/opencode/auth.json")).toBe(false)
    expect(safeRelativeLink("../../etc/passwd")).toBe(false)
    expect(safeRelativeLink("dir/../../escape")).toBe(false)
    expect(safeRelativeLink("C:\\Windows\\system.ini")).toBe(false)
    expect(safeRelativeLink("")).toBe(false)
  })
})

describe("workspace link containment", () => {  test("allows links that resolve inside the workspace", () => {
    expect(linkStaysInside("/workspace", "/workspace/docs/readme.md")).toBe(true)
    expect(linkStaysInside("/workspace/", "/workspace/docs/readme.md")).toBe(true)
    expect(linkStaysInside("/workspace", "/workspace")).toBe(true)
  })

  test("rejects links that resolve outside the workspace", () => {
    expect(linkStaysInside("/workspace", "/var/lib/aboiteau/state/data/opencode/auth.json")).toBe(false)
    expect(linkStaysInside("/workspace", "/etc/passwd")).toBe(false)
    expect(linkStaysInside("/workspace", "/workspace-evil/file")).toBe(false)
    expect(linkStaysInside("/workspace", "")).toBe(false)
  })
})
