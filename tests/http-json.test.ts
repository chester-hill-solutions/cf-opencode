import { describe, expect, test } from "bun:test"
import { parseObjectJson } from "../src/http-json"

describe("public object JSON parsing", () => {
  test("accepts objects and rejects malformed, null, and array bodies", async () => {
    expect(await parseObjectJson(new Request("https://test", { method: "POST", body: '{"x":1}' })))
      .toEqual({ ok: true, value: { x: 1 } })
    for (const [body, error] of [["{", "invalid json"], ["null", "body must be an object"], ["[]", "body must be an object"]] as const) {
      const parsed = await parseObjectJson(new Request("https://test", { method: "POST", body }))
      expect(parsed).toEqual({ ok: false, error })
    }
  })
})
