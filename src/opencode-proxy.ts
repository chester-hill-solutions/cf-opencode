import type { ContainerPort } from "./opencode"

/**
 * Route OpenCode API calls through the control server.
 *
 * OpenCode listens on loopback with a per-start password. The Durable Object
 * must not hold that password, so the control server (which spawns OpenCode and
 * therefore owns the password) proxies `/opencode/*` and adds basic auth. The
 * control port wrapper separately adds the control bearer token.
 */
export function opencodeViaControl(control: ContainerPort): ContainerPort {
  return {
    fetch(input, init) {
      const request = new Request(input as any, init)
      const url = new URL(request.url)
      // Preserve any query string; only the path is namespaced.
      url.pathname = `/opencode${url.pathname}`
      return control.fetch(url.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: init?.signal,
      })
    },
  }
}
