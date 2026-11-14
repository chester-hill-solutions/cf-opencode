/** Frozen R0-15 candidate; changing any pin requires a new qualification receipt. */
export const QUALIFICATION_ARTIFACT = {
  image: "registry.cloudflare.com/ad5ec479b9a421faa2ed06c3d1c2b23a/cf-opencode-metadata-candidate@sha256:4fe5c456f39903be5cbba5027a5d00f1961ac37fb63c7e6a3493c09af2903f24",
  stowVersion: "0.4.0",
  stowPatch: "metadata-refusal.2",
  stowSourceCommit: "3bb3e890bbe56f11dd783c2ccfb9bd2813156919",
  stowPatchSHA256: "054b8b091a052189af1d4e17d2464b9a2a95b5fa55421a8f3b9358c326c7d014",
  controllerSHA256: "0ec5e1e2dff12951041e837cab3aa877701f1d02359f6ecc8650e1cf20c8cace",
  binarySHA256: "39615975e58008a60a94b0c696e9ee46aa8dba77e1899e5297dcb4f5010e3174",
  profile: "custom-1cpu-2gib",
  instance: { vcpu: 1, memoryMib: 2048, diskMb: 8192 },
} as const

/** Validate the exact image and requested resources before starting a runtime. */
export function matchesQualificationRuntime(input: {
  image?: string
  profile?: string
  instance: unknown
}): boolean {
  const instance = input.instance
  return input.image === QUALIFICATION_ARTIFACT.image &&
    input.profile === QUALIFICATION_ARTIFACT.profile &&
    typeof instance === "object" && instance !== null &&
    "vcpu" in instance && instance.vcpu === QUALIFICATION_ARTIFACT.instance.vcpu &&
    "memoryMib" in instance && instance.memoryMib === QUALIFICATION_ARTIFACT.instance.memoryMib &&
    "diskMb" in instance && instance.diskMb === QUALIFICATION_ARTIFACT.instance.diskMb
}

/** Historical or partially written receipts cannot qualify the frozen pair. */
export function matchesQualificationReceipt(input: {
  image: string
  controllerSHA256: string
  binarySHA256: string
  runtime?: { profile?: string; requested?: unknown }
}): boolean {
  return input.controllerSHA256 === QUALIFICATION_ARTIFACT.controllerSHA256 &&
    input.binarySHA256 === QUALIFICATION_ARTIFACT.binarySHA256 &&
    matchesQualificationRuntime({ image: input.image, profile: input.runtime?.profile, instance: input.runtime?.requested })
}
