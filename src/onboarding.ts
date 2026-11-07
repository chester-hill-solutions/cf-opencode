/**
 * Worker-side onboarding policy. Kept pure so the proxy allowlist and the
 * finish gate can be tested without a Worker or container.
 */

/** One path segment of an integration id such as `provider:model`. */
const SEGMENT = /^[A-Za-z0-9._:@-]{1,200}$/

function segments(path: string): string[] | undefined {
  if (!path.startsWith("/")) return undefined
  const parts = path.slice(1).split("/")
  if (parts.some((part) => part === "." || part === ".." || !SEGMENT.test(part))) return undefined
  return parts
}

/**
 * The onboarding proxy may only reach the control-server endpoints the setup
 * wizard actually uses. Everything else (`/configure`, `/start`, `/restore`,
 * `/seed-state`, `/checkpoint`, `/state-checkpoint`) is internal.
 */
export function isOnboardingProxyPath(path: string, method: string): boolean {
  const parts = segments(path)
  if (!parts) return false
  const isGet = method === "GET" || method === "HEAD"
  const isPost = method === "POST"

  if (isGet && parts.length === 1 && (parts[0] === "integrations" || parts[0] === "models")) {
    return true
  }
  if (parts.length < 4 || parts[0] !== "integrations" || parts[2] !== "connect") return false

  // /integrations/:id/connect/oauth
  if (isPost && parts.length === 4 && parts[3] === "oauth") return true
  // /integrations/:id/connect/oauth/:attemptID
  if (isGet && parts.length === 5 && parts[3] === "oauth") return true
  // /integrations/:id/connect/oauth/:attemptID/complete
  if (isPost && parts.length === 6 && parts[3] === "oauth" && parts[5] === "complete") {
    return true
  }
  // /integrations/:id/connect/key
  if (isPost && parts.length === 4 && parts[3] === "key") return true
  return false
}

export interface IntegrationLike {
  connections?: unknown[]
}

/** A provider counts as connected only when it has at least one connection. */
export function hasConnectedProvider(integrations: IntegrationLike[]): boolean {
  return integrations.some(
    (integration) => Array.isArray(integration.connections) && integration.connections.length > 0,
  )
}
