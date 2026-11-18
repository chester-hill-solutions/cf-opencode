/**
 * Store a GitHub credential from an operator-supplied token.
 *
 * The OAuth app is the normal path, but a token minted by `gh auth token` is
 * already scoped to the operator's account and avoids a browser round trip on
 * a headless deployment. The token is verified against GitHub before it is
 * stored, written through the vault (so it replaces any pre-v2 record), and
 * never logged or returned.
 */
import { GITHUB_LOGIN_KEY, GITHUB_TOKEN_KEY } from "./vault"

/** Only the Settings Durable Object is needed; no Worker-wide coupling. */
export interface CredentialSettings {
  SETTINGS: { getByName(name: string): { fetch(input: string, init?: RequestInit): Promise<Response> } }
}

const GITHUB_USER_URL = "https://api.github.com/user"
const TOKEN = /^[A-Za-z0-9_]{20,255}$/

const rejected = () => Response.json({ error: "GitHub rejected the token", code: "GITHUB_TOKEN_REJECTED" }, { status: 400 })

/** The token from the request body, or the refusal that explains why not. */
async function requestToken(request: Request): Promise<string | Response> {
  const body = await request.json().catch(() => undefined) as { token?: unknown } | undefined
  const token = typeof body?.token === "string" ? body.token.trim() : ""
  return TOKEN.test(token) ? token : Response.json({ error: "a GitHub token is required", code: "INVALID_GITHUB_TOKEN" }, { status: 400 })
}

/** The token's account login, or undefined when GitHub refuses it. */
async function verifiedLogin(token: string, fetcher: typeof fetch): Promise<string | undefined> {
  const response = await fetcher(GITHUB_USER_URL, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "aboiteau" },
    signal: AbortSignal.timeout(15_000),
    redirect: "manual",
  })
  const user = await response.json().catch(() => undefined) as { login?: unknown } | undefined
  await response.body?.cancel().catch(() => {})
  return response.ok && user && typeof user.login === "string" ? user.login : undefined
}

async function storeCredential(env: CredentialSettings, token: string, login: string): Promise<Response> {
  const settings = env.SETTINGS.getByName("global")
  const put = (path: string, body: unknown) => settings.fetch(`https://settings${path}`, { method: "POST", body: JSON.stringify(body) })
  const stored = await put("/secrets/put", { key: GITHUB_TOKEN_KEY, value: token })
  if (!stored.ok) {
    return Response.json({ error: "the credential could not be stored", code: "VAULT_UNAVAILABLE" }, { status: 503 })
  }
  const loginStored = await put("/secrets/put", { key: GITHUB_LOGIN_KEY, value: login })
  await put("/onboarding", { githubConnectedAt: Date.now(), githubLogin: login })
  return Response.json({ ok: true, login, loginStored: loginStored.ok })
}

export async function githubTokenRoute(request: Request, env: CredentialSettings, fetcher: typeof fetch = fetch): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405, headers: { allow: "POST" } })
  }
  const token = await requestToken(request)
  if (token instanceof Response) return token
  const login = await verifiedLogin(token, fetcher)
  return login === undefined ? rejected() : storeCredential(env, token, login)
}

export interface OnboardingRouteInput<E extends CredentialSettings> {
  request: Request
  env: E
  url: URL
  parts: string[]
  fallback: (request: Request, env: E, url: URL, parts: string[]) => Promise<Response>
}

/** The onboarding router: the token route, otherwise the existing handler. */
export function onboardingRoute<E extends CredentialSettings>(input: OnboardingRouteInput<E>): Promise<Response> {
  if (input.parts[2] === "github" && input.parts[3] === "token") return githubTokenRoute(input.request, input.env)
  return input.fallback(input.request, input.env, input.url, input.parts)
}
