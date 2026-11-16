import { expect, test } from "bun:test"
import { validateOpencodeKey, type OpencodeKeyValidation } from "../src/opencode-key-validation"

const key = "synthetic-provider-key-not-real"
test("issuer api_key_expired rejects the key even when local onboarding/catalogue could accept it", async () => {
  const result = await validateOpencodeKey(key, { fetcher: async () => Response.json({ error: { message: "api_key_expired: " + key } }, { status: 401 }) })
  expect(result).toEqual({ ok: false, status: 400, code: "OPENCODE_KEY_REJECTED", error: "OpenCode rejected this API key. Use an active OpenCode API key." })
  expect(JSON.stringify(result)).not.toContain(key)
  expect(JSON.stringify(result)).not.toContain("api_key_expired")
})

test("valid issuer catalogue is checked with only the exact key capability and no redirects", async () => {
  let calls = 0
  expect(await validateOpencodeKey(key, { fetcher: async request => {
    calls++
    expect(request.url).toBe("https://opencode.ai/inference/v1/models")
    expect(request.method).toBe("GET")
    expect(request.redirect).toBe("manual")
    expect(request.headers.get("authorization")).toBe("Bearer " + key)
    expect(await request.text()).toBe("")
    return Response.json({ object: "list", data: [{ id: "deepseek-v4.1-flash", object: "model" }] })
  } })).toEqual({ ok: true })
  expect(calls).toBe(1)
})

test("unavailable issuer, malformed catalogue and redirects never accept or disclose response content", async () => {
  for (const response of [new Response(key, { status: 503 }), new Response(key, { status: 302, headers: { location: "https://attacker.invalid" } }), new Response(key), Response.json({ data: [] }, { status: 201 }), Response.json({ ok: true }), Response.json({ data: [key] })]) {
    const result = await validateOpencodeKey(key, { fetcher: async () => response })
    expect(result).toEqual({ ok: false, status: 503, code: "OPENCODE_KEY_UNAVAILABLE", error: "OpenCode key validation is unavailable. Try again shortly." })
    expect(JSON.stringify(result)).not.toContain(key)
  }
})

test("uncooperative fetch and stalled response body have a complete bounded deadline", async () => {
  const unavailable: OpencodeKeyValidation = { ok: false, status: 503, code: "OPENCODE_KEY_UNAVAILABLE", error: "OpenCode key validation is unavailable. Try again shortly." }
  let cancelled = false
  for (const fetcher of [async () => await new Promise<Response>(() => {}), async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"data":[')) }, cancel() { cancelled = true } }))]) {
    const started = Date.now()
    expect(await validateOpencodeKey(key, { fetcher, timeoutMs: 25 })).toEqual(unavailable)
    expect(Date.now() - started).toBeLessThan(500)
  }
  expect(cancelled).toBe(true)
})

test("oversized issuer body, late uncooperative response and invalid key remain rejected", async () => {
  const large = await validateOpencodeKey(key, { fetcher: async () => new Response("x".repeat(1048577)) })
  expect(large.ok).toBe(false)
  let lateCancelled = false
  const late = validateOpencodeKey(key, { timeoutMs: 10, fetcher: async () => {
    await new Promise(resolve => setTimeout(resolve, 30))
    return new Response(new ReadableStream({ cancel() { lateCancelled = true } }))
  } })
  expect((await late).ok).toBe(false)
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(lateCancelled).toBe(true)
  for (const invalid of [null, "", "with\nnewline", "with space", "a".repeat(4097)]) {
    let calls = 0
    expect((await validateOpencodeKey(invalid, { fetcher: async () => { calls++; return Response.json({ data: [] }) } })).ok).toBe(false)
    expect(calls).toBe(0)
  }
})
