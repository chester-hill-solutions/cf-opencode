/** Frozen R0-15 candidate; changing any pin requires a new qualification receipt. */
export const QUALIFICATION_ARTIFACT = {
  image: "registry.cloudflare.com/ad5ec479b9a421faa2ed06c3d1c2b23a/cf-opencode-shape-ab@sha256:2cd03c57e7458d337fde892cb6a729969e5dd55d6e3f61d01f0ac67068fcc2ba",
  stowVersion: "0.4.0",
  controllerSHA256: "0ec5e1e2dff12951041e837cab3aa877701f1d02359f6ecc8650e1cf20c8cace",
  binarySHA256: "6f0f247912de4c4d5d296a3176fe291b7c29717498f5778d920949d4025420b6",
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
