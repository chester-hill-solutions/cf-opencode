import { describe, expect, test } from "bun:test"
import { buildOpencodeEnv, buildStowEnv } from "../control-server"
import { ACCOUNTING_POLICY_CONTENT } from "../src/accounting-policy"
import type { WorkspaceReadiness } from "../stow-workspace"

const readiness: WorkspaceReadiness = {
  version: 1,
  workspace_id: "ws_test_01",
  root: "/workspace",
  working_directory: "/workspace",
  registry_dir: "/var/lib/aboiteau/state/stow/registry",
  bucket: "aboiteau-workspace",
  endpoint: "http://127.0.0.1:45678/",
  region: "local-test-region",
  access_key_id: "synthetic-access-id",
  secret_access_key: "synthetic-secret-key",
}

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
      readiness,
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
    expect(env.S3_ENDPOINT).toBe(readiness.endpoint)
    expect(env.S3_REGION).toBe(readiness.region)
    expect(env.S3_BUCKET).toBe(readiness.bucket)
    expect(env.S3_ACCESS_KEY_ID).toBe(readiness.access_key_id)
    expect(env.S3_SECRET_ACCESS_KEY).toBe(readiness.secret_access_key)
  })

  test("always supplies the runtime paths even when the source omits them", () => {
    const env = buildOpencodeEnv({}, "pw", readiness)
    expect(env.HOME).toBeTruthy()
    expect(env.XDG_DATA_HOME).toBeTruthy()
    expect(env.XDG_CONFIG_HOME).toBeTruthy()
    expect(env.XDG_CACHE_HOME).toBeTruthy()
    expect(env.S3_ENDPOINT).toBe(readiness.endpoint)
  })

  test("refuses to start OpenCode without validated native workspace readiness", () => {
    expect(() => buildOpencodeEnv({}, "pw", undefined)).toThrow("validated native workspace readiness is required")
  })

  test("gives native Stow only its curated runtime environment", () => {
    const env = buildStowEnv({
      PATH: "/bin",
      HOME: "/state",
      CONTROL_TOKEN: "control-secret",
      OPENCODE_PASSWORD: "opencode-secret",
      API_TOKEN: "provider-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      LANG: "en_CA.UTF-8",
    })
    expect(env.PATH).toBe("/bin")
    expect(env.HOME).toBe("/state")
    expect(env.LANG).toBe("en_CA.UTF-8")
    expect(env.CONTROL_TOKEN).toBeUndefined()
    expect(env.OPENCODE_PASSWORD).toBeUndefined()
    expect(env.API_TOKEN).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(Object.keys(env).sort()).toEqual([
      "HOME", "PATH", "WORKSPACE", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "LANG",
    ].sort())
  })
})
