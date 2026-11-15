export interface ProviderQualificationResult {
  agentUID1001: boolean
  cwdIsWorkspace: boolean
  configHasScopedToken: boolean
  stateHasUpstreamSecret: boolean
  stateScanCompleted: boolean
  stateFilesRead: number
  envHasUpstreamSecret: boolean
  sameUIDProcHasUpstreamSecret: boolean
  sameUIDProcScanCompleted: boolean
  sameUIDEnvironmentsRead: number
  ownEnvironmentRead: boolean
  repoBunTestCanReadUpstreamSecret: boolean
  repoBunTestCompleted: boolean
  httpJson: boolean
  sse: boolean
  sseChunks: number
  wrongTokenRejected: boolean
  wrongModelRejected: boolean
  wrongPathRejected: boolean
  hostSpoofRejected: boolean
  wrongMethodRejected: boolean
  exampleHttpBlocked: boolean
  openaiHttpsBlocked: boolean
  rawIPHttpsBlocked: boolean
  rawIPTCPBlocked: boolean
}

const BOOLEAN_EXPECTATIONS = {
  agentUID1001: true,
  cwdIsWorkspace: true,
  configHasScopedToken: true,
  stateHasUpstreamSecret: false,
  stateScanCompleted: true,
  envHasUpstreamSecret: false,
  sameUIDProcHasUpstreamSecret: false,
  sameUIDProcScanCompleted: true,
  ownEnvironmentRead: true,
  repoBunTestCanReadUpstreamSecret: false,
  repoBunTestCompleted: true,
  httpJson: true,
  sse: true,
  wrongTokenRejected: true,
  wrongModelRejected: true,
  wrongPathRejected: true,
  hostSpoofRejected: true,
  wrongMethodRejected: true,
  exampleHttpBlocked: true,
  openaiHttpsBlocked: true,
  rawIPHttpsBlocked: true,
  rawIPTCPBlocked: true,
} as const satisfies Partial<Record<keyof ProviderQualificationResult, boolean>>

const REQUIRED_KEYS = Object.keys({
  ...BOOLEAN_EXPECTATIONS,
  stateFilesRead: true,
  sameUIDEnvironmentsRead: true,
  sseChunks: true,
}).sort()

/** Validate the exact, typed evidence shape without deciding whether it passed. */
export function providerQualificationEvidence(value: unknown): value is ProviderQualificationResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== REQUIRED_KEYS.length || ownKeys.some((key) => typeof key !== "string")) return false
  const keys = (ownKeys as string[]).sort()
  if (keys.some((key, index) => key !== REQUIRED_KEYS[index])) return false

  for (const key of Object.keys(BOOLEAN_EXPECTATIONS)) {
    if (typeof record[key] !== "boolean") return false
  }
  for (const key of ["stateFilesRead", "sameUIDEnvironmentsRead", "sseChunks"] as const) {
    const count = record[key]
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return false
  }
  return true
}

/** Validate the allowlisted probe receipt, including positive and negative evidence. */
export function providerQualificationPassed(value: unknown): value is ProviderQualificationResult {
  if (!providerQualificationEvidence(value)) return false
  const record = value as unknown as Record<string, unknown>

  for (const [key, expected] of Object.entries(BOOLEAN_EXPECTATIONS)) {
    if (record[key] !== expected) return false
  }
  return Number.isInteger(record.stateFilesRead) && (record.stateFilesRead as number) > 0 &&
    Number.isInteger(record.sameUIDEnvironmentsRead) && (record.sameUIDEnvironmentsRead as number) > 0 &&
    Number.isInteger(record.sseChunks) && (record.sseChunks as number) > 0
}
