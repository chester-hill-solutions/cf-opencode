import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stateFingerprint } from "../control-server"

const roots: string[] = []

function root() {
  const dir = mkdtempSync(join(tmpdir(), "aboiteau-state-"))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("state checkpoint fingerprint", () => {
  test("changes when state changes and ignores hot scratch", () => {
    const dir = root()
    writeFileSync(join(dir, "config.json"), "{}")
    mkdirSync(join(dir, "data"))
    writeFileSync(join(dir, "data", "opencode.db"), "db")

    const first = stateFingerprint(dir)
    writeFileSync(join(dir, "config.json"), '{"changed":true}')
    const second = stateFingerprint(dir)
    expect(second).not.toBe(first)

    // Cache and log are regenerated on every start and must not force a write.
    mkdirSync(join(dir, "cache"))
    writeFileSync(join(dir, "cache", "blob"), "hot")
    mkdirSync(join(dir, "log"))
    writeFileSync(join(dir, "log", "run.log"), "noise")
    expect(stateFingerprint(dir)).toBe(second)
  })
})
