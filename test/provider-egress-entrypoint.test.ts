import { afterEach, describe, expect, it, vi } from "vitest"
import { exports as entrypoints } from "cloudflare:workers"
import { createProviderProxyGrant, PROVIDER_PROXY_HOST, PROVIDER_PROXY_PATH } from "../src/provider-egress"

const model = "r1-7a-probe"
function request(token: string) {
  return new Request(`http://${PROVIDER_PROXY_HOST}${PROVIDER_PROXY_PATH}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", cookie: "untrusted-cookie" },
    body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: "synthetic probe" }] }),
  })
}

afterEach(() => vi.unstubAllGlobals())

describe("provider egress Worker entrypoint", () => {
  it("uses trusted binding props and injects the Worker-only credential", async () => {
    const grant = await createProviderProxyGrant("owner-a", model)
    const upstream = vi.fn(async (outbound: Request) => {
      expect(outbound.url).toBe("https://api.openai.com/v1/chat/completions")
      expect(outbound.redirect).toBe("manual")
      expect(outbound.headers.get("authorization")).toBe("Bearer R1_7A_UPSTREAM_TEST_ONLY")
      expect(outbound.headers.has("cookie")).toBe(false)
      expect(await outbound.json()).toMatchObject({ model, stream: false })
      return Response.json({ choices: [{ message: { content: "synthetic success" } }] }, {
        headers: { authorization: "must-not-leak", "set-cookie": "must-not-leak" },
      })
    })
    vi.stubGlobal("fetch", upstream)
    const binding = entrypoints.ProviderEgress({ props: grant.scope })
    const response = await binding.fetch(request(grant.token))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: "synthetic success" } }] })
    expect(response.headers.has("authorization")).toBe(false)
    expect(response.headers.has("set-cookie")).toBe(false)
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it("rejects a token from another binding and an expired capability without upstream work", async () => {
    const first = await createProviderProxyGrant("owner-a", model)
    const second = await createProviderProxyGrant("owner-b", model)
    const upstream = vi.fn(async () => { throw new Error("unexpected network access") })
    vi.stubGlobal("fetch", upstream)
    expect((await entrypoints.ProviderEgress({ props: second.scope }).fetch(request(first.token))).status).toBe(401)
    expect((await entrypoints.ProviderEgress({ props: { ...first.scope, expiresAt: Date.now() - 1 } }).fetch(request(first.token))).status).toBe(403)
    expect(upstream).not.toHaveBeenCalled()
  })
})
