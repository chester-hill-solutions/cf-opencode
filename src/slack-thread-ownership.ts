/**
 * Canary thread ownership: which app owns a brand-new thread in the canary
 * channel. Claim is first-writer-wins and idempotent for the same thread; a
 * different thread is a separate key, so this never grows into a table scan.
 */

interface OwnershipStorage {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
}

type ThreadRequest = { action: "claim" | "lookup"; channel: string; threadTs: string }

export async function canaryThreadRoute(storage: OwnershipStorage, request: Request): Promise<Response> {
  const body = parseThreadRequest(await request.json().catch(() => undefined))
  if (!body) return Response.json({ error: "invalid thread ownership" }, { status: 400 })
  const key = `slackCanaryThread:${body.channel}:${body.threadTs}`
  const stored = await storage.get<unknown>(key)
  if (stored !== undefined) {
    return validRow(stored, body) ? Response.json({ owned: true }) : Response.json({ error: "thread ownership unavailable" }, { status: 503 })
  }
  if (body.action === "claim") await storage.put(key, { channel: body.channel, threadTs: body.threadTs, claimedAt: Date.now() })
  return Response.json({ owned: body.action === "claim" })
}

function parseThreadRequest(body: unknown): ThreadRequest | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined
  const input = body as Record<string, unknown>
  if (Object.keys(input).length !== 3) return undefined
  if (!isAction(input.action) || !isChannel(input.channel) || !isThreadTs(input.threadTs)) return undefined
  return { action: input.action, channel: input.channel, threadTs: input.threadTs }
}

function isAction(value: unknown): value is ThreadRequest["action"] {
  return value === "claim" || value === "lookup"
}

function isChannel(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z0-9]{1,64}$/.test(value)
}

function isThreadTs(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,20}\.\d{1,20}$/.test(value)
}

function validRow(row: unknown, body: ThreadRequest): boolean {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false
  const stored = row as Record<string, unknown>
  return Object.keys(stored).sort().join(",") === "channel,claimedAt,threadTs" &&
    stored.channel === body.channel && stored.threadTs === body.threadTs &&
    Number.isSafeInteger(stored.claimedAt) && (stored.claimedAt as number) >= 0
}
