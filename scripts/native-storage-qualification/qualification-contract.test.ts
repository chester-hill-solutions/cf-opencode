import { describe, expect, test } from "bun:test"
import { onlyWhenQualificationBucketEmpty, projectSafeProbe } from "./qualification-contract"
import { QUALIFICATION_ARTIFACT, matchesQualificationRuntime, matchesQualificationReceipt } from "./artifact"
import { NATIVE_STORAGE_PROBE } from "./container-probe"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

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
