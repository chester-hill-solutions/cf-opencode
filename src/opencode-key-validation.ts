export type OpencodeKeyValidation = { ok: true } | { ok: false; status: 400 | 503; code: "OPENCODE_KEY_REJECTED" | "OPENCODE_KEY_UNAVAILABLE"; error: string }
export interface OpencodeKeyValidationOptions { fetcher?: (request: Request) => Promise<Response>; timeoutMs?: number }
const rejected = (): OpencodeKeyValidation => ({ ok: false, status: 400, code: "OPENCODE_KEY_REJECTED", error: "OpenCode rejected this API key. Use an active OpenCode API key." })
const unavailable = (): OpencodeKeyValidation => ({ ok: false, status: 503, code: "OPENCODE_KEY_UNAVAILABLE", error: "OpenCode key validation is unavailable. Try again shortly." })
function catalogue(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("data" in value) || !Array.isArray(value.data) || value.data.length > 2048) return false
  return value.data.every(item => item && typeof item === "object" && !Array.isArray(item) && typeof item.id === "string" && item.id.length > 0 && item.id.length <= 256)
}

/** Issuer authentication only: no inference, onboarding mutation, redirects or response diagnostics. */
export async function validateOpencodeKey(key: unknown, options: OpencodeKeyValidationOptions = {}): Promise<OpencodeKeyValidation> {
  if (typeof key !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(key)) return rejected()
  const controller = new AbortController(), cap = 1048576
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(5000, options.timeoutMs!)) : 5000
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined
  let reader: { cancel(reason?: unknown): Promise<void> } | undefined
  const operation = (async (): Promise<OpencodeKeyValidation> => {
    const request = new Request("https://opencode.ai/inference/v1/models", { method: "GET", redirect: "manual", signal: controller.signal, headers: { authorization: "Bearer " + key, accept: "application/json" } })
    const response = await (options.fetcher ?? (request => fetch(request)))(request)
    if (stopped || response.status !== 200) {
      void response.body?.cancel().catch(() => {})
      return !stopped && (response.status === 401 || response.status === 403) ? rejected() : unavailable()
    }
    const length = response.headers.get("content-length")
    if (!response.body || (length !== null && Number(length) > cap)) { void response.body?.cancel().catch(() => {}); return unavailable() }
    const bodyReader = response.body.getReader(); reader = bodyReader
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })
    let bytes = 0, text = ""
    for (;;) {
      const part = await bodyReader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (stopped || bytes > cap) return unavailable()
      text += decoder.decode(part.value, { stream: true })
    }
    return catalogue(JSON.parse(text + decoder.decode()) as unknown) ? { ok: true } : unavailable()
  })()
  try {
    return await Promise.race([operation, new Promise<OpencodeKeyValidation>(resolve => { timer = setTimeout(() => resolve(unavailable()), timeoutMs) })])
  } catch { return unavailable() }
  finally {
    stopped = true
    if (timer) clearTimeout(timer)
    controller.abort()
    try { void reader?.cancel().catch(() => {}) } catch {}
  }
}
