import { describe, expect, test } from "bun:test"
import { runtimePaths, serverOptions, type RuntimeEnvironment } from "./options.ts"

const base: RuntimeEnvironment = {
  HOME: "/var/lib/aboiteau/state",
  XDG_DATA_HOME: "/var/lib/aboiteau/state/data",
  XDG_CONFIG_HOME: "/var/lib/aboiteau/state/config",
  XDG_CACHE_HOME: "/var/lib/aboiteau/state/cache",
  XDG_STATE_HOME: "/var/lib/aboiteau/state/state",
  TMPDIR: "/tmp/evented-test",
  OPENCODE_PASSWORD: "synthetic-test-password",
  OPENCODE_PORT: "4000",
}

describe("evented runtime options", () => {
  test("requires explicit absolute HOME and XDG paths confined to the trusted home", () => {
    expect(() => runtimePaths({ ...base, HOME: undefined })).toThrow()
    expect(() => runtimePaths({ ...base, XDG_DATA_HOME: "relative" })).toThrow()
    expect(() => runtimePaths({ ...base, XDG_CONFIG_HOME: "/tmp/untrusted-config" })).toThrow()
  })

  test("keeps standard OpenCode data, config and cache locations under HOME", () => {
    const paths = runtimePaths(base)
    expect(paths.data).toBe("/var/lib/aboiteau/state/data/opencode")
    expect(paths.config).toBe("/var/lib/aboiteau/state/config/opencode")
    expect(paths.cache).toBe("/var/lib/aboiteau/state/cache/opencode")
    expect(paths.state).toBe("/var/lib/aboiteau/state/state/opencode")
    expect(paths.tmp).toBe("/tmp/evented-test/opencode")
  })

  test("fixes events to persistent and limits the listener to loopback", () => {
    const paths = runtimePaths(base)
    const options = serverOptions(base, paths, "2.2.5")
    expect(options.hostname).toBe("127.0.0.1")
    expect(options.port).toBe(4000)
    expect(options.events).toEqual({ persist: true })
    expect(options.database).toEqual({ path: "/var/lib/aboiteau/state/data/opencode/opencode.db" })
    expect(options.config?.content).toBeUndefined()
  })

  test("preserves CLI environment options while rejecting an escaping database path", () => {
    const env = {
      ...base,
      OPENCODE_CONFIG_CONTENT: '{"model":"openai/gpt-4.1"}',
      OPENCODE_MODELS_URL: "https://models.example.test/catalog.json",
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_CONFIG_PROJECT_DISABLE: "1",
      OPENCODE_FILEWATCHER_DISABLE: "true",
      OPENCODE_DB: "alternate.db",
    }
    const options = serverOptions(env, runtimePaths(env), "2.2.5")
    expect(options.config?.content).toBe(env.OPENCODE_CONFIG_CONTENT)
    expect(options.models?.url).toBe(env.OPENCODE_MODELS_URL)
    expect(options.models?.fetch).toBe(false)
    expect(options.config?.project).toBe(false)
    expect(options.fs?.filewatcher).toBe(false)
    expect(options.database?.path).toBe("/var/lib/aboiteau/state/data/opencode/alternate.db")
    expect(() => serverOptions({ ...base, OPENCODE_DB: "/tmp/escaped.db" }, runtimePaths(base), "2.2.5")).toThrow()
  })

  test("requires a consistent password and valid loopback port", () => {
    expect(() => serverOptions({ ...base, OPENCODE_PASSWORD: undefined }, runtimePaths(base), "2.2.5")).toThrow()
    expect(() => serverOptions({ ...base, OPENCODE_SERVER_PASSWORD: "different" }, runtimePaths(base), "2.2.5")).toThrow()
    expect(() => serverOptions({ ...base, OPENCODE_PORT: "0" }, runtimePaths(base), "2.2.5")).toThrow()
  })
})
