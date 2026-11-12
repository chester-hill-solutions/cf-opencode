export type SafeProbeResult = {
  mode: "first" | "restored"
  ok: boolean
  workspaceID: string
  directFileToS3GetMatches: boolean
  s3PutToWorkspaceFileMatches: boolean
  metadataTypeMatches: boolean
  ephemeralSentinelAbsent: boolean
  agentUID: number
  controllerSHA256: string
  binarySHA256: string
}

export type BucketListPage = {
  objects: readonly unknown[]
  truncated?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Run a startup-dependent operation only after the entire staging bucket was
 * proven empty. A one-object page is enough: any object may be an account seed.
 */
export async function onlyWhenQualificationBucketEmpty<T>(
  page: BucketListPage,
  operation: () => Promise<T>,
): Promise<{ empty: false } | { empty: true; value: T }> {
  if (page.objects.length !== 0 || page.truncated === true) return { empty: false }
  return { empty: true, value: await operation() }
}

/** Validate stdout and return only the explicit non-secret probe fields. */
export function projectSafeProbe(value: unknown): SafeProbeResult | undefined {
  if (!isRecord(value)) return undefined
  const result = value
  if ((result.mode !== "first" && result.mode !== "restored") || typeof result.ok !== "boolean" ||
    typeof result.workspaceID !== "string" || typeof result.directFileToS3GetMatches !== "boolean" ||
    typeof result.s3PutToWorkspaceFileMatches !== "boolean" || typeof result.metadataTypeMatches !== "boolean" ||
    typeof result.ephemeralSentinelAbsent !== "boolean" || typeof result.agentUID !== "number" ||
    typeof result.controllerSHA256 !== "string" || typeof result.binarySHA256 !== "string") {
    return undefined
  }
  return {
    mode: result.mode,
    ok: result.ok,
    workspaceID: result.workspaceID,
    directFileToS3GetMatches: result.directFileToS3GetMatches,
    s3PutToWorkspaceFileMatches: result.s3PutToWorkspaceFileMatches,
    metadataTypeMatches: result.metadataTypeMatches,
    ephemeralSentinelAbsent: result.ephemeralSentinelAbsent,
    agentUID: result.agentUID,
    controllerSHA256: result.controllerSHA256,
    binarySHA256: result.binarySHA256,
  }
}
