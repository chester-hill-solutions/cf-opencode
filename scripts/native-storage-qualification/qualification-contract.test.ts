import { describe, expect, test } from "bun:test"
import { onlyWhenQualificationBucketEmpty, projectSafeProbe } from "./qualification-contract"
import { QUALIFICATION_ARTIFACT, matchesQualificationRuntime, matchesQualificationReceipt } from "./artifact"
import { NATIVE_STORAGE_PROBE } from "./container-probe"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { ALL_CASE_IDS, CONTAINER_CASE_IDS, MATRIX_VERSION, matrixPassed, preparationPassed, projectMatrix, type CaseResult } from "./matrix"

describe("staging qualification safety contract", () => {
  const frozenRuntime = {
    image: QUALIFICATION_ARTIFACT.image,
    profile: QUALIFICATION_ARTIFACT.profile,
    instance: { ...QUALIFICATION_ARTIFACT.instance },
  }

  test("refuses implicit profiles, a different image, and mismatched resources", () => {
    expect(matchesQualificationRuntime(frozenRuntime)).toBe(true)
    for (const override of [
      { profile: undefined }, { profile: "standard-1" }, { profile: "custom-1cpu-3gib" },
      { image: "registry.invalid/old@sha256:" + "0".repeat(64) },
      { instance: "standard-1" }, { instance: null },
      { instance: { ...frozenRuntime.instance, vcpu: 0.5 } },
      { instance: { ...frozenRuntime.instance, memoryMib: 3072 } },
      { instance: { ...frozenRuntime.instance, diskMb: 4096 } },
    ]) expect(matchesQualificationRuntime({ ...frozenRuntime, ...override })).toBe(false)
  })

  test("refuses historical receipts even when their image is reused", () => {
    const receipt = {
      image: QUALIFICATION_ARTIFACT.image,
      controllerSHA256: QUALIFICATION_ARTIFACT.controllerSHA256,
      binarySHA256: QUALIFICATION_ARTIFACT.binarySHA256,
      runtime: { profile: frozenRuntime.profile, requested: frozenRuntime.instance },
    }
    expect(matchesQualificationReceipt(receipt)).toBe(true)
    expect(matchesQualificationReceipt({ ...receipt, runtime: undefined })).toBe(false)
    expect(matchesQualificationReceipt({ ...receipt, controllerSHA256: "0".repeat(64) })).toBe(false)
    expect(matchesQualificationReceipt({ ...receipt, binarySHA256: "0".repeat(64) })).toBe(false)
    expect(matchesQualificationReceipt({ ...receipt, runtime: { ...receipt.runtime, requested: "standard-1" } })).toBe(false)
  })

  test("the generated probe parses and the frozen controller matches current source", () => {
    // Parse the actual generated program without executing its filesystem/S3 work.
    const transformed = new Bun.Transpiler({ loader: "ts" }).transformSync(NATIVE_STORAGE_PROBE)
    expect(transformed).toContain(QUALIFICATION_ARTIFACT.controllerSHA256)
    expect(transformed).toContain(QUALIFICATION_ARTIFACT.binarySHA256)
    const controller = readFileSync(resolve(import.meta.dir, "../../control-server.ts"))
    expect(createHash("sha256").update(controller).digest("hex")).toBe(QUALIFICATION_ARTIFACT.controllerSHA256)
    const dockerfile = readFileSync(resolve(import.meta.dir, "../../Dockerfile"), "utf8")
    expect(dockerfile).toContain(`ARG STOW_VERSION=${QUALIFICATION_ARTIFACT.stowVersion}\n`)
    const template = JSON.parse(readFileSync(resolve(import.meta.dir, "wrangler.template.jsonc"), "utf8")
      .replace(/^\s*\/\/.*$/gm, ""))
    expect(template.vars.CONTAINER_INSTANCE_PROFILE).toBe(QUALIFICATION_ARTIFACT.profile)
    expect(template.vars.IDLE_CLOSE_SECONDS).toBe("300")
  })

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
    const matrix = CONTAINER_CASE_IDS.map((id): CaseResult => ({ id, disposition: "preserved", reason: "bytes_restored" }))
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
      matrixVersion: MATRIX_VERSION,
      matrix: matrix.map((row) => ({ ...row, authorization: "synthetic-secret-must-not-survive",
        checks: { bytes: true, secretAccessKey: "synthetic-secret-must-not-survive" } })),
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
      matrixVersion: MATRIX_VERSION,
      matrix: matrix.map((row) => ({ ...row, checks: { bytes: true } })),
    })
    expect(projected).not.toHaveProperty("secretAccessKey")
    expect(JSON.stringify(projected)).not.toContain("synthetic-secret-must-not-survive")
  })

  test("a complete green matrix needs every case exactly once with its required disposition", () => {
    const rows = ALL_CASE_IDS.map((id): CaseResult => ({ id,
      disposition: id.startsWith("registry-") ? "refused_before_mutation" : "preserved",
      reason: id.startsWith("registry-") ? "registry_refused" : "bytes_restored" }))
    expect(matrixPassed(rows)).toBe(true)
    expect(matrixPassed(rows.map((row) => row.id === "object-metadata" ? { ...row, checks: { cacheControl: false } } : row))).toBe(false)
    expect(matrixPassed(rows.slice(1))).toBe(false)
    expect(matrixPassed([...rows.slice(1), rows[1]])).toBe(false)
    for (const disposition of ["failed", "not_exercised", "prepared", "refused_before_mutation"] as const) {
      expect(matrixPassed(rows.map((row) => row.id === "git-state" ? { ...row, disposition } : row))).toBe(false)
    }
    expect(matrixPassed(rows.map((row) => row.id === "registry-missing" ? { ...row, disposition: "preserved" } : row))).toBe(false)
    expect(projectMatrix(rows.map((row) => ({ ...row, reason: "credential-containing arbitrary error" })), ALL_CASE_IDS)).toBeUndefined()
    const prepared = CONTAINER_CASE_IDS.map((id): CaseResult => ({ id, disposition: "prepared", reason: "awaiting_cold_restore" }))
    expect(preparationPassed(prepared)).toBe(true)
    expect(preparationPassed(prepared.map((row) => row.id === "key-natural" ? { ...row, checks: { bytes: false } } : row))).toBe(false)
    expect(matrixPassed(prepared)).toBe(false)
    expect(preparationPassed(prepared.map((row) => ({ ...row, disposition: "failed" })))).toBe(false)
    expect(projectMatrix(rows.map((row) => ({ ...row, checks: { bytes: "not-a-boolean" } })), ALL_CASE_IDS)).toBeUndefined()
  })
})
