import { QUALIFICATION_ARTIFACT } from "./artifact"

/** A frozen image never qualifies a changed controller without new provenance. */
export async function withFrozenQualificationController<T>(
  actualSHA256: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  if (actualSHA256 !== QUALIFICATION_ARTIFACT.controllerSHA256) {
    throw new Error("QUALIFICATION_SOURCE_DRIFT: current control-server.ts differs from the frozen image. " +
      "Existing image pins and receipts remain historical; a new image and qualification receipt are required for current source.")
  }
  return operation()
}
