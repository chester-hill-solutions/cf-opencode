import { describe, expect, test } from "bun:test"
import {
  createProviderProxyGrant,
  PROVIDER_PROXY_HOST,
  PROVIDER_PROXY_PATH,
  PROVIDER_PROXY_TTL_MS,
  proxyProviderRequest,
  type ProviderProxyScope,
} from "../src/provider-egress"

const UPSTREAM = "https://api.openai.com/v1/chat/completions"
const URL = `http://${PROVIDER_PROXY_HOST}${PROVIDER_PROXY_PATH}`
const UPSTREAM_KEY = "sk-upstream-private"

async function grant(now = Date.now()) {
  return createProviderProxyGrant("conversation-1", "gpt-test", now)
}

function incoming(token: string, options: {
  url?: string
  method?: string
  body?: string | ReadableStream<Uint8Array> | null
  contentType?: string
  headers?: Record<string, string>
} = {}): Request {
  return new Request(options.url ?? URL, {
    method: options.method ?? "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": options.contentType ?? "application/json",
      accept: "text/event-stream",
      ...options.headers,
    },
    body: options.body ?? JSON.stringify({ model: "gpt-test", stream: true }),
  })
}

function ports(overrides: {
  credential?: () => Promise<string | undefined>
  fetch?: (request: Request) => Promise<Response>
  now?: () => number
} = {}) {
  let credentialCalls = 0
  let fetchCalls = 0
  let outgoing: Request | undefined
  return {
    value: {
      credential: overrides.credential ?? (async () => { credentialCalls++; return UPSTREAM_KEY }),
      fetch: overrides.fetch ?? (async (request: Request) => {
        fetchCalls++
        outgoing = request
        return new Response("ok", { status: 200, headers: {
          "content-type": "application/json",
          "x-upstream-secret": UPSTREAM_KEY,
          location: "https://private.example/",
        } })
      }),
      ...(overrides.now ? { now: overrides.now } : {}),
    },
    counts: () => ({ credentialCalls, fetchCalls }),
    outgoing: () => outgoing,
  }
}

describe("provider egress grant", () => {
  test("issues random proxy bearer and a scoped expiring hash", async () => {
    const first = await grant(1_000_000)
    const second = await grant(1_000_000)
    expect(first.token).toMatch(/^prx_[0-9a-f]{64}$/)
    expect(first.token).not.toBe(second.token)
    expect(first.scope).toMatchObject({
      version: 1,
      conversationID: "conversation-1",
      model: "gpt-test",
      expiresAt: 1_000_000 + PROVIDER_PROXY_TTL_MS,
    })
    expect(first.scope.tokenSHA256).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("provider egress proxy", () => {
  test("sends only the bounded, model-scoped request to the fixed upstream", async () => {
    const { scope, token } = await grant()
    const body = JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hello" }], stream: true })
    const spy = ports()
    const response = await proxyProviderRequest(incoming(token, {
      body,
      contentType: "application/json; charset=utf-8",
      headers: { cookie: "cookie-secret", "x-private": "must-not-forward", accept: "text/html" },
    }), scope, spy.value)
    const outgoing = spy.outgoing()!
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("ok")
    expect(outgoing.url).toBe(UPSTREAM)
    expect(outgoing.method).toBe("POST")
    expect(outgoing.redirect).toBe("manual")
    expect(outgoing.headers.get("authorization")).toBe(`Bearer ${UPSTREAM_KEY}`)
    expect(outgoing.headers.get("content-type")).toBe("application/json")
    expect(outgoing.headers.get("accept")).toBe("text/event-stream")
    expect(outgoing.headers.has("cookie")).toBe(false)
    expect(outgoing.headers.has("x-private")).toBe(false)
    expect(outgoing.headers.has("host")).toBe(false)
    expect(await outgoing.text()).toBe(body)
    expect([...response.headers.keys()].sort()).toEqual(["cache-control", "content-type"])
    expect(response.headers.has("x-upstream-secret")).toBe(false)
    expect(response.headers.has("location")).toBe(false)
  })

  test("rejects invalid grants, expiry, bearer, host, and model before secret lookup", async () => {
    const { scope, token } = await grant()
    const cases: Array<{ request: Request; scope?: ProviderProxyScope; now?: number; status: number }> = [
      { request: incoming(token), scope: { ...scope, version: 2 as 1 }, status: 403 },
      { request: incoming(token), scope, now: scope.expiresAt, status: 403 },
      { request: incoming("prx_" + "0".repeat(64)), scope, status: 401 },
      { request: incoming(token, { url: `http://wrong.${PROVIDER_PROXY_HOST}${PROVIDER_PROXY_PATH}` }), scope, status: 404 },
      { request: incoming(token, { url: `http://user:pass@${PROVIDER_PROXY_HOST}${PROVIDER_PROXY_PATH}` }), scope, status: 404 },
      { request: incoming(token, { url: `http://${PROVIDER_PROXY_HOST}:8080${PROVIDER_PROXY_PATH}` }), scope, status: 404 },
      { request: incoming(token, { url: `${URL}?extra=1` }), scope, status: 404 },
      { request: incoming(token, { url: `${URL}#fragment` }), scope, status: 404 },
      { request: incoming(token, { headers: { host: "wrong.example" } }), scope, status: 404 },
      { request: incoming(token, { body: JSON.stringify({ model: "gpt-other" }) }), scope, status: 403 },
    ]
    for (const item of cases) {
      const spy = ports({ now: () => item.now ?? scope.expiresAt - 1 })
      const response = await proxyProviderRequest(item.request, item.scope ?? scope, spy.value)
      expect(response.status).toBe(item.status)
      expect(spy.counts()).toEqual({ credentialCalls: 0, fetchCalls: 0 })
    }
  })

  test("rejects non-POST, non-JSON, invalid JSON, and arrays without contacting credentials", async () => {
    const { scope, token } = await grant()
    const cases: Array<{ request: Request; status: number }> = [
      { request: incoming(token, { method: "GET", body: null }), status: 405 },
      { request: incoming(token, { contentType: "text/plain" }), status: 415 },
      { request: incoming(token, { body: "{" }), status: 400 },
      { request: incoming(token, { body: "[]" }), status: 400 },
      { request: incoming(token, { body: JSON.stringify({ model: "gpt-test", stream: "true" }) }), status: 400 },
    ]
    for (const item of cases) {
      const spy = ports()
      expect((await proxyProviderRequest(item.request, scope, spy.value)).status).toBe(item.status)
      expect(spy.counts()).toEqual({ credentialCalls: 0, fetchCalls: 0 })
    }
  })

  test("canonicalizes duplicate JSON model keys and normalizes charset before forwarding", async () => {
    const { scope, token } = await grant()
    const spy = ports()
    const response = await proxyProviderRequest(incoming(token, {
      body: '{"model":"gpt-expensive","model":"gpt-test"}',
      contentType: "application/json; charset=utf-8",
      headers: { accept: "text/html" },
    }), scope, spy.value)
    const forwardedBody = await spy.outgoing()!.text()
    const forwarded = JSON.parse(forwardedBody) as Record<string, unknown>
    expect(response.status).toBe(200)
    expect(forwarded).toEqual({ model: "gpt-test" })
    expect(forwardedBody).toBe('{"model":"gpt-test"}')
    expect(spy.outgoing()!.headers.get("content-type")).toBe("application/json")
    expect(spy.outgoing()!.headers.get("accept")).toBe("application/json")
  })

  test("bounds streamed request bodies and cancels an oversized stream", async () => {
    const { scope, token } = await grant()
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)) },
      cancel() { cancelled = true },
    })
    const request = incoming(token, { body: stream })
    const spy = ports()
    const response = await proxyProviderRequest(request, scope, spy.value)
    expect(response.status).toBe(413)
    expect(cancelled).toBe(true)
    expect(spy.counts()).toEqual({ credentialCalls: 0, fetchCalls: 0 })
  })

  test("rechecks expiry after waiting for the request body", async () => {
    const { scope, token } = await grant()
    let releaseBody!: () => void
    const bodyGate = new Promise<void>((resolve) => { releaseBody = resolve })
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        await bodyGate
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ model: "gpt-test" })))
        controller.close()
      },
    })
    let now = scope.expiresAt - 1
    const spy = ports({ now: () => now })
    const pending = proxyProviderRequest(incoming(token, { body: stream }), scope, spy.value)
    now = scope.expiresAt
    releaseBody()
    expect((await pending).status).toBe(403)
    expect(spy.counts()).toEqual({ credentialCalls: 0, fetchCalls: 0 })
  })

  test("does not follow redirects or reflect upstream error bodies and headers", async () => {
    const { scope, token } = await grant()
    let redirects = 0
    let redirectBodyCancelled = false
    const redirectSpy = ports({ fetch: async (request) => {
      redirects++
      expect(request.redirect).toBe("manual")
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("secret upstream auth detail")) },
        cancel() { redirectBodyCancelled = true },
      })
      return new Response(body, {
        status: 302,
        headers: { location: "https://attacker.example/?key=secret" },
      })
    } })
    const redirect = await proxyProviderRequest(incoming(token), scope, redirectSpy.value)
    const body = await redirect.text()
    expect(redirects).toBe(1)
    expect(redirectBodyCancelled).toBe(true)
    expect(redirect.status).toBe(502)
    expect(body).not.toContain("secret")
    expect(redirect.headers.has("location")).toBe(false)

    const rateLimitSpy = ports({ fetch: async () => new Response("private detail", { status: 429 }) })
    const rateLimit = await proxyProviderRequest(incoming(token), scope, rateLimitSpy.value)
    expect(rateLimit.status).toBe(429)
    expect(await rateLimit.text()).not.toContain("private")
  })

  test("returns incremental SSE chunks and propagates client cancellation", async () => {
    const { scope, token } = await grant()
    let releaseSecond!: () => void
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve })
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\n"))
        await secondGate
        controller.enqueue(new TextEncoder().encode("data: second\n\n"))
        controller.close()
      },
      cancel() { cancelled = true },
    })
    const spy = ports({ fetch: async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }) })
    const response = await proxyProviderRequest(incoming(token), scope, spy.value)
    const reader = response.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toBe("data: first\n\n")
    await reader.cancel()
    releaseSecond()
    await Promise.resolve()
    expect(cancelled).toBe(true)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("content-type")).toBe("text/event-stream")
  })

  test("keeps credential and fetch failures generic", async () => {
    const { scope, token } = await grant()
    const missing = ports({ credential: async () => undefined })
    const missingResponse = await proxyProviderRequest(incoming(token), scope, missing.value)
    expect(missingResponse.status).toBe(503)
    expect(await missingResponse.text()).not.toContain(UPSTREAM_KEY)
    expect(missing.counts().fetchCalls).toBe(0)

    const failed = ports({ fetch: async () => { throw new Error(UPSTREAM_KEY) } })
    const failedResponse = await proxyProviderRequest(incoming(token), scope, failed.value)
    expect(failedResponse.status).toBe(503)
    expect(await failedResponse.text()).not.toContain(UPSTREAM_KEY)
  })

  test("rejects malformed upstream credentials without exposing them", async () => {
    const { scope, token } = await grant()
    for (const credential of ["secret with spaces", "secret\nwith-newline", "clé-non-ascii", "x".repeat(4097)]) {
      let fetchCalls = 0
      const spy = ports({
        credential: async () => credential,
        fetch: async () => { fetchCalls++; return new Response("unexpected") },
      })
      const response = await proxyProviderRequest(incoming(token), scope, spy.value)
      const body = await response.text()
      expect(response.status).toBe(503)
      expect(body).not.toContain(credential)
      expect(fetchCalls).toBe(0)
    }
  })
})
