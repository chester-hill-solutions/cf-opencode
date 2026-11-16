export interface WorkspaceAPITarget { url: URL; token: string }
export type WorkspaceFetcher = (request: Request) => Promise<Response>

/** A credential-free origin/key is validated before any authenticated request. */
export function workspaceAPITarget(origin: string | undefined, key: string | undefined, token: string | undefined): WorkspaceAPITarget {
  if (!origin || !/^https?:\/\/[^/?#\s]+\/?$/i.test(origin) || !key || !/^[A-Za-z0-9:._-]{1,256}$/.test(key) || [".", ".."].includes(key)) throw new Error("Invalid API target")
  const url = new URL(origin)
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Invalid API target")
  if (!token || !/^[\x21-\x7e]{1,4096}$/.test(token)) throw new Error("Invalid API authentication")
  url.pathname = `/api/conversations/${encodeURIComponent(key)}/workspace/`
  return { url, token }
}

/** Bounds transport and complete body consumption, even if abort is ignored. */
export async function workspaceAPIRequest(target: WorkspaceAPITarget, path: string, options: {
  method?: "GET" | "POST" | "PUT"
  body?: unknown
  fetcher?: WorkspaceFetcher
  maxBytes?: number
  timeoutMs?: number
} = {}): Promise<{ status: number; value: unknown }> {
  const controller = new AbortController(), url = new URL(target.url)
  url.pathname += path
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(30000, options.timeoutMs!)) : 10000
  const maxBytes = Math.max(1, Math.min(8 * 1024 * 1024, options.maxBytes ?? 16384))
  let timer: ReturnType<typeof setTimeout> | undefined, closeBody: (() => void) | undefined, stopped = false
  const operation = (async () => {
    const request = new Request(url.toString(), { method: options.method ?? "GET", redirect: "error", signal: controller.signal,
      headers: { authorization: "Bearer " + target.token, accept: "application/json", ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
    const response = await (options.fetcher ?? fetch)(request)
    if (stopped || !response.ok) {
      void response.body?.cancel().catch(() => {})
      if (stopped) throw new Error("API deadline")
      return { status: response.status, value: null }
    }
    if (!response.body) throw new Error("Missing API body")
    const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true })
    closeBody = () => { void reader.cancel().then(() => reader.releaseLock()).catch(() => {}) }
    let bytes = 0, output = ""
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) throw new Error("API body limit")
      output += decoder.decode(chunk.value, { stream: true })
    }
    return { status: response.status, value: JSON.parse(output + decoder.decode()) as unknown }
  })()
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("API deadline")), timeoutMs) })])
  } finally {
    stopped = true
    if (timer) clearTimeout(timer)
    controller.abort(); closeBody?.()
  }
}
