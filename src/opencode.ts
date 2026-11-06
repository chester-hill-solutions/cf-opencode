import { OpenCode } from "@opencode/client"

/**
 * The container's HTTP server, reached through the Durable Object's container
 * port. No public URL, no service discovery — just a fetch adapter.
 */
export type PortFetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>

export interface ContainerPort {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>
}

/** OpenCode v2 requires HTTP Basic auth on its local server. */
export function basicAuth(password: string): string {
  return `Basic ${btoa(`opencode:${password}`)}`
}

export function makeClient(portFetch: PortFetch, password?: string) {
  return OpenCode.make({
    baseUrl: "http://container",
    fetch: portFetch as typeof fetch,
    ...(password ? { headers: { authorization: basicAuth(password) } } : {}),
  })
}

/** Rewrite requests to the container's local HTTP server. */
export function portFetch(port: ContainerPort): PortFetch {
  return (input, init) => {
    const request = new Request(input as any, init)
    const url = new URL(request.url)
    url.protocol = "http:"
    url.host = "container"
    const forwarded = new Request(url.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: init?.signal ?? AbortSignal.timeout(60_000),
    })
    forwarded.headers.delete("host")
    return port.fetch(forwarded)
  }
}
