import { describe, expect, test } from "bun:test"
import { LIFECYCLE_TEST_ENTRY, normalizeLifecycleTestBoundary } from "../scripts/config-test-boundary"

const runtime = { name: "CONVERSATION", class_name: "Conversation" }
const exportShape = { type: "durable-object", storage: "sqlite" }
const production = {
  main: "src/index.ts",
  durable_objects: { bindings: [runtime] },
  exports: { Conversation: exportShape },
}
const fixture = {
  ...production,
  main: LIFECYCLE_TEST_ENTRY,
  durable_objects: { bindings: [runtime, { name: "LIFECYCLE_PROBE", class_name: "LifecycleProbe" }] },
  exports: { Conversation: exportShape, LifecycleProbe: exportShape },
}
const wrapper = [
  'export { default } from "../../src/index"',
  'export { Conversation } from "../../src/conversation"',
  'export { Settings } from "../../src/settings-do"',
  'export { LifecycleProbe } from "./lifecycle-host"',
].join("\n")

describe("test-only Lifecycle config boundary", () => {
  test("normalizes only the exact local test bridge", () => {
    const result = normalizeLifecycleTestBoundary(production, fixture, wrapper)
    expect(result.problems).toEqual([])
    expect(result.config).toEqual(production)
    expect(fixture.durable_objects.bindings).toHaveLength(2)
  })

  test("rejects additional wrapper code and production probe exposure", () => {
    expect(normalizeLifecycleTestBoundary(production, fixture, wrapper + "\nconsole.log('extra')").problems).not.toEqual([])
    expect(normalizeLifecycleTestBoundary({ ...fixture, main: "src/index.ts" }, fixture, wrapper).problems).toContain(
      "LifecycleProbe must never be exported or bound in production",
    )
  })

  test("rejects remote or non-SQLite probe configuration", () => {
    const remote = {
      ...fixture,
      durable_objects: { bindings: [runtime, { name: "LIFECYCLE_PROBE", class_name: "LifecycleProbe", script_name: "other" }] },
      exports: { ...fixture.exports, LifecycleProbe: { type: "durable-object", storage: "kv" } },
    }
    expect(normalizeLifecycleTestBoundary(production, remote, wrapper).problems).toHaveLength(2)
  })

  test("leaves unrelated runtime drift visible to existing comparisons", () => {
    const changed = { ...fixture, durable_objects: { bindings: [{ name: "CONVERSATION", class_name: "Wrong" }, fixture.durable_objects.bindings[1]!] } }
    const result = normalizeLifecycleTestBoundary(production, changed, wrapper)
    expect(result.config.durable_objects?.bindings).not.toEqual(production.durable_objects.bindings)
    const unknown = { ...fixture, exports: { ...fixture.exports, UnapprovedProbe: exportShape } }
    expect(normalizeLifecycleTestBoundary(production, unknown, wrapper).config.exports).toHaveProperty("UnapprovedProbe")
  })
})
