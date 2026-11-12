import { describe, expect, test } from "bun:test"
import { onlyWhenQualificationBucketEmpty, projectSafeProbe } from "./qualification-contract"

describe("staging qualification safety contract", () => {
  test("a global account-seed object blocks startup before the callback runs", async () => {
    let startupCalls = 0
    const result = await onlyWhenQualificationBucketEmpty(
      { objects: [{ key: "account/global-seed.tar.gz" }] },
      async () => {
        startupCalls++
        return "started"
      },
    )

    expect(result).toEqual({ empty: false })
    expect(startupCalls).toBe(0)
  })

  test("a truncated listing fails closed even when the returned page is empty", async () => {
    let startupCalls = 0
    const result = await onlyWhenQualificationBucketEmpty(
      { objects: [], truncated: true },
      async () => {
        startupCalls++
        return "started"
      },
    )

    expect(result).toEqual({ empty: false })
    expect(startupCalls).toBe(0)
  })

  test("probe projection drops unexpected credential-like output fields", () => {
    const projected = projectSafeProbe({
      mode: "restored",
      ok: true,
      workspaceID: "synthetic-workspace-1",
      directFileToS3GetMatches: true,
      s3PutToWorkspaceFileMatches: true,
      metadataTypeMatches: true,
      ephemeralSentinelAbsent: true,
      agentUID: 1001,
      controllerSHA256: "a".repeat(64),
      binarySHA256: "b".repeat(64),
      secretAccessKey: "synthetic-secret-must-not-survive",
    })

    expect(projected).toEqual({
      mode: "restored",
      ok: true,
      workspaceID: "synthetic-workspace-1",
      directFileToS3GetMatches: true,
      s3PutToWorkspaceFileMatches: true,
      metadataTypeMatches: true,
      ephemeralSentinelAbsent: true,
      agentUID: 1001,
      controllerSHA256: "a".repeat(64),
      binarySHA256: "b".repeat(64),
    })
    expect(projected).not.toHaveProperty("secretAccessKey")
  })
})
