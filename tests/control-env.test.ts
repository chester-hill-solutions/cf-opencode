import { describe, expect, test } from "bun:test"
import { buildOpencodeEnv } from "../control-server"
import { ACCOUNTING_POLICY_CONTENT } from "../src/accounting-policy"

describe("buildOpencodeEnv", () => {
  test("passes only the allowlisted environment to OpenCode", () => {
    const env = buildOpencodeEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/agent",
        LANG: "en_US.UTF-8",
        CONTROL_TOKEN: "control-secret",
        API_TOKEN: "api-secret",
        SLACK_BOT_TOKEN: "xoxb-secret",
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ experimental: { background_compaction: true } }),
      },
      "opencode-password",
    )

    expect(env.PATH).toBe("/usr/bin")
    expect(env.HOME).toBe("/home/agent")
    expect(env.LANG).toBe("en_US.UTF-8")
    expect(env.OPENCODE_PASSWORD).toBe("opencode-password")
    expect(env.OPENCODE_SERVER_PASSWORD).toBe("opencode-password")
    expect(env.OPENCODE_CONFIG_CONTENT).toBe(ACCOUNTING_POLICY_CONTENT)
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}")).toEqual({
      experimental: { background_compaction: false },
      agents: { title: { disabled: true } },
    })
    expect(env.OPENCODE_CONFIG_CONTENT).not.toContain('"background_compaction":true')
    expect(env.CONTROL_TOKEN).toBeUndefined()
    expect(env.API_TOKEN).toBeUndefined()
    expect(env.SLACK_BOT_TOKEN).toBeUndefined()
  })

  test("always supplies the runtime paths even when the source omits them", () => {
    const env = buildOpencodeEnv({}, "pw")
    expect(env.HOME).toBeTruthy()
    expect(env.XDG_DATA_HOME).toBeTruthy()
    expect(env.XDG_CONFIG_HOME).toBeTruthy()
    expect(env.XDG_CACHE_HOME).toBeTruthy()
    expect(env.S3_ENDPOINT).toContain("127.0.0.1")
  })
})
