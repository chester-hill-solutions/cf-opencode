/** Consume the fixed `/start` response without reading a stream twice. */
export async function successfulStartProof(response: Response): Promise<boolean> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    return false
  }
  try {
    const proof: unknown = await response.json()
    return typeof proof === "object" && proof !== null && !Array.isArray(proof) &&
      (proof as { ok?: unknown }).ok === true
  } catch {
    // `json()` consumes the response stream before a parse error. It must not
    // be canceled again from this path because the body may already be locked.
    return false
  }
}
