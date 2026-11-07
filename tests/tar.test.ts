import { describe, expect, test } from "bun:test"
import { assertSafeArchiveMembers, safeArchiveMembers } from "../src/tar"

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
