import { describe, expect, test } from "bun:test"
import { loadActiveConsoleCredential, selectActiveConsoleCredential } from "./operator-credential"

const now = Date.parse("2026-11-15T15:00:00Z")
function active() {
  return { id: "credential-active-device", integrationID: "opencode", label: "Console workspace", active: true, value: {
    type: "oauth", methodID: "device", access: "fake-oauth-access.token", refresh: "fake-refresh-do-not-return", expires: now + 7 * 24 * 60 * 60_000,
    metadata: { server: "https://opencode.ai/console", orgID: "org_fake_chs", orgName: "Chester Hill Solutions", email: "fake@example.invalid", accountID: "fake-account" },
  } }
}
function exported() {
  return [{ id: "legacy-key", integrationID: "opencode", active: false, value: { type: "key", key: "fake-inactive-api-key" } },
    { ...active(), id: "inactive-device", active: false }, active()]
}

describe("active Console credential selection", () => {
  test("selects the explicit active device session and returns no refresh or legacy key", () => {
    const result = selectActiveConsoleCredential(exported(), now)
    expect(result).toEqual({ token: "fake-oauth-access.token", orgID: "org_fake_chs", expiresAt: now + 7 * 24 * 60 * 60_000, credentialID: "credential-active-device", workspace: "Chester Hill Solutions" })
    expect(Object.keys(result).sort()).toEqual(["credentialID", "expiresAt", "orgID", "token", "workspace"])
    expect(JSON.stringify(result)).not.toContain("fake-refresh"); expect(JSON.stringify(result)).not.toContain("fake-inactive-api-key")
  })

  test("refuses inactive legacy entries, active keys, ambiguous active sessions and wrong integration", () => {
    for (const input of [exported().filter(row => !row.active), [{ ...active(), value: { type: "key", key: "fake-key" } }],
      [active(), { ...active(), id: "another-active" }], [{ ...active(), integrationID: "other-provider" }],
      [active(), { ...active(), id: "active-other-org", value: { ...active().value, metadata: { ...active().value.metadata, orgName: "Other Org" } } }],
      null, {}, { credentials: [active()] }, [null],
    ]) expect(() => selectActiveConsoleCredential(input, now)).toThrow()
  })

  test("enforces expiry headroom in milliseconds without refreshing", () => {
    for (const expires of [now - 1, now + 45 * 60_000, Math.floor(now / 1000), NaN, Infinity, "future", undefined]) {
      expect(() => selectActiveConsoleCredential([{ ...active(), value: { ...active().value, expires } }], now)).toThrow()
    }
    expect(selectActiveConsoleCredential([{ ...active(), value: { ...active().value, expires: now + 45 * 60_000 + 1 } }], now).expiresAt).toBe(now + 45 * 60_000 + 1)
    expect(() => selectActiveConsoleCredential([active()], NaN)).toThrow()
  })

  test("rejects wrong auth method, server, workspace and unsafe header values", () => {
    for (const value of [
      { ...active().value, methodID: "browser" }, { ...active().value, access: "Bearer fake-token" },
      { ...active().value, access: "fake\r\nx-injected: true" }, { ...active().value, access: "" },
      { ...active().value, access: " fake-token" }, { ...active().value, access: "fake token" },
      { ...active().value, metadata: { ...active().value.metadata, server: "https://other.invalid/console" } },
      { ...active().value, metadata: { ...active().value.metadata, server: "https://opencode.ai/console/" } },
      { ...active().value, metadata: { ...active().value.metadata, orgName: "ChesterHillSolutions" } },
      { ...active().value, metadata: { ...active().value.metadata, orgID: "org\r\nx-org: other" } },
      { ...active().value, metadata: { ...active().value.metadata, orgID: "" } },
    ]) expect(() => selectActiveConsoleCredential([{ ...active(), value }], now)).toThrow()
  })
})

describe("non-inference credential verification", () => {
  test("uses only the active bearer and organization on the two fixed GET endpoints", async () => {
    const requests: Array<{ url: string; method: string | undefined; redirect: RequestInit["redirect"]; auth: string | null; org: string | null }> = []
    const selected = await loadActiveConsoleCredential({ now: () => now, exportCredentials: async () => exported(), fetch: async (input, init) => {
      requests.push({ url: String(input), method: init?.method, redirect: init?.redirect, auth: new Headers(init?.headers).get("authorization"), org: new Headers(init?.headers).get("x-org-id") })
      expect(init?.body).toBeUndefined(); expect(init?.signal).toBeDefined()
      return Response.json(requests.length === 1 ? {} : { object: "list", data: [{ id: "deepseek-v4.1-flash" }] })
    } })
    expect(selected.token).toBe("fake-oauth-access.token")
    expect(requests).toEqual([
      { url: "https://opencode.ai/console/api/v2/config", method: "GET", redirect: "manual", auth: "Bearer fake-oauth-access.token", org: "org_fake_chs" },
      { url: "https://opencode.ai/inference/v1/models", method: "GET", redirect: "manual", auth: "Bearer fake-oauth-access.token", org: "org_fake_chs" },
    ])
  })

  test("does not fall back or expose upstream/export errors", async () => {
    let requests = 0
    await expect(loadActiveConsoleCredential({ now: () => now, exportCredentials: async () => exported(), fetch: async () => {
      requests++; return new Response("fake-secret-echo", { status: 401 })
    } })).rejects.toThrow("no credential fallback")
    expect(requests).toBe(1)
    await expect(loadActiveConsoleCredential({ exportCredentials: async () => { throw new Error("fake-refresh-echo") } })).rejects.toThrow("credential export unavailable")
  })

  test("rejects redirect, malformed JSON and a recognized catalogue missing the selected model", async () => {
    for (const rejected of [new Response(null, { status: 302, headers: { location: "https://never-follow.invalid" } }), new Response("not-json"), Response.json({ data: [{ id: "other-model" }] })]) {
      let count = 0
      await expect(loadActiveConsoleCredential({ now: () => now, exportCredentials: async () => exported(), fetch: async () => ++count === 1 ? Response.json({}) : rejected })).rejects.toThrow("session verification failed")
    }
  })

  test("rechecks expiry after verification and does not guess unfamiliar model-catalogue formats", async () => {
    let checks = 0
    const selected = await loadActiveConsoleCredential({ now: () => now, exportCredentials: async () => exported(), fetch: async () => Response.json({ models: "unfamiliar format" }) })
    expect(selected.workspace).toBe("Chester Hill Solutions")
    await expect(loadActiveConsoleCredential({ now: () => ++checks === 1 ? now : now + 7 * 24 * 60 * 60_000, exportCredentials: async () => exported(), fetch: async () => Response.json({}) })).rejects.toThrow("45 minutes")
  })
})
