/** Copied into the isolated 15a916a release checkout; called only after real Slack HMAC validation. */
export interface SlackCanaryRouterBindings {
  SLACK_CANARY_CHANNEL?: string
  SLACK_CANARY_SIGNING_SECRET?: string
  SLACK_CANARY_ORIGIN?: string
  SLACK_CANARY?: { fetch(request: Request): Promise<Response> }
}
const TS = /^[0-9]{1,16}\.[0-9]{1,16}$/
function object(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined }
function candidate(path: string, body: string): { channel: string; threadTs?: string } | undefined {
  try {
    if (path === "/slack/events") {
      const event = object(object(JSON.parse(body))?.event)
      if (typeof event?.channel !== "string") return undefined
      const ts = event.thread_ts ?? event.ts
      return { channel: event.channel, ...(typeof ts === "string" && TS.test(ts) ? { threadTs: ts } : {}) }
    }
    if (path === "/slack/interactivity") {
      const raw = new URLSearchParams(body).get("payload"), payload = raw ? object(JSON.parse(raw)) : undefined
      const channel = object(payload?.channel)?.id
      if (typeof channel !== "string") return undefined
      const message = object(payload?.message), direct = message?.thread_ts
      if (typeof direct === "string" && TS.test(direct)) return { channel, threadTs: direct }
      const actions = payload?.actions, action = Array.isArray(actions) ? object(actions[0]) : undefined
      if (typeof action?.value === "string" && action.value.length <= 4096) {
        const key = object(JSON.parse(action.value))?.key
        if (typeof key === "string" && key.startsWith(channel + ":") && TS.test(key.slice(channel.length + 1))) return { channel, threadTs: key.slice(channel.length + 1) }
      }
      return { channel }
    }
  } catch {}
  return undefined
}
async function signature(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`))
  return "v0=" + Array.from(new Uint8Array(mac), byte => byte.toString(16).padStart(2, "0")).join("")
}
async function boundedRequest(service: NonNullable<SlackCanaryRouterBindings["SLACK_CANARY"]>, request: Request, timeoutMs: number, json: boolean): Promise<{ status: number; value?: unknown; text?: string; contentType?: string }> {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined, reader: { cancel(reason?: unknown): Promise<void> } | undefined
  const controller = new AbortController()
  const operation = (async () => {
    const response = await service.fetch(new Request(request, { signal: controller.signal }))
    if (stopped || response.status !== 200) { void response.body?.cancel().catch(() => {}); return { status: response.status } }
    if (!response.body) throw new Error("Missing route proof")
    const bodyReader = response.body.getReader(); reader = bodyReader
    let bytes = 0, text = ""
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })
    for (;;) {
      const part = await bodyReader.read(); if (part.done) break
      bytes += part.value.byteLength; if (bytes > (json ? 1024 : 8192)) throw new Error("Route proof limit")
      text += decoder.decode(part.value, { stream: true })
    }
    text += decoder.decode()
    return json ? { status: response.status, value: JSON.parse(text) as unknown } : { status: response.status, text, contentType: response.headers.get("content-type") ?? "text/plain" }
  })()
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Canary deadline")), timeoutMs) })]) }
  finally { stopped = true; if (timer) clearTimeout(timer); controller.abort(); try { void reader?.cancel().catch(() => {}) } catch {} }
}

/** Undefined means unchanged legacy dispatch. A route/proof/forwarding failure never falls back. */
export async function routeSlackCanary(request: Request, body: string, env: SlackCanaryRouterBindings): Promise<Response | undefined> {
  const path = new URL(request.url).pathname, target = candidate(path, body)
  if (!env.SLACK_CANARY_CHANNEL || target?.channel !== env.SLACK_CANARY_CHANNEL) return undefined
  try {
    if (!env.SLACK_CANARY || !env.SLACK_CANARY_SIGNING_SECRET || env.SLACK_CANARY_SIGNING_SECRET.length < 32 || body.length > 262144 || !env.SLACK_CANARY_ORIGIN) throw new Error("Canary unavailable")
    const origin = new URL(env.SLACK_CANARY_ORIGIN)
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Canary origin invalid")
    const timestamp = String(Math.floor(Date.now() / 1000)), headers = new Headers({ "content-type": path === "/slack/events" ? "application/json" : "application/x-www-form-urlencoded", "x-slack-request-timestamp": timestamp, "x-slack-signature": await signature(env.SLACK_CANARY_SIGNING_SECRET, timestamp, body) })
    for (const name of ["x-slack-retry-num", "x-slack-retry-reason"]) { const value = request.headers.get(name); if (value && value.length <= 128) headers.set(name, value) }
    const make = (pathname: string, search = "") => new Request(new URL(pathname + search, origin).toString(), { method: "POST", headers, body, redirect: "manual" })
    const proof = await boundedRequest(env.SLACK_CANARY, make("/slack/canary-route", "?kind=" + (path === "/slack/events" ? "events" : "interactivity")), 1200, true)
    const value = object(proof.value)
    if (proof.status !== 200 || !value || Object.keys(value).sort().join(",") !== "channel,route,threadTs" || !["canary", "legacy"].includes(String(value.route))) throw new Error("Canary proof unavailable")
    if (value.route === "legacy") {
      if (!((value.channel === null && value.threadTs === null) || (value.channel === target.channel && typeof value.threadTs === "string" && TS.test(value.threadTs) && (!target.threadTs || value.threadTs === target.threadTs)))) throw new Error("Legacy proof mismatch")
      return undefined
    }
    if (value.channel !== target.channel || !target.threadTs || value.threadTs !== target.threadTs) throw new Error("Canary proof mismatch")
    const forwarded = await boundedRequest(env.SLACK_CANARY, make(path), 1200, false)
    if (forwarded.status !== 200) throw new Error("Canary dispatch unavailable")
    return new Response(forwarded.text ?? "ok", { headers: { "content-type": forwarded.contentType?.startsWith("application/json") ? "application/json" : "text/plain" } })
  } catch { return new Response("canary routing unavailable", { status: 503 }) }
}
