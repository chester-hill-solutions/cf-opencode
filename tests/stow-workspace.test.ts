import { describe, expect, test } from "bun:test"
import {
  parseWorkspaceIdentity,
  parseWorkspaceReadiness,
  WorkspaceContractError,
  type WorkspaceIdentity,
} from "../stow-workspace"

const expected = {
  root: "/workspace",
  registryDir: "/var/lib/aboiteau/state/stow/registry",
  bucket: "aboiteau-workspace",
}

const identityValue = {
  version: 1,
  workspace_id: "ws_01HZX8ABCD",
  root: expected.root,
  working_directory: ".",
  registry_dir: expected.registryDir,
  bucket: expected.bucket,
} as const

const readinessValue = {
  ...identityValue,
  working_directory: expected.root,
  endpoint: "http://127.0.0.1:9000/",
  region: "local",
  access_key_id: "local_access",
  secret_access_key: "local_secret",
}

describe("Stow workspace identity contract", () => {
  test("accepts the v1 identity and canonicalizes working directory dot", () => {
    expect(parseWorkspaceIdentity(identityValue, expected)).toEqual({
      ...identityValue,
      working_directory: expected.root,
    })
  })

  test.each([
    ["wrong schema", { ...identityValue, version: 2 }],
    ["invalid workspace ID", { ...identityValue, workspace_id: "../bad" }],
    ["wrong root", { ...identityValue, root: "/tmp/other" }],
    ["noncanonical root", { ...identityValue, root: "/workspace/.." }],
    ["wrong registry", { ...identityValue, registry_dir: "/tmp/registry" }],
    ["wrong bucket", { ...identityValue, bucket: "other" }],
    ["wrong working directory", { ...identityValue, working_directory: "/workspace/subdir" }],
  ])("rejects %s without exposing payload values", (_name, value) => {
    try {
      parseWorkspaceIdentity(value, expected)
      throw new Error("expected rejection")
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceContractError)
      expect((error as Error).message).toBe("invalid workspace identity")
      expect((error as Error).message).not.toContain(JSON.stringify(value))
    }
  })
})

describe("Stow workspace readiness contract", () => {
  const identity = parseWorkspaceIdentity(identityValue, expected)

  test("accepts verified loopback credentials but returns only selected fields", () => {
    const parsed = parseWorkspaceReadiness(readinessValue, identity)
    expect(parsed).toEqual({
      ...identity,
      endpoint: "http://127.0.0.1:9000/",
      region: "local",
      access_key_id: "local_access",
      secret_access_key: "local_secret",
    })
    expect(Object.keys(parsed).sort()).toEqual([
      "access_key_id", "bucket", "endpoint", "region", "registry_dir", "root",
      "secret_access_key", "version", "working_directory", "workspace_id",
    ].sort())
    expect(Object.isFrozen(parsed)).toBe(true)
  })

  test("accepts bracketed IPv6 loopback with an explicit port", () => {
    expect(parseWorkspaceReadiness({ ...readinessValue, endpoint: "http://[::1]:9000" }, identity).endpoint)
      .toBe("http://[::1]:9000")
  })

  test.each([
    ["wrong identity", { ...readinessValue, workspace_id: "other" }],
    ["non-loopback host", { ...readinessValue, endpoint: "http://192.0.2.1:9000/" }],
    ["hostname alias", { ...readinessValue, endpoint: "http://localhost:9000/" }],
    ["missing port", { ...readinessValue, endpoint: "http://127.0.0.1/" }],
    ["invalid port", { ...readinessValue, endpoint: "http://127.0.0.1:70000/" }],
    ["URL userinfo", { ...readinessValue, endpoint: "http://u:p@127.0.0.1:9000/" }],
    ["query string", { ...readinessValue, endpoint: "http://127.0.0.1:9000/?x=1" }],
    ["other path", { ...readinessValue, endpoint: "http://127.0.0.1:9000/other" }],
    ["empty region", { ...readinessValue, region: "" }],
    ["empty access key", { ...readinessValue, access_key_id: "" }],
    ["control in secret", { ...readinessValue, secret_access_key: "secret\nvalue" }],
  ])("rejects %s without returning readiness payload", (_name, value) => {
    try {
      parseWorkspaceReadiness(value, identity)
      throw new Error("expected rejection")
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceContractError)
      expect((error as Error).message).toBe("invalid workspace readiness")
      expect((error as Error).message).not.toContain("secret")
    }
  })

  test("does not mutate the supplied durable identity", () => {
    const source = Object.freeze({ ...identityValue })
    const parsed = parseWorkspaceIdentity(source, expected)
    expect(source.working_directory).toBe(".")
    expect(parsed.working_directory).toBe(expected.root)
    expect((parsed as WorkspaceIdentity & { access_key_id?: string }).access_key_id).toBeUndefined()
  })
})
