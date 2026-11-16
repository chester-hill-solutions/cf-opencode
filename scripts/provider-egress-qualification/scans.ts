const MARKER = "R1_7A_UPSTREAM_"
const MAX_FILE_BYTES = 8 * 1024 * 1024

function errno(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

export interface StateScanIO {
  entries(path: string): string[]
  inspect(path: string): { kind: "directory" | "file" | "other"; size: number }
  read(path: string): Uint8Array
}

export interface StateScanResult {
  exposed: boolean
  complete: boolean
  filesRead: number
  files: string[]
}

/** Walk every readable state entry; any unresolved failure makes the scan incomplete. */
export function scanStateFiles(root: string, io: StateScanIO): StateScanResult {
  const result: StateScanResult = { exposed: false, complete: true, filesRead: 0, files: [] }
  const visit = (path: string, isRoot = false): void => {
    let entries: string[]
    try {
      entries = io.entries(path)
    } catch (error) {
      if (!(errno(error) === "ENOENT" && !isRoot)) result.complete = false
      return
    }
    for (const entry of entries) {
      const child = `${path.replace(/\/$/, "")}/${entry}`
      let inspected: ReturnType<StateScanIO["inspect"]>
      try {
        inspected = io.inspect(child)
      } catch (error) {
        if (errno(error) !== "ENOENT") result.complete = false
        continue
      }
      if (inspected.kind === "directory") {
        visit(child)
        continue
      }
      if (inspected.kind !== "file") {
        result.complete = false
        continue
      }
      if (inspected.size > MAX_FILE_BYTES) {
        result.complete = false
        continue
      }
      try {
        const content = io.read(child)
        result.filesRead++
        result.files.push(child)
        if (Buffer.from(content).includes(MARKER)) result.exposed = true
      } catch (error) {
        if (errno(error) !== "ENOENT") result.complete = false
      }
    }
  }
  visit(root, true)
  if (result.filesRead === 0) result.complete = false
  return result
}

export interface ProcessScanIO {
  processIDs(): string[]
  processUID(pid: string): number
  environment(pid: string): Uint8Array
}

export interface ProcessScanResult {
  exposed: boolean
  complete: boolean
  environmentsRead: number
  ownEnvironmentRead: boolean
}

/** Scan every visible same-UID environ; tolerate ENOENT only after confirming the PID vanished. */
export function scanSameUIDEnvironments(ownPID: string, uid: number, io: ProcessScanIO): ProcessScanResult {
  const result: ProcessScanResult = {
    exposed: false,
    complete: true,
    environmentsRead: 0,
    ownEnvironmentRead: false,
  }
  let pids: string[]
  try {
    pids = io.processIDs()
  } catch {
    result.complete = false
    return result
  }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue
    let processUID: number
    try {
      processUID = io.processUID(pid)
    } catch (error) {
      if (errno(error) === "ENOENT") {
        try {
          io.processUID(pid)
          result.complete = false
        } catch (confirmError) {
          if (errno(confirmError) !== "ENOENT") result.complete = false
        }
      } else {
        result.complete = false
      }
      continue
    }
    if (processUID !== uid) continue
    try {
      const env = io.environment(pid)
      result.environmentsRead++
      if (pid === ownPID) result.ownEnvironmentRead = true
      if (Buffer.from(env).includes(MARKER)) result.exposed = true
    } catch (error) {
      if (errno(error) !== "ENOENT") {
        result.complete = false
        continue
      }
      // ENOENT is a benign race only if the PID has actually disappeared.
      try {
        io.processUID(pid)
        result.complete = false
      } catch (confirmError) {
        if (errno(confirmError) !== "ENOENT") result.complete = false
      }
    }
  }
  if (!result.ownEnvironmentRead || result.environmentsRead === 0) result.complete = false
  return result
}
