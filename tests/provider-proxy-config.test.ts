import { describe, expect, test } from "bun:test"
import { Schema } from "../runtime/opencode/node_modules/effect/dist/index.js"
import * as OpenCodeConfig from "../runtime/opencode/node_modules/@opencode/schema/dist/config.js"
import { providerProxyConfig } from "../src/provider-proxy-config"

const token = `prx_${"a".repeat(64)}`

describe("providerProxyConfig", () => {
  test("builds a single OpenAI-compatible scoped proxy provider accepted by installed OpenCode schema", () => {
    const config = providerProxyConfig("gpt-4o-mini", token)

    expect(config).toEqual({
      model: "aboiteau-proxy/gpt-4o-mini",
      providers: {
        "aboiteau-proxy": {
          name: "Scoped provider proxy",
          package: "@opencode/ai/providers/openai-compatible",
          settings: {
            baseURL: "http://provider.aboiteau/v1",
            apiKey: token,
          },
          models: {
            "gpt-4o-mini": {
              name: "Scoped provider model",
              limit: { context: 4096, output: 1024 },
            },
          },
        },
      },
    })
    expect(() => Schema.decodeUnknownSync(OpenCodeConfig.Info)(config)).not.toThrow()
  })

  test("rejects model names that can escape the single model key", () => {
    for (const model of ["", "../other", "openai/gpt-4", "a".repeat(65), "bad model"]) {
      expect(() => providerProxyConfig(model, token)).toThrow("invalid provider proxy model name")
    }
  })

  test("accepts only the scoped proxy token shape", () => {
    for (const badToken of ["", "real-provider-key", `prx_${"A".repeat(64)}`, `prx_${"a".repeat(63)}`]) {
      expect(() => providerProxyConfig("model-1", badToken)).toThrow("invalid provider proxy token")
    }
  })
})
