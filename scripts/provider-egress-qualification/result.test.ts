import { describe, expect, test } from "bun:test"
import { providerQualificationPassed, type ProviderQualificationResult } from "./result"

const valid: ProviderQualificationResult = {
  agentUID1001: true,
  cwdIsWorkspace: true,
  configHasScopedToken: true,
  stateHasUpstreamSecret: false,
  stateScanCompleted: true,
  stateFilesRead: 1,
  envHasUpstreamSecret: false,
  sameUIDProcHasUpstreamSecret: false,
  sameUIDProcScanCompleted: true,
  sameUIDEnvironmentsRead: 1,
  ownEnvironmentRead: true,
  repoBunTestCanReadUpstreamSecret: false,
  repoBunTestCompleted: true,
  httpJson: true,
  sse: true,
  sseChunks: 1,
  wrongTokenRejected: true,
  wrongModelRejected: true,
  wrongPathRejected: true,
  hostSpoofRejected: true,
  wrongMethodRejected: true,
  exampleHttpBlocked: true,
  openaiHttpsBlocked: true,
  rawIPHttpsBlocked: true,
  rawIPTCPBlocked: true,
}

describe("provider qualification result", () => {
  test("accepts a complete receipt with positive and negative evidence", () => {
    expect(providerQualificationPassed(valid)).toBe(true)
  })

  test("rejects every false expected-positive and true expected-negative result", () => {
    for (const [key, value] of Object.entries(valid)) {
      if (typeof value !== "boolean") continue
      const changed = { ...valid, [key]: !value }
      expect(providerQualificationPassed(changed)).toBe(false)
    }
  })

  test("rejects each missing field and unknown fields", () => {
    for (const key of Object.keys(valid) as Array<keyof ProviderQualificationResult>) {
      const changed = { ...valid }
      delete changed[key]
      expect(providerQualificationPassed(changed)).toBe(false)
    }
    expect(providerQualificationPassed({ ...valid, unexpected: true })).toBe(false)
  })

  test("requires non-vacuous readable state, same-uid environments, and SSE chunks", () => {
    expect(providerQualificationPassed({ ...valid, stateFilesRead: 0 })).toBe(false)
    expect(providerQualificationPassed({ ...valid, sameUIDEnvironmentsRead: 0 })).toBe(false)
    expect(providerQualificationPassed({ ...valid, sseChunks: 0 })).toBe(false)
  })
})
