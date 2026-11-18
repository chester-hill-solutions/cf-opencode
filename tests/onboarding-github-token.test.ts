import { describe, expect, test } from "bun:test"
import { githubTokenRoute, onboardingRoute, type CredentialSettings } from "../src/onboarding-github-token"

const token = `gho_${"a".repeat(36)}`

function settings(fail = false) {
  const calls: Array<{ path: string; body?: unknown }> = []
  const env = {
    SETTINGS: {
      getByName: () => ({
        fetch: async (input: string, init?: RequestInit) => {
          calls.push({ path: new URL(input).pathname, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
          return fail ? Response.json({ error: "vault unavailable" }, { status: 503 }) : Response.json({ ok: true })
        },
      }),
    },
  } as unknown as CredentialSettings
  return { env, calls }
}

const user = (login = "wra-sol", status = 200) => (async () => Response.json({ login }, { status })) as unknown as typeof fetch

function post(body: unknown): Request {
  return new Request("https://worker/api/onboarding/github/token", { method: "POST", body: JSON.stringify(body) })
}

describe("github token onboarding", () => {
  test("verifies the token, stores it through the vault, and never echoes it", async () => {
    const { env, calls } = settings()
    const response = await githubTokenRoute(post({ token }), env, user())
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body).toEqual({ ok: true, login: "wra-sol", loginStored: true })
    expect(JSON.stringify(body)).not.toContain(token)
    expect(calls.map((call) => call.path)).toEqual(["/secrets/put", "/secrets/put", "/onboarding"])
    expect(calls[0]?.body).toEqual({ key: "github.token", value: token })
    expect(calls[1]?.body).toEqual({ key: "github.login", value: "wra-sol" })
    expect(calls[2]?.body).toMatchObject({ githubLogin: "wra-sol" })
  })

  test("refuses a token GitHub does not accept and stores nothing", async () => {
    const { env, calls } = settings()
    const response = await githubTokenRoute(post({ token }), env, user("", 401))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: "GITHUB_TOKEN_REJECTED" })
    expect(calls).toHaveLength(0)
  })

  test("refuses a malformed body, a wrong method and an unavailable vault", async () => {
    const { env } = settings()
    expect((await githubTokenRoute(post({ token: "not a token" }), env, user())).status).toBe(400)
    expect((await githubTokenRoute(new Request("https://worker/", { method: "GET" }), env, user())).status).toBe(405)
    const unavailable = settings(true)
    const response = await githubTokenRoute(post({ token }), unavailable.env, user())
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: "VAULT_UNAVAILABLE" })
  })

  test("routes the token path and delegates every other onboarding path", async () => {
    const { env } = settings()
    const delegated: string[] = []
    const fallback = async (request: Request) => { delegated.push(new URL(request.url).pathname); return Response.json({ ok: true }) }
    const parts = (path: string) => ["api", "onboarding", ...path.split("/")]
    await onboardingRoute({ request: post({ token }), env, url: new URL("https://worker/api/onboarding/github/token"), parts: parts("github/token"), fallback })
    await onboardingRoute({ request: new Request("https://worker/api/onboarding/status"), env, url: new URL("https://worker/api/onboarding/status"), parts: parts("status"), fallback })
    expect(delegated).toEqual(["/api/onboarding/status"])
  })
})
