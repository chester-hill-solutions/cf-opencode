import { constantTimeEqual } from "./control-auth"

export const PROVIDER_PROXY_HOST = "provider.aboiteau"
export const PROVIDER_PROXY_PATH = "/v1/chat/completions"
export const PROVIDER_PROXY_ID = "aboiteau-proxy"
export const PROVIDER_PROXY_TTL_MS = 900_000

const PROVIDER_API_URL = "https://api.openai.com/v1/chat/completions"
const MAX_BODY_BYTES = 1024 * 1024
const TOKEN_PREFIX = "prx_"

export interface ProviderProxyScope {
  version: 1
  conversationID: string
  model: string
  tokenSHA256: string
  expiresAt: number
}

export interface ProviderProxyPorts {
  credential(): Promise<string | undefined>
  fetch(request: Request): Promise<Response>
  now?(): number
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return hex(new Uint8Array(digest))
}

export async function createProviderProxyGrant(
  conversationID: string,
  model: string,
  now = Date.now(),
): Promise<{ scope: ProviderProxyScope; token: string }> {
  if (!conversationID || !model || !Number.isFinite(now)) throw new Error("invalid provider proxy grant scope")
  const random = crypto.getRandomValues(new Uint8Array(32))
  const token = TOKEN_PREFIX + hex(random)
  return {
    token,
    scope: {
      version: 1,
      conversationID,
      model,
      tokenSHA256: await sha256(token),
      expiresAt: now + PROVIDER_PROXY_TTL_MS,
    },
  }
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, {
    status,
    headers: { "cache-control": "no-store" },
  })
}

function validScope(scope: ProviderProxyScope, now: number): boolean {
  return !!scope && scope.version === 1 && typeof scope.conversationID === "string" && scope.conversationID.length > 0 &&
    typeof scope.model === "string" && scope.model.length > 0 && /^[0-9a-f]{64}$/.test(scope.tokenSHA256) &&
    Number.isFinite(scope.expiresAt) && now < scope.expiresAt
}

async function readBoundedBody(request: Request): Promise<Uint8Array | Response> {
  if (!request.body) return jsonError(400, "invalid request body")
  const contentLength = request.headers.get("content-length")
  if (contentLength !== null && Number.isFinite(Number(contentLength)) && Number(contentLength) > MAX_BODY_BYTES) {
    await request.body.cancel().catch(() => {})
    return jsonError(413, "request body too large")
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {})
        return jsonError(413, "request body too large")
      }
      chunks.push(value)
    }
  } catch {
    await reader.cancel().catch(() => {})
    return jsonError(400, "invalid request body")
  } finally {
    reader.releaseLock()
  }

  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function exactProxyURL(request: Request): boolean {
  try {
    const url = new URL(request.url)
    if (url.href !== `http://${PROVIDER_PROXY_HOST}${PROVIDER_PROXY_PATH}` ||
      url.username || url.password || url.search || url.hash || url.port) return false
    const host = request.headers.get("host")
    return host === null || host.toLowerCase() === PROVIDER_PROXY_HOST
  } catch {
    return false
  }
}

function authorizedToken(header: string | null): string | undefined {
  if (!header?.startsWith("Bearer ")) return undefined
  const token = header.slice("Bearer ".length)
  if (!/^prx_[0-9a-f]{64}$/.test(token)) return undefined
  return token
}

/** Validate a conversation-scoped grant, then proxy one fixed OpenAI request. */
export async function proxyProviderRequest(
  request: Request,
  scope: ProviderProxyScope,
  ports: ProviderProxyPorts,
): Promise<Response> {
  const now = ports.now?.() ?? Date.now()
  if (!validScope(scope, now)) return jsonError(403, "provider proxy grant expired or invalid")
  if (!exactProxyURL(request)) return jsonError(404, "provider proxy endpoint not found")
  if (request.method !== "POST") return jsonError(405, "method not allowed")

  const contentType = request.headers.get("content-type")
  if (!contentType || contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return jsonError(415, "content type must be application/json")
  }

  const token = authorizedToken(request.headers.get("authorization"))
  if (!token || !constantTimeEqual(await sha256(token), scope.tokenSHA256)) {
    return jsonError(401, "invalid provider proxy authorization")
  }

  const body = await readBoundedBody(request)
  if (body instanceof Response) return body
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body))
  } catch {
    return jsonError(400, "invalid JSON request body")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return jsonError(400, "request body must be a JSON object")
  }
  const payload = parsed as Record<string, unknown>
  if (payload.model !== scope.model) {
    return jsonError(403, "model is outside provider proxy scope")
  }
  if (payload.stream !== undefined && typeof payload.stream !== "boolean") {
    return jsonError(400, "stream must be a boolean")
  }
  if (!validScope(scope, ports.now?.() ?? Date.now())) {
    return jsonError(403, "provider proxy grant expired or invalid")
  }

  let credential: string | undefined
  try {
    credential = await ports.credential()
  } catch {
    return jsonError(503, "provider unavailable")
  }
  if (!credential || !/^[\x21-\x7e]{1,4096}$/.test(credential)) return jsonError(503, "provider unavailable")

  let outbound: Request
  try {
    const headers = new Headers({
      "content-type": "application/json",
      authorization: `Bearer ${credential}`,
      accept: payload.stream === true ? "text/event-stream" : "application/json",
    })
    outbound = new Request(PROVIDER_API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      redirect: "manual",
      signal: request.signal,
    })
  } catch {
    return jsonError(503, "provider unavailable")
  }

  let upstream: Response
  try {
    upstream = await ports.fetch(outbound)
  } catch {
    return jsonError(503, "provider unavailable")
  }

  if (upstream.status >= 200 && upstream.status < 300) {
    const responseHeaders = new Headers({ "cache-control": "no-store" })
    const responseType = upstream.headers.get("content-type")
    if (responseType !== null) responseHeaders.set("content-type", responseType)
    return new Response(upstream.status === 204 || upstream.status === 205 ? null : upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    })
  }

  await upstream.body?.cancel().catch(() => {})
  return jsonError(upstream.status === 429 ? 429 : 502, "provider unavailable")
}
