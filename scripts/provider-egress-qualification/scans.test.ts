import { describe, expect, test } from "bun:test"
import {
  scanSameUIDEnvironments,
  scanStateFiles,
  type ProcessScanIO,
  type StateScanIO,
} from "./scans"

const bytes = (text = "safe") => new TextEncoder().encode(text)
const codedError = (code: string) => Object.assign(new Error(code), { code })

function stateIO(files: Record<string, { size?: number; content?: string; inspectError?: string; readError?: string }>): StateScanIO {
  return {
    entries(path) {
      if (path === "/state") return Object.keys(files)
      return []
    },
    inspect(path) {
      const name = path.slice("/state/".length)
      const file = files[name]
      if (!file) throw codedError("ENOENT")
      if (file.inspectError) throw codedError(file.inspectError)
      return { kind: "file", size: file.size ?? 1 }
    },
    read(path) {
      const file = files[path.slice("/state/".length)]
      if (!file) throw codedError("ENOENT")
      if (file.readError) throw codedError(file.readError)
      return bytes(file.content ?? "safe")
    },
  }
}

function procIO(options: {
  pids?: string[]
  uids?: Record<string, number>
  envs?: Record<string, string>
  inspectErrors?: Record<string, string>
  envErrors?: Record<string, string>
} = {}): ProcessScanIO {
  const uids = options.uids ?? { "100": 1001, "101": 1001 }
  const envs = options.envs ?? { "100": "PATH=/bin", "101": "PATH=/bin" }
  return {
    processIDs: () => options.pids ?? Object.keys(uids),
    processUID(pid) {
      if (options.inspectErrors?.[pid]) throw codedError(options.inspectErrors[pid]!)
      if (!(pid in uids)) throw codedError("ENOENT")
      return uids[pid]!
    },
    environment(pid) {
      if (options.envErrors?.[pid]) throw codedError(options.envErrors[pid]!)
      if (!(pid in envs)) throw codedError("ENOENT")
      return bytes(envs[pid]!)
    },
  }
}

describe("provider egress exposure scans", () => {
  test("state scan succeeds only when every listed readable entry is checked", () => {
    const clean = scanStateFiles("/state", stateIO({ a: { content: "safe" }, b: { content: "also safe" } }))
    expect(clean).toMatchObject({ exposed: false, complete: true, filesRead: 2 })

    const unreadable = scanStateFiles("/state", stateIO({ a: { content: "safe" }, b: { readError: "EACCES" } }))
    expect(unreadable).toMatchObject({ exposed: false, complete: false, filesRead: 1 })

    const unstatable = scanStateFiles("/state", stateIO({ a: { content: "safe" }, b: { inspectError: "EACCES" } }))
    expect(unstatable.complete).toBe(false)

    const oversized = scanStateFiles("/state", stateIO({ a: { content: "safe" }, b: { size: 8 * 1024 * 1024 + 1 } }))
    expect(oversized).toMatchObject({ complete: false, filesRead: 1 })

    const unreadableRoot = scanStateFiles("/state", {
      entries: () => { throw codedError("EACCES") },
      inspect: () => ({ kind: "other", size: 0 }),
      read: () => bytes(),
    })
    expect(unreadableRoot).toMatchObject({ complete: false, filesRead: 0 })

    const unsupportedEntry = scanStateFiles("/state", {
      entries: () => ["readable", "special"],
      inspect: (path) => path.endsWith("special")
        ? { kind: "other", size: 0 }
        : { kind: "file", size: 1 },
      read: () => bytes("safe"),
    })
    expect(unsupportedEntry).toMatchObject({ exposed: false, complete: false, filesRead: 1 })
  })

  test("state scan treats a discovered synthetic upstream marker as exposure", () => {
    expect(scanStateFiles("/state", stateIO({ a: { content: "R1_7A_UPSTREAM_example" } }))).toMatchObject({
      exposed: true,
      complete: true,
    })
  })

  test("same-UID scan requires own environ and every still-present process environ", () => {
    const clean = scanSameUIDEnvironments("100", 1001, procIO())
    expect(clean).toMatchObject({ exposed: false, complete: true, environmentsRead: 2, ownEnvironmentRead: true })

    const unreadable = scanSameUIDEnvironments("100", 1001, procIO({
      envErrors: { "101": "EACCES" },
    }))
    expect(unreadable).toMatchObject({ complete: false, environmentsRead: 1, ownEnvironmentRead: true })

    const ownUnreadable = scanSameUIDEnvironments("100", 1001, procIO({
      envErrors: { "100": "EACCES" },
    }))
    expect(ownUnreadable.complete).toBe(false)
  })

  test("same-UID scan tolerates ENOENT only when the process is confirmed gone", () => {
    let statCalls = 0
    const gone: ProcessScanIO = {
      processIDs: () => ["100", "101"],
      processUID(pid) {
        if (pid === "101") {
          statCalls++
          if (statCalls > 1) throw codedError("ENOENT")
        }
        return 1001
      },
      environment(pid) {
        if (pid === "101") throw codedError("ENOENT")
        return bytes("safe")
      },
    }
    expect(scanSameUIDEnvironments("100", 1001, gone).complete).toBe(true)

    let initialFailures = 0
    const initiallyDisappearing: ProcessScanIO = {
      processIDs: () => ["100", "101"],
      processUID(pid) {
        if (pid === "101" && initialFailures++ === 0) throw codedError("ENOENT")
        return 1001
      },
      environment: (pid) => bytes(pid === "100" ? "safe" : "also safe"),
    }
    expect(scanSameUIDEnvironments("100", 1001, initiallyDisappearing).complete).toBe(false)

    const stillPresent = scanSameUIDEnvironments("100", 1001, procIO({
      envErrors: { "101": "ENOENT" },
    }))
    expect(stillPresent.complete).toBe(false)

    const exposure = scanSameUIDEnvironments("100", 1001, procIO({
      envs: { "100": "safe", "101": "R1_7A_UPSTREAM_secret" },
    }))
    expect(exposure).toMatchObject({ exposed: true, complete: true })
  })

  test("empty or inaccessible process inventories are incomplete", () => {
    expect(scanSameUIDEnvironments("100", 1001, procIO({ pids: [] })).complete).toBe(false)
    expect(scanSameUIDEnvironments("100", 1001, {
      processIDs: () => { throw codedError("EACCES") },
      processUID: () => 1001,
      environment: () => bytes("safe"),
    }).complete).toBe(false)
  })
})
