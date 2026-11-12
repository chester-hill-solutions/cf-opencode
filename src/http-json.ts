/** Parse a request body that is expected to contain a JSON object. */
export async function parseObjectJson(
  request: Request,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: "invalid json" | "body must be an object" }> {
  let value: unknown
  try {
    value = await request.json()
  } catch {
    return { ok: false, error: "invalid json" }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "body must be an object" }
  }
  return { ok: true, value: value as Record<string, unknown> }
}
