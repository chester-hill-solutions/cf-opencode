import {
  PROVIDER_PROXY_HOST,
  PROVIDER_PROXY_ID,
} from "./provider-egress"

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const PROXY_TOKEN = /^prx_[0-9a-f]{64}$/

export interface ProviderProxyConfig {
  model: string
  providers: Record<string, {
    name: string
    package: string
    settings: { baseURL: string; apiKey: string }
    models: Record<string, {
      name: string
      limit: { context: number; output: number }
    }>
  }>
}

/** Build the single-provider OpenCode config for the scoped egress credential. */
export function providerProxyConfig(model: string, token: string): ProviderProxyConfig {
  if (!MODEL_NAME.test(model)) throw new TypeError("invalid provider proxy model name")
  if (!PROXY_TOKEN.test(token)) throw new TypeError("invalid provider proxy token")

  return {
    model: `${PROVIDER_PROXY_ID}/${model}`,
    providers: {
      [PROVIDER_PROXY_ID]: {
        name: "Scoped provider proxy",
        package: "@opencode/ai/providers/openai-compatible",
        settings: {
          baseURL: `http://${PROVIDER_PROXY_HOST}/v1`,
          apiKey: token,
        },
        models: {
          [model]: {
            name: "Scoped provider model",
            limit: { context: 4096, output: 1024 },
          },
        },
      },
    },
  }
}
