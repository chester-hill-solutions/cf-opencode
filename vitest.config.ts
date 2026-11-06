import { defineConfig } from "vitest/config"
import { cloudflareTest } from "@cloudflare/vitest-plugin"

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        bindings: {
          API_TOKEN: "test-token",
          SLACK_SIGNING_SECRET: "test-secret",
          SLACK_BOT_TOKEN: "xoxb-test",
          SLACK_BOT_USER_ID: "UBOT",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
})
