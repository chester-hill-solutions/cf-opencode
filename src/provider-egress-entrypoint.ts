import { WorkerEntrypoint } from "cloudflare:workers"
import { proxyProviderRequest, type ProviderProxyScope } from "./provider-egress"

interface ProviderEgressEnvironment {
  PROVIDER_PROXY_API_KEY?: string
}

/** RPC entrypoint for conversation-scoped calls through the fixed provider route. */
export class ProviderEgress extends WorkerEntrypoint<ProviderEgressEnvironment, ProviderProxyScope> {
  protected upstream(request: Request): Promise<Response> {
    return fetch(request)
  }

  override async fetch(request: Request): Promise<Response> {
    return proxyProviderRequest(request, this.ctx.props, {
      credential: async () => this.env.PROVIDER_PROXY_API_KEY,
      fetch: (outbound) => this.upstream(outbound),
    })
  }
}
