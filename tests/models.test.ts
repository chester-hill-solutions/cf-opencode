import { describe, expect, test } from "bun:test"
import { MODEL_CATALOG, findModel, groupByProvider, recommendModel } from "../src/models"

describe("model catalogue", () => {
  test("references are unique", () => {
    const refs = MODEL_CATALOG.map((model) => model.ref)
    expect(new Set(refs).size).toBe(refs.length)
  })

  test("recommends a tool-capable default", () => {
    const model = recommendModel()
    expect(model.ref).toBe("opencode/deepseek-v4.1-flash")
    expect(model.tags).toContain("tools")
  })

  test("groups by provider", () => {
    const groups = groupByProvider()
    expect(groups.opencode?.length).toBeGreaterThan(0)
    expect(groups.openai?.length).toBeGreaterThan(0)
  })

  test("finds a model by reference", () => {
    expect(findModel("opencode/deepseek-v4-pro")?.name).toContain("Pro")
    expect(findModel("nope/nope")).toBeUndefined()
  })
})
