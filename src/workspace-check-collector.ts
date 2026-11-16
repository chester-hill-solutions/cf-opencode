import type { Env } from "./env"
import { bearerAuthorized } from "./control-auth"
import { CHECK_UUID, parseWorkspaceCheckCollectorClaimRequest, parseWorkspaceCheckExecution } from "./workspace-check-dispatch"
import { readWorkspaceCheckBytes } from "./conversation/workspace-checks"

export interface CheckCollectorOwner { conversationKey: string; collectorID: string; claimRequestID: string; imageID: string; claimedAt: number }
const KEY = /^[A-Za-z0-9:.\\_-]{1,256}$/
const IMAGE = /^sha256:[a-f0-9]{64}$/
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } })
export function checkCollectorConfig(env: Env): { collectorID: string; imageID: string; timeoutMs: number; platform: "linux/amd64" | "linux/arm64" } {
  const timeoutMs = Number(env.CHECK_RUNNER_TIMEOUT_MS ?? "120000")
  const platform = env.CHECK_RUNNER_PLATFORM ?? "linux/amd64"
  if (!env.CHECK_COLLECTOR_TOKEN || env.CHECK_COLLECTOR_TOKEN.length < 32 || /[\s\x00-\x1f\x7f]/.test(env.CHECK_COLLECTOR_TOKEN) || env.CHECK_COLLECTOR_TOKEN === env.API_TOKEN ||
    !env.CHECK_COLLECTOR_ID || !CHECK_UUID.test(env.CHECK_COLLECTOR_ID) || !env.CHECK_RUNNER_IMAGE_ID || !IMAGE.test(env.CHECK_RUNNER_IMAGE_ID) ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 || (platform !== "linux/amd64" && platform !== "linux/arm64")) throw new Error("Check collector is not configured")
  return { collectorID: env.CHECK_COLLECTOR_ID, imageID: env.CHECK_RUNNER_IMAGE_ID, timeoutMs, platform }
}
export function sameCheckCollectorOwner(left: CheckCollectorOwner, right: CheckCollectorOwner): boolean {
  return left.conversationKey === right.conversationKey && left.collectorID === right.collectorID && left.claimRequestID === right.claimRequestID && left.imageID === right.imageID
}
export function parseCheckCollectorOwner(value: unknown): CheckCollectorOwner {
  const body = value as Record<string, unknown>
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 5 || typeof body.conversationKey !== "string" || !KEY.test(body.conversationKey) ||
    !Number.isSafeInteger(body.claimedAt) || (body.claimedAt as number) < 0) throw new Error("Invalid collector owner")
  const claim = parseWorkspaceCheckCollectorClaimRequest({ collectorID: body.collectorID, claimRequestID: body.claimRequestID, imageID: body.imageID })
  return { conversationKey: body.conversationKey, ...claim, claimedAt: body.claimedAt as number }
}

/** Host-only HTTP authority: ordinary API authorization cannot reach actor completion. */
export async function handleCheckCollector(request: Request, env: Env): Promise<Response> {
  try {
    const config = checkCollectorConfig(env)
    if (!bearerAuthorized(request.headers.get("authorization") ?? "", env.CHECK_COLLECTOR_TOKEN!)) return json({ error: "unauthorized" }, 401)
    const url = new URL(request.url), settings = env.SETTINGS.getByName("global")
    const actor = (key: string, path: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers); headers.set("x-conversation-key", key)
      return env.CONVERSATION.getByName(key).fetch(`https://conversation/workspace/check-collector${path}`, { ...init, headers })
    }
    const ownerCall = (operation: string, body?: unknown) => settings.fetch(`https://settings/check-collector-owner${operation}`, {
      method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (url.pathname === "/api/check-collector/pending") {
      if (request.method !== "GET") return new Response("method not allowed", { status: 405, headers: { allow: "GET" } })
      const cursor = url.searchParams.get("cursor") ?? ""
      if (cursor && !KEY.test(cursor)) return json({ error: "invalid cursor" }, 400)
      const page = await settings.fetch(`https://settings/check-conversations?cursor=${encodeURIComponent(cursor)}`)
      if (!page.ok) return json({ error: "check discovery unavailable" }, 503)
      const { conversations, nextCursor } = await page.json() as { conversations: { key: string }[]; nextCursor: string | null }
      const pending: unknown[] = []
      for (const item of conversations) {
        const result = await actor(item.key, "/pending")
        // Do not silently hide an owned/queued actor if its state cannot be read.
        if (!result.ok) return json({ error: "check discovery unavailable" }, 503)
        pending.push(...(await result.json() as { pending: unknown[] }).pending)
      }
      const ownerResponse = await ownerCall("")
      if (!ownerResponse.ok) return json({ error: "check owner unavailable" }, 503)
      return json({ pending, nextCursor, owner: (await ownerResponse.json() as { owner: unknown }).owner })
    }
    const match = /^\/api\/check-collector\/conversations\/([^/]+)\/(claim|attempts\/([a-f0-9-]+)\/(source|freshness|complete|reconcile))$/.exec(url.pathname)
    if (!match) return json({ error: "not found" }, 404)
    let key: string
    try { key = decodeURIComponent(match[1]!) } catch { return json({ error: "invalid conversation key" }, 400) }
    if (!KEY.test(key)) return json({ error: "invalid conversation key" }, 400)
    if (match[2] === "claim") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } })
      const body = parseWorkspaceCheckCollectorClaimRequest(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await readWorkspaceCheckBytes(request.body, 2048))))
      if (body.collectorID !== config.collectorID) return json({ error: "collector mismatch" }, 403)
      const owner: CheckCollectorOwner = { ...body, conversationKey: key, claimedAt: Date.now() }
      if (body.imageID !== config.imageID) {
        const previous = await ownerCall("")
        if (!previous.ok) return json({ error: "check owner unavailable" }, 503)
        const stored = (await previous.json() as { owner: CheckCollectorOwner | null }).owner
        if (!stored || !sameCheckCollectorOwner(stored, owner)) return json({ error: "collector mismatch" }, 403)
      }
      const acquire = await ownerCall("/acquire", owner)
      if (!acquire.ok) return json({ error: "collector has an unresolved global owner", code: "CHECK_COLLECTOR_BUSY" }, acquire.status)
      // An ambiguous actor response retains the global owner; never infer no execution.
      const result = await actor(key, "/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      if (!result.ok) return result
      const ack = await result.json() as { claim: unknown }
      if (ack.claim === null) await ownerCall("/release", owner)
      return json(ack)
    }
    const operation = match[4]!, attemptID = match[3]!
    if (!CHECK_UUID.test(attemptID)) return json({ error: "invalid attempt" }, 400)
    if (operation === "source" || operation === "freshness") {
      if (request.method !== "GET") return new Response("method not allowed", { status: 405, headers: { allow: "GET" } })
      return actor(key, `/attempts/${attemptID}/${operation}`)
    }
    if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } })
    const body = await readWorkspaceCheckBytes(request.body, 200_000)
    const result = await actor(key, `/attempts/${attemptID}/${operation}`, { method: "POST", headers: { "content-type": "application/json" }, body: new Uint8Array(body) })
    if (!result.ok) return result
    const ack = await result.json() as { execution: unknown }
    const execution = parseWorkspaceCheckExecution(ack.execution)
    if (execution.attempt?.attemptID !== attemptID || execution.attempt.collectorID !== config.collectorID) return json({ error: "collector acknowledgement unavailable" }, 503)
    if (execution.receipt?.cleanupConfirmed || execution.cleanupReconciledAt !== null) {
      const current = await ownerCall("")
      if (!current.ok) return json({ error: "collector owner release is pending; retry the same completion" }, 503)
      const owner = (await current.json() as { owner: CheckCollectorOwner | null }).owner
      if (owner && owner.conversationKey === key && owner.collectorID === execution.attempt.collectorID && owner.claimRequestID === execution.attempt.claimRequestID) {
        const released = await ownerCall("/release", owner)
        if (!released.ok) return json({ error: "collector owner release is pending; retry the same completion" }, 503)
      }
    }
    return json({ execution })
  } catch {
    return json({ error: "Check collector operation is unavailable or invalid." }, 503)
  }
}
