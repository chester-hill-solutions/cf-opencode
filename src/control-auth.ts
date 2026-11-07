/**
 * Control-plane authentication. Shared by the container control server and its
 * tests; no runtime dependencies so it works in Bun and Workers.
 */

/** Length-independent comparison for bearer tokens. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index++) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return diff === 0
}

/** True only for `Authorization: Bearer <token>` with the expected token. */
export function bearerAuthorized(header: string | null, token: string): boolean {
  if (!token) return false
  return constantTimeEqual(header ?? "", `Bearer ${token}`)
}
