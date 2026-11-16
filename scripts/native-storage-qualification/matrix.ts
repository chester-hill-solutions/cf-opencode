/** Fixed synthetic inventory; never accepts caller-supplied paths or payloads. */
export const MATRIX_VERSION = 1
export const DIRECT_MARKER = "synthetic-direct-file-v1\n"
export const METADATA_MARKER = "synthetic-full-object-metadata-v1\n"
export const keyMarker = (id: string) => `synthetic-key-${id}-v1\n`
export const KEY_CASES = [
  { id: "key-natural", key: "matrix/plain.txt", natural: true },
  { id: "key-spaces", key: "matrix/space name.txt", natural: true },
  { id: "key-unicode", key: "matrix/é-雪.txt", natural: true },
  { id: "key-percent", key: "matrix/literal%2Fname.txt", natural: true },
  // Stow's portable layout escapes names containing Windows-reserved characters.
  { id: "key-punctuation", key: "matrix/hash#question?.txt", natural: false },
  { id: "key-double-slash", key: "matrix//double.txt", natural: false },
  { id: "key-dot-segment", key: "matrix/../matrix-alias-canary.txt", natural: false },
  { id: "key-traversal", key: "../tmp/matrix-outside-canary.txt", natural: false },
  { id: "key-reserved-stow", key: ".stow/matrix-probe", natural: false },
  { id: "key-reserved-git", key: ".git/matrix-probe", natural: false },
] as const

export const CONTAINER_CASE_IDS = [
  ...KEY_CASES.map((entry) => entry.id), "object-metadata", "unfinished-multipart", "git-state", "background-writer",
] as const
export const SERVICE_CASE_IDS = ["opencode-session", "registry-missing", "registry-mismatch"] as const
export const ALL_CASE_IDS = [...CONTAINER_CASE_IDS, ...SERVICE_CASE_IDS] as const
export type CaseID = typeof ALL_CASE_IDS[number]
export type Disposition = "prepared" | "preserved" | "refused_before_mutation" | "failed" | "not_exercised"
export const DETAIL_FLAGS = ["bytes", "listedExactKey", "filesystemBytes", "contentType", "cacheControl", "contentDisposition", "contentEncoding", "userMetadata"] as const
export const REASONS = [
  "awaiting_cold_restore", "bytes_restored", "mutation_refused", "mutation_changed_state", "bytes_mismatch",
  "unexpected_http_status", "request_failed", "metadata_mismatch", "multipart_lost", "multipart_incomplete",
  "git_mismatch", "writer_pair_mismatch", "writer_not_started", "fixture_quiesced", "session_mismatch",
  "registry_refused", "registry_started_or_mutated", "fixture_restore_failed",
] as const
export type CaseResult = {
  id: CaseID
  disposition: Disposition
  reason: typeof REASONS[number]
  httpStatus?: number
  checks?: Partial<Record<typeof DETAIL_FLAGS[number], boolean>>
}

/** Rebuild each row from a tiny allowlist; readiness/auth/error bodies never cross it. */
export function projectMatrix(value: unknown, ids: readonly string[]): CaseResult[] | undefined {
  if (!Array.isArray(value) || value.length !== ids.length) return undefined
  const rows: CaseResult[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined
    const row: Record<string, unknown> = item
    if (typeof row.id !== "string" || !ids.includes(row.id) || seen.has(row.id) ||
      !["prepared", "preserved", "refused_before_mutation", "failed", "not_exercised"].includes(String(row.disposition)) ||
      !REASONS.includes(row.reason as typeof REASONS[number]) ||
      (row.httpStatus !== undefined && (typeof row.httpStatus !== "number" || !Number.isInteger(row.httpStatus) || row.httpStatus < 100 || row.httpStatus > 599))) return undefined
    seen.add(row.id)
    const checks: CaseResult["checks"] = {}
    if (row.checks !== undefined) {
      if (typeof row.checks !== "object" || row.checks === null || Array.isArray(row.checks)) return undefined
      for (const flag of DETAIL_FLAGS) {
        const value = (row.checks as Record<string, unknown>)[flag]
        if (value !== undefined && typeof value !== "boolean") return undefined
        if (typeof value === "boolean") checks[flag] = value
      }
    }
    rows.push({ id: row.id as CaseID, disposition: row.disposition as Disposition,
      reason: row.reason as CaseResult["reason"], ...(row.httpStatus === undefined ? {} : { httpStatus: row.httpStatus as number }),
      ...(row.checks === undefined ? {} : { checks }) })
  }
  return ids.map((id) => rows.find((row) => row.id === id)!)
}

/** Completion needs a terminal observation for every predeclared case. */
export function matrixPassed(rows: readonly CaseResult[]): boolean {
  const projected = projectMatrix(rows, ALL_CASE_IDS)
  return Boolean(projected && projected.every((row) => {
    if (row.checks && Object.values(row.checks).some((value) => !value)) return false
    if (row.id === "registry-missing" || row.id === "registry-mismatch") return row.disposition === "refused_before_mutation"
    if (["key-natural", "key-spaces", "key-unicode", "git-state", "opencode-session", "background-writer"].includes(row.id)) return row.disposition === "preserved"
    return row.disposition === "preserved" || row.disposition === "refused_before_mutation"
  }))
}

export function preparationPassed(rows: readonly CaseResult[]): boolean {
  const projected = projectMatrix(rows, CONTAINER_CASE_IDS)
  return Boolean(projected && projected.every((row) =>
    (!row.checks || Object.values(row.checks).every(Boolean)) &&
    (row.disposition === "prepared" || row.disposition === "refused_before_mutation")))
}
