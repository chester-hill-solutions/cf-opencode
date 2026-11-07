/**
 * HTTP rate limiting for the admin API.
 *
 * The response contract mirrors `createRateLimitMiddleware` from
 * `@chester-hill-solutions/hono-server`: a 429 with a `RATE_LIMITED` error
 * code and `RateLimit-*` headers. That middleware is Hono-specific and its
 * default store is an in-process Map, so it cannot enforce a limit across
 * Worker isolates. This uses the Cloudflare rate-limit binding instead.
 */

export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

/** Keep in step with the `ratelimits` binding in wrangler.jsonc. */
export const RATE_LIMIT_MAX = 60
export const RATE_LIMIT_WINDOW_SECONDS = 60

/** Cloudflare's authoritative client IP, with local-dev fallbacks. */
export function clientKey(request: Request): string {
  const direct = request.headers.get("cf-connecting-ip")
  if (direct) return direct
  const real = request.headers.get("x-real-ip")
  if (real) return real
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  return forwarded || "unknown"
}

export function rateLimitExceeded(): Response {
  return Response.json(
    {
      error: {
        code: "RATE_LIMITED",
        message: "Too many requests, please try again later.",
      },
    },
    {
      status: 429,
      headers: {
        "RateLimit-Limit": String(RATE_LIMIT_MAX),
        "RateLimit-Remaining": "0",
        "Retry-After": String(RATE_LIMIT_WINDOW_SECONDS),
      },
    },
  )
}

/**
 * Check the binding when one is configured. Returns a 429 response to send, or
 * undefined to continue. A missing binding (local tests, older deployments)
 * fails open: the endpoints are already token-gated.
 */
export async function enforceRateLimit(
  binding: RateLimitBinding | undefined,
  request: Request,
  scope: string,
): Promise<Response | undefined> {
  if (!binding) return undefined
  const { success } = await binding.limit({ key: `${scope}:${clientKey(request)}` })
  return success ? undefined : rateLimitExceeded()
}
